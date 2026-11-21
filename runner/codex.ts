import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
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
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'authorization', 'x-api-key', 'api-key',
  'cookie', 'forwarded',
]);

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
async function rawRequestBody(req: IncomingMessage) {
  const buffers: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 48_000_000) throw new Error('Model request too large');
    buffers.push(chunk as Buffer);
  }
  return Buffer.concat(buffers);
}
export function resolveRelayTarget(baseUrl: string, reqUrl: string) {
  if (!reqUrl || !reqUrl.startsWith('/') || reqUrl.startsWith('//') || reqUrl.includes('\0') || reqUrl.includes('\\')) {
    throw new Error('Invalid relay path');
  }
  let parsed: URL;
  try { parsed = new URL(reqUrl, 'http://relay.local'); }
  catch { throw new Error('Invalid relay path'); }
  if (parsed.origin !== 'http://relay.local') throw new Error('Invalid relay path');
  const rawPath = reqUrl.split(/[?#]/)[0] ?? '';
  const hasUnsafeSegment = (pathname: string) => pathname.split('/').some(seg => {
    if (seg === '.' || seg === '..') return true;
    try {
      const decoded = decodeURIComponent(seg);
      return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0');
    } catch { return true; }
  });
  if (hasUnsafeSegment(rawPath) || hasUnsafeSegment(parsed.pathname)) throw new Error('Path traversal is not allowed');
  const subpath = parsed.pathname === '/v1' ? '' : parsed.pathname.startsWith('/v1/') ? parsed.pathname.slice(3) : parsed.pathname;
  const base = new URL(baseUrl.replace(/\/+$/, ''));
  const basePath = base.pathname.replace(/\/+$/, '');
  const joinedPath = basePath + (subpath === '/' && basePath ? '' : subpath);
  const target = new URL(`${base.origin}${joinedPath || '/'}${parsed.search}`);
  if (target.origin !== base.origin) throw new Error('Relay target escaped pinned origin');
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    throw new Error('Relay target escaped pinned base path');
  }
  return { target, subpath: subpath || '/' };
}
function forwardHeaders(incoming: IncomingHttpHeaders, key: string, api: string): Record<string, string> {
  const connectionTokens = new Set(
    String(incoming.connection ?? '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean),
  );
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(incoming)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(name) || connectionTokens.has(name) || name.startsWith('x-forwarded-')) continue;
    headers[name] = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
  }
  headers.authorization = `Bearer ${key}`;
  if (api === 'anthropic-messages') headers['x-api-key'] = key;
  return headers;
}
function looksLikeResponsesPayload(body: Record<string, unknown>) {
  return Object.hasOwn(body, 'input') && (
    Object.hasOwn(body, 'previous_response_id') ||
    Object.hasOwn(body, 'conversation') ||
    Object.hasOwn(body, 'store') ||
    Object.hasOwn(body, 'reasoning')
  );
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
  native?: NativeOverride; maxTurns?: number; requestTimeoutMs?: number;
  contest: Pick<ReturnType<typeof match>, 'submit' | 'status' | 'close'>; event: EventSink; finish: () => void; fault: (reason: string) => void }) {
  const { dir, profile, key, signal, contest, event } = opts;
  const maxTurns = opts.maxTurns ?? protocol.maxTurns;
  const requestTimeoutMs = opts.requestTimeoutMs ?? protocol.requestTimeoutMs;
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
    const method = (req.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) { reject(405, 'Unsupported HTTP method'); return; }
    let resolved: ReturnType<typeof resolveRelayTarget>;
    try { resolved = resolveRelayTarget(profile.base_url, req.url ?? ''); }
    catch (error) {
      event({ type: 'model_request_rejected', reason: error instanceof Error ? error.message : 'Invalid relay path' });
      reject(400, 'Disallowed relay path');
      return;
    }
    if (finished || current.aborted || inFlight) { reject(429, 'Model request already in flight or run closed'); return; }
    if (calls >= maxTurns) { opts.fault('turn_limit'); reject(429, 'Run model request limit reached'); return; }
    inFlight = true;
    void (async () => {
      const isResponsesPath = method === 'POST' && (resolved.subpath === '/responses' || resolved.subpath.endsWith('/responses'));
      const headers = forwardHeaders(req.headers, key, profile.api);
      const hasBody = method !== 'GET' && method !== 'HEAD';
      let rawBody: Buffer = Buffer.alloc(0);
      if (hasBody) {
        try { rawBody = await rawRequestBody(req); }
        catch (error) {
          event({ type: 'model_request_rejected', reason: error instanceof Error ? error.message : 'Request too large' });
          opts.fault('invalid_model_request'); reject(400, 'Disallowed request'); return;
        }
      }
      let outgoingBody: Buffer | undefined = hasBody && rawBody.length > 0 ? rawBody : undefined;
      let requestedModel: string = profile.model;
      let reasoning: unknown = null;
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
      let parsedJson: Record<string, unknown> | undefined;
      if (hasBody && (isResponsesPath || (rawBody.length > 0 && contentType.includes('application/json')))) {
        try {
          const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parsedJson = parsed as Record<string, unknown>;
          else if (isResponsesPath) throw new Error('Expected JSON object');
        } catch (error) {
          if (isResponsesPath) {
            event({ type: 'model_request_rejected', reason: error instanceof Error && !(error instanceof SyntaxError) ? error.message : 'Invalid JSON' });
            opts.fault('invalid_model_request'); reject(400, 'Disallowed request'); return;
          }
        }
      }
      if (parsedJson && (isResponsesPath || looksLikeResponsesPayload(parsedJson))) {
        let checked: ReturnType<typeof checkModelRequest>;
        try { checked = checkModelRequest(parsedJson, profile.model); }
        catch (error) {
          event({ type: 'model_request_rejected', reason: error instanceof Error ? error.message : 'Disallowed request' });
          opts.fault('invalid_model_request'); reject(400, 'Disallowed request'); return;
        }
        // Codex may omit native verbosity for models absent from its catalog.
        // Apply the explicitly configured value to the approved Responses request.
        const verbosity = opts.native?.model_verbosity;
        if (verbosity) {
          const text = (checked as Record<string, unknown>).text;
          Object.assign(checked, { text: { ...(text && typeof text === 'object' && !Array.isArray(text) ? text : {}), verbosity } });
        }
        if (profile.service_tier) {
          Object.assign(checked, { service_tier: profile.service_tier });
        }
        reasoning = (checked as Record<string, unknown>).reasoning ?? null;
        outgoingBody = Buffer.from(JSON.stringify(checked));
        headers['content-type'] = 'application/json';
      } else if (parsedJson) {
        if (typeof parsedJson.model === 'string') requestedModel = parsedJson.model;
        if (parsedJson.reasoning !== undefined) reasoning = parsedJson.reasoning;
      }
      const turn = ++calls;
      event({ type: 'model_request', turn, method, path: resolved.subpath, model: requestedModel, reasoning });
      const disconnected = new AbortController();
      res.once('close', () => { if (!res.writableFinished) disconnected.abort(); });
      const requestSignal = AbortSignal.any([current, disconnected.signal, AbortSignal.timeout(requestTimeoutMs)]);
      const startedAt = performance.now();
      let completed = false;
      let ttftMs: number | undefined;
      let upstreamStatus: number | undefined;
      try {
        const upstream = await fetch(resolved.target, {
          method, headers, ...(outgoingBody !== undefined ? { body: new Uint8Array(outgoingBody) } : {}),
          redirect: 'error', signal: requestSignal,
        });
        upstreamStatus = upstream.status;
        const headersMs = Math.max(0, Math.round(performance.now() - startedAt));
        const type = upstream.headers.get('content-type') ?? 'application/json';
        event({ type: 'model_response', turn, status: upstream.status, request_id: upstream.headers.get('x-request-id'), ttft_ms: headersMs, path: resolved.subpath });
        if (!upstream.ok || (!upstream.body && method !== 'HEAD')) {
          void upstream.body?.cancel().catch(() => {});
          event({ type: 'model_timing', turn, method, path: resolved.subpath, status: upstream.status, ttft_ms: headersMs, duration_ms: Math.max(0, Math.round(performance.now() - startedAt)) });
          opts.fault('model_request_failed'); reject(502, 'Upstream model request failed'); return;
        }
        res.writeHead(upstream.status, { 'content-type': type });
        if (!upstream.body) {
          res.end();
          event({ type: 'model_timing', turn, method, path: resolved.subpath, status: upstream.status, ttft_ms: headersMs, duration_ms: Math.max(0, Math.round(performance.now() - startedAt)) });
          return;
        }
        // Preserve the streaming wire protocol; retain only identity, usage, and timing metadata.
        const reader = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        const decoder = new TextDecoder(); let line = ''; let observed = false;
        const observe = (text: string) => {
          const trimmed = text.trim();
          if (!trimmed || trimmed === '[DONE]') return;
          try {
            const record = JSON.parse(trimmed) as Record<string, unknown>;
            const value = ((record.response ?? record.message ?? record) ?? {}) as Record<string, unknown>;
            if (!observed && typeof value.model === 'string' && typeof value.id === 'string') {
              observed = true;
              event({ type: 'model_identity', turn, model: value.model, response_id: value.id });
            }
            if (isResponsesPath && typeof value.model === 'string' && value.model !== profile.model && /^gpt-.*-\d{4}-\d{2}-\d{2}$/.test(profile.model)) {
              opts.fault('unexpected_model');
            }
            if (record.type === 'response.completed' || record.object === 'response') {
              completed = true;
              if (value.usage) event({ type: 'model_usage', turn, usage: value.usage });
            } else if (record.object === 'chat.completion') {
              completed = true;
              if (record.usage) event({ type: 'model_usage', turn, usage: record.usage });
            } else if (record.object === 'chat.completion.chunk') {
              const choices = Array.isArray(record.choices) ? record.choices as Record<string, unknown>[] : [];
              if (choices.some(c => c && typeof c.finish_reason === 'string' && c.finish_reason)) completed = true;
              if (record.usage) event({ type: 'model_usage', turn, usage: record.usage });
            } else if (record.type === 'message_start') {
              if (value.usage) event({ type: 'model_usage', turn, usage: value.usage });
            } else if (record.type === 'message_delta') {
              if (record.usage) event({ type: 'model_usage', turn, usage: record.usage });
            } else if (record.type === 'message_stop') {
              completed = true;
            }
            if (['response.failed', 'error'].includes(String(record.type))) opts.fault('model_request_failed');
          } catch { /* non-data SSE line */ }
        };
        if (type.includes('text/event-stream')) reader.on('data', (chunk: Buffer) => {
          if (ttftMs === undefined) ttftMs = Math.max(0, Math.round(performance.now() - startedAt));
          line += decoder.decode(chunk, { stream: true });
          const lines = line.split('\n'); line = lines.pop() ?? '';
          if (line.length > 1_000_000) line = '';
          for (const l of lines) if (l.startsWith('data: ')) observe(l.slice(6));
        });
        else {
          reader.on('data', (chunk: Buffer) => {
            if (ttftMs === undefined) ttftMs = Math.max(0, Math.round(performance.now() - startedAt));
            if (line.length <= 1_000_000) line += decoder.decode(chunk, { stream: true });
          });
          reader.once('end', () => observe(line));
        }
        await pipeline(reader, res, { signal: requestSignal });
        event({ type: 'model_timing', turn, method, path: resolved.subpath, status: upstream.status, ttft_ms: ttftMs ?? headersMs, duration_ms: Math.max(0, Math.round(performance.now() - startedAt)) });
      } catch {
        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        event({ type: 'model_timing', turn, method, path: resolved.subpath, status: upstreamStatus ?? null, ttft_ms: ttftMs ?? durationMs, duration_ms: durationMs });
        if (!current.aborted && !finished && !(completed && disconnected.signal.aborted)) opts.fault('model_request_failed');
        reject(502, 'Upstream transport failed');
      }
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
