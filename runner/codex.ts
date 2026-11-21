import { createServer, type IncomingMessage } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { effectiveFor, type NativeOverride } from './harnesses.js';
import type { AgentProfile } from './config.js';
import { finishArgs, type EventSink } from './contest.js';
import { submissionSchema, statusSchema, type match } from './match.js';
import { protocol } from './protocol.js';
import { z } from 'zod';

type Codex = Extract<AgentProfile, { harness: 'codex' }>;
type Endpoint = ReturnType<typeof socketServer> | ReturnType<typeof createServer>;
async function listen(server: Endpoint, path: string) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  await chmod(path, 0o666);
}
export async function codexConfig(dir: string, profile: Codex, native?: NativeOverride) {
  await writeFile(join(dir, 'config.toml'), effectiveFor(profile, native).content, { mode: 0o444 });
}
async function requestBody(req: IncomingMessage) {
  const buffers: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 48_000_000) throw new Error('Model request too large');
    buffers.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(buffers).toString());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected JSON object');
  return parsed as Record<string, unknown>;
}
export function checkModelRequest(body: Record<string, unknown>, model: string) {
  if (body.model !== model || body.previous_response_id || body.conversation || body.background || body.prompt || body.include && !Array.isArray(body.include)) throw new Error('Unsupported model request');
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.some(tool => !tool || !['function', 'custom', 'namespace'].includes(tool.type))) throw new Error('Remote tools are not allowed: ' + (Array.isArray(tools) ? tools.map(t => t?.type).filter(t => typeof t === 'string' && /^[a-z_]{1,30}$/.test(t)).join(',') : 'invalid list'));
  for (const tool of tools) if (tool.type === 'namespace' && (!Array.isArray(tool.tools) || tool.tools.some((inner: {type?: string}) => !inner || !['function', 'custom'].includes(inner.type ?? '')))) throw new Error('Remote tools are not allowed in namespaces');
  const inspect = (obj: unknown, depth = 0) => {
    if (depth > 30) throw new Error('Request nesting exceeds limit');
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (['file_url', 'file_id'].includes(key) || (key === 'image_url' && (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(value)))) throw new Error('Remote files are not allowed');
      inspect(value, depth + 1);
    }
  };
  inspect(body.input);
  return { ...body, store: false };
}
export async function serveContestChannels(opts: { dir: string; profile: Codex; key: string; signal: AbortSignal;
  native?: NativeOverride; contest: Pick<ReturnType<typeof match>, 'submit' | 'status' | 'close'>; event: EventSink; finish: () => void; fault: (reason: string) => void }) {
  const { dir, profile, key, signal, contest, event } = opts;
  await mkdir(dir, { mode: 0o755 });
  const stop = new AbortController();
  const current = AbortSignal.any([stop.signal, signal]);
  let calls = 0;
  let finished = false;
  let inFlight = false;
  let peers = 0;
  const connections = new Set<import('node:net').Socket>();
  const track = (socket: import('node:net').Socket) => { connections.add(socket); socket.once('close', () => connections.delete(socket)); };
  const relay = createServer((req, res) => {
    const reject = (status: number, message: string) => { if (res.headersSent) res.destroy(); else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message } })); };
    if (req.method !== 'POST' || req.url !== '/v1/responses') { reject(404, 'Unsupported model endpoint'); return; }
    if (finished || current.aborted || inFlight) { reject(429, 'Model request already in flight or run closed'); return; }
    if (calls >= protocol.maxTurns) { opts.fault('turn_limit'); reject(429, 'Run model request limit reached'); return; }
    inFlight = true;
    void (async () => {
      let body: ReturnType<typeof checkModelRequest>;
      try { body = checkModelRequest(await requestBody(req), profile.model); }
      catch (error) { event({ type: 'model_request_rejected', reason: error instanceof Error && !(error instanceof SyntaxError) ? error.message : 'Invalid JSON' }); opts.fault('invalid_model_request'); reject(400, 'Disallowed request'); return; }
      // Codex may omit native verbosity for models absent from its catalog.
      // Apply the explicitly configured value to the approved Responses request.
      const verbosity = opts.native?.model_verbosity;
      if (verbosity) {
        const text = (body as Record<string, unknown>).text;
        Object.assign(body, { text: { ...(text && typeof text === 'object' && !Array.isArray(text) ? text : {}), verbosity } });
      }
      const turn = ++calls;
      event({ type: 'model_request', turn, model: profile.model, reasoning: (body as Record<string, unknown>).reasoning ?? null });
      const disconnected = new AbortController();
      res.once('close', () => { if (!res.writableFinished) disconnected.abort(); });
      const requestSignal = AbortSignal.any([current, disconnected.signal, AbortSignal.timeout(protocol.requestTimeoutMs)]);
      try {
        const upstream = await fetch(profile.base_url.replace(/\/+$/, '') + '/responses', {
          method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: requestSignal,
        });
        const type = upstream.headers.get('content-type') ?? 'application/json';
        event({ type: 'model_response', turn, status: upstream.status, request_id: upstream.headers.get('x-request-id') });
        if (!upstream.ok || !upstream.body) {
          void upstream.body?.cancel().catch(() => {});
          opts.fault('model_request_failed'); reject(502, 'Upstream model request failed'); return;
        }
        res.writeHead(200, { 'content-type': type });
        // Preserve the streaming wire protocol; retain only identity and usage metadata.
        const reader = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        const decoder = new TextDecoder(); let line = ''; let observed = false;
        const observe = (text: string) => {
          try {
            const record = JSON.parse(text) as Record<string, unknown>;
            const value = (record.response ?? record) as Record<string, unknown>;
            if (!observed && typeof value.model === 'string' && typeof value.id === 'string') {
              observed = true;
              event({ type: 'model_identity', turn, model: value.model, response_id: value.id });
            }
            if (typeof value.model === 'string' && value.model !== profile.model && /^gpt-.*-\d{4}-\d{2}-\d{2}$/.test(profile.model)) opts.fault('unexpected_model');
            if (value.usage && (record.type === 'response.completed' || record.object === 'response')) event({ type: 'model_usage', turn, usage: value.usage });
            if (['response.failed', 'error'].includes(String(record.type))) opts.fault('model_request_failed');
          } catch { /* non-data SSE line */ }
        };
        if (type.includes('text/event-stream')) reader.on('data', (chunk: Buffer) => {
          line += decoder.decode(chunk, { stream: true });
          const lines = line.split('\n'); line = lines.pop() ?? '';
          if (line.length > 1_000_000) line = '';
          for (const l of lines) if (l.startsWith('data: ')) observe(l.slice(6));
        });
        else { reader.on('data', (chunk: Buffer) => { if (line.length <= 1_000_000) line += decoder.decode(chunk, { stream: true }); }); reader.once('end', () => observe(line)); }
        await pipeline(reader, res, { signal: requestSignal });
      } catch { if (!current.aborted) opts.fault('model_request_failed'); reject(502, 'Upstream transport failed'); }
    })().finally(() => { inFlight = false; }).catch(() => res.destroy());
  });
  relay.on('connection', track);
  const mcp = socketServer(socket => {
    track(socket);
    if (peers >= 4 || current.aborted) { socket.destroy(); return; }
    peers++;
    const server = new McpServer({ name: 'contestreplay-contest', version: '0.2.0' });
    const reply = (value: Record<string, unknown>) => ({ structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
    const sap = z.object({ problem_id: z.string().max(128), answer: z.string().max(4096).optional(),
      language: z.string().max(128).optional(), source: z.string().max(200_000).optional() });
    server.registerTool('submit', { description: 'Submit answer, or language and complete source code for a programming problem.', inputSchema: sap }, args => {
      const p = submissionSchema.safeParse(args);
      return reply(p.success ? contest.submit(p.data) : { verdict: 'invalid_submission' });
    });
    server.registerTool('status', { description: 'Read submission verdict or contest summary.', inputSchema: statusSchema }, ({ submission_id }) => reply(contest.status(submission_id)));
    server.registerTool('finish', { description: 'Close submissions and end the contest.', inputSchema: finishArgs }, () => {
      finished = true; contest.close(); opts.finish(); return reply({ status: 'finished' });
    });
    socket.once('close', () => { peers--; void server.close().catch(() => {}); });
    socket.on('error', () => {});
    void server.connect(new StdioServerTransport(socket, socket, { maxBufferSize: 1_500_000 })).catch(() => socket.destroy());
  });
  const close = async () => {
    stop.abort();
    for (const connection of connections) connection.destroy();
    await Promise.all([relay, mcp].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  };
  try { await listen(relay, join(dir, 'model.sock')); await listen(mcp, join(dir, 'mcp.sock')); }
  catch (error) { await close(); throw error; }
  return close;
}
