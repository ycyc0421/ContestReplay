import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createServer as socketServer, type Socket } from 'node:net';
import { constants } from 'node:fs';
import { chmod, mkdir, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { effectiveFor, responsesServiceTier, type NativeOverride } from './harnesses.js';
import type { AgentProfile } from './config.js';
import { finishArgs, type EventSink } from './contest.js';
import { submissionSchema, statusSchema, type match } from './match.js';
import { protocol, relayMaxRequestBytes } from './protocol.js';
import { redactCredentialStream } from './credential-redaction.js';
import { z } from 'zod';

type Antigravity = Extract<AgentProfile, { harness: 'codex' }>;
type Endpoint = ReturnType<typeof socketServer> | ReturnType<typeof createServer>;

export const ALLOWED_INFERENCE_ROUTES = ['/responses', '/responses/compact', '/chat/completions', '/messages'] as const;
type InferenceRoute = (typeof ALLOWED_INFERENCE_ROUTES)[number];

const PROTOCOL_ALLOWED_ROUTES: Readonly<Record<string, readonly InferenceRoute[]>> = {
  passthrough: ALLOWED_INFERENCE_ROUTES,
  responses: ['/responses', '/responses/compact'],
  'chat-completions': ['/chat/completions'],
  'anthropic-messages': ['/messages'],
};

const ALLOWED_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
  'user-agent',
]);

const DATA_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,/;

export type SessionArchiveStatus = 'archived' | 'empty' | 'not_connected' | 'truncated' | 'failed';
export type SessionArchiveResult = { status: SessionArchiveStatus; files: string[] };

const SESSION_MAX_BYTES = 32 * 1024 * 1024;
const SESSION_MAX_FILES = 256;
const SESSION_MAX_ENTRIES = 2048;
const SESSION_MAX_LINE_BYTES = 256 * 1024;

export function isSafeSessionRelPath(relPath: string): boolean {
  if (!relPath || relPath.length > 256 || !/^[A-Za-z0-9._/-]+$/.test(relPath)) return false;
  if (relPath.startsWith('/') || relPath.endsWith('/') || relPath.includes('//')) return false;
  const segments = relPath.split('/');
  if (segments.length > 8) return false;
  return segments.every(seg => seg.length > 0 && seg !== '.' && seg !== '..');
}

async function listen(server: Endpoint, path: string) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  await chmod(path, 0o666);
}
export async function codexConfig(dir: string, profile: Antigravity, native?: NativeOverride) {
  await writeFile(join(dir, 'config.toml'), effectiveFor(profile, native).content, { mode: 0o444 });
}
async function rawRequestBody(req: IncomingMessage, maxBytes: number) {
  const buffers: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('Model request too large');
    buffers.push(chunk as Buffer);
  }
  return Buffer.concat(buffers);
}
export function resolveRelayTarget(baseUrl: string, reqUrl: string, api?: string) {
  if (!reqUrl || !reqUrl.startsWith('/') || reqUrl.startsWith('//') || /[\x00-\x1f\x7f\\;#]/.test(reqUrl)) {
    throw new Error('Invalid relay path');
  }
  const qIndex = reqUrl.indexOf('?');
  const rawPath = qIndex === -1 ? reqUrl : reqUrl.slice(0, qIndex);
  const rawSearch = qIndex === -1 ? '' : reqUrl.slice(qIndex);
  if (rawPath.includes('//')) throw new Error('Invalid relay path');
  const trimmedPath = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const rawSegments = trimmedPath.slice(1).split('/');
  const decodedSegments: string[] = [];
  for (const rawSeg of rawSegments) {
    if (!rawSeg || rawSeg === '.' || rawSeg === '..') throw new Error('Path traversal is not allowed');
    let decoded: string;
    try { decoded = decodeURIComponent(rawSeg); }
    catch { throw new Error('Invalid relay path'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\;\x00-\x1f\x7f]/.test(decoded)) {
      throw new Error('Path traversal is not allowed');
    }
    decodedSegments.push(decoded.toLowerCase());
  }
  const routeSegments = decodedSegments[0] === 'v1' ? decodedSegments.slice(1) : decodedSegments;
  const normalizedSubpath = `/${routeSegments.join('/')}` as InferenceRoute;
  if (!(ALLOWED_INFERENCE_ROUTES as readonly string[]).includes(normalizedSubpath)) {
    throw new Error('Unsupported model endpoint');
  }
  if (api !== undefined) {
    const allowedForApi = PROTOCOL_ALLOWED_ROUTES[api];
    if (!allowedForApi || !allowedForApi.includes(normalizedSubpath)) {
      throw new Error(`Endpoint ${normalizedSubpath} is not allowed for provider protocol ${api}`);
    }
  }
  const base = new URL(baseUrl.replace(/\/+$/, ''));
  const basePath = base.pathname.replace(/\/+$/, '');
  const basePathLower = basePath.toLowerCase();
  if (ALLOWED_INFERENCE_ROUTES.some(route => basePathLower === route || basePathLower.endsWith(route))) {
    throw new Error('Base URL must not include a specific inference endpoint path');
  }
  const target = new URL(`${base.origin}${basePath}${normalizedSubpath}${rawSearch}`);
  if (target.origin !== base.origin) throw new Error('Relay target escaped pinned origin');
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    throw new Error('Relay target escaped pinned base path');
  }
  return { target, subpath: normalizedSubpath };
}
function forwardHeaders(incoming: IncomingHttpHeaders, key: string, api: string, subpath: InferenceRoute): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(incoming)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(name)) continue;
    headers[name] = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
  }
  headers['content-type'] = 'application/json';
  headers['accept-encoding'] = 'identity';
  headers.authorization = `Bearer ${key}`;
  if (api === 'anthropic-messages' || subpath === '/messages') headers['x-api-key'] = key;
  return headers;
}
function inspectNestedFilesAndImages(obj: unknown, depth = 0) {
  if (depth > 30) throw new Error('Request nesting exceeds limit');
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) inspectNestedFilesAndImages(item, depth + 1);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (['file_url', 'file_id', 'document_url', 'audio_url', 'video_url'].includes(key)) {
      throw new Error('Remote files are not allowed');
    }
    if (key === 'image_url') {
      if (typeof value === 'string') {
        if (!DATA_IMAGE_RE.test(value)) throw new Error('Remote files are not allowed');
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const url = (value as Record<string, unknown>).url;
        if (typeof url !== 'string' || !DATA_IMAGE_RE.test(url)) throw new Error('Remote files are not allowed');
      } else {
        throw new Error('Remote files are not allowed');
      }
    }
    if (key === 'source' && value && typeof value === 'object' && !Array.isArray(value)) {
      const src = value as Record<string, unknown>;
      if (src.type === 'url' || src.type === 'file' || Object.hasOwn(src, 'url') || Object.hasOwn(src, 'file_id')) {
        throw new Error('Remote files are not allowed');
      }
    }
    inspectNestedFilesAndImages(value, depth + 1);
  }
}
function validateResponsesTools(toolsRaw: unknown) {
  const tools = toolsRaw ?? [];
  if (!Array.isArray(tools) || tools.some(tool => !tool || typeof tool !== 'object' || !['function', 'custom', 'namespace'].includes((tool as { type?: string }).type ?? ''))) {
    throw new Error('Remote tools are not allowed: ' + (Array.isArray(tools) ? tools.map(t => (t as { type?: unknown })?.type).filter(t => typeof t === 'string' && /^[a-z_]{1,30}$/.test(t)).join(',') : 'invalid list'));
  }
  for (const tool of tools as { type?: string; tools?: unknown }[]) {
    if (tool.type === 'namespace' && (!Array.isArray(tool.tools) || tool.tools.some((inner: { type?: string }) => !inner || !['function', 'custom'].includes(inner.type ?? '')))) {
      throw new Error('Remote tools are not allowed in namespaces');
    }
  }
}
export function checkModelRequest(body: Record<string, unknown>, model: string) {
  if (
    body.model !== model || body.previous_response_id || body.conversation || body.background || body.prompt ||
    Object.hasOwn(body, 'messages') || body.web_search_options || body.mcp_servers || body.mcp_toolsets ||
    body.file_ids || body.attachments || (body.include && !Array.isArray(body.include))
  ) {
    throw new Error('Unsupported model request');
  }
  validateResponsesTools(body.tools);
  inspectNestedFilesAndImages(body.input);
  return { ...body, store: false };
}
export function checkResponsesCompactRequest(body: Record<string, unknown>, model: string) {
  if (
    body.model !== model || body.previous_response_id || body.conversation || body.background || body.prompt ||
    Object.hasOwn(body, 'messages') || body.web_search_options || body.mcp_servers || body.mcp_toolsets ||
    body.file_ids || body.attachments || (body.include && !Array.isArray(body.include))
  ) {
    throw new Error('Unsupported model request');
  }
  if (body.tools !== undefined) validateResponsesTools(body.tools);
  inspectNestedFilesAndImages(body.input);
  const sanitized = { ...body };
  delete sanitized.store;
  delete sanitized.service_tier;
  return sanitized;
}
export function checkChatOrMessagesRequest(body: Record<string, unknown>, model: string, route: '/chat/completions' | '/messages') {
  if (
    body.model !== model ||
    Object.hasOwn(body, 'input') || Object.hasOwn(body, 'previous_response_id') ||
    Object.hasOwn(body, 'conversation') || Object.hasOwn(body, 'prompt') ||
    body.web_search_options || body.mcp_servers || body.mcp_toolsets || body.file_ids || body.attachments || body.background
  ) {
    throw new Error('Unsupported model request');
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error('Remote tools are not allowed: invalid list');
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('Remote tools are not allowed');
      const t = tool as Record<string, unknown>;
      if (route === '/chat/completions') {
        if (typeof t.type !== 'string' || !['function', 'custom'].includes(t.type)) {
          throw new Error('Remote tools are not allowed');
        }
      } else {
        if (t.type !== undefined && (typeof t.type !== 'string' || !['custom', 'function'].includes(t.type))) {
          throw new Error('Remote tools are not allowed');
        }
        if (t.type === undefined && typeof t.name !== 'string') {
          throw new Error('Remote tools are not allowed');
        }
      }
    }
  }
  inspectNestedFilesAndImages(body.messages);
  inspectNestedFilesAndImages(body.system);
  inspectNestedFilesAndImages(body.tools);
  const sanitized: Record<string, unknown> = { ...body };
  delete sanitized.service_tier;
  if (route === '/chat/completions' && sanitized.store !== undefined) sanitized.store = false;
  return sanitized;
}

function createSessionReceiver(opts: {
  targetDir: string;
  key?: string;
  maxBytes: number;
  track: (socket: Socket) => void;
  stop: AbortController;
  onResult?: (result: SessionArchiveResult) => void;
}) {
  const { targetDir, key, maxBytes, track, stop } = opts;
  const archivedFiles: string[] = [];
  const openedPaths = new Set<string>();
  let totalDecodedBytes = 0;
  let totalEntries = 0;
  let connected = false;
  let sawDone = false;
  let truncated = false;
  let failed = false;
  let active = false;
  let finalized = false;
  const inflight = new Set<Promise<void>>();

  const computeStatus = (): SessionArchiveStatus => {
    if (truncated) return 'truncated';
    if (failed) return 'failed';
    if (!connected) return 'not_connected';
    if (!sawDone) return 'failed';
    return archivedFiles.length > 0 ? 'archived' : 'empty';
  };

  const finish = () => {
    if (finalized) return;
    finalized = true;
    opts.onResult?.({ status: computeStatus(), files: [...archivedFiles].sort() });
  };

  const server = socketServer(socket => {
    track(socket);
    if (active || stop.signal.aborted) { socket.destroy(); return; }
    active = true;
    connected = true;
    const task = (async () => {
      let currentPath: string | undefined;
      let currentDestPath: string | undefined;
      let currentHandle: FileHandle | undefined;
      let currentRedactor: ReturnType<typeof redactCredentialStream> | undefined;
      let writeChain = Promise.resolve();

      const closeCurrentFile = async (commit: boolean) => {
        const rel = currentPath;
        const dest = currentDestPath;
        const handle = currentHandle;
        const redactor = currentRedactor;
        currentPath = undefined;
        currentDestPath = undefined;
        currentHandle = undefined;
        currentRedactor = undefined;
        if (!handle) return;
        try {
          if (commit && redactor) redactor.end();
          await writeChain;
          await handle.close();
          if (commit && rel) archivedFiles.push(rel);
          else if (dest) await rm(dest, { force: true }).catch(() => {});
        } catch (err) {
          await handle.close().catch(() => {});
          if (dest) await rm(dest, { force: true }).catch(() => {});
          throw err;
        }
      };

      const openFile = async (relPath: string) => {
        if (openedPaths.has(relPath)) throw new Error('duplicate_path');
        if (archivedFiles.length >= SESSION_MAX_FILES) {
          truncated = true;
          throw new Error('file_limit');
        }
        const destPath = join(targetDir, ...relPath.split('/'));
        await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
        const handle = await open(destPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        openedPaths.add(relPath);
        currentPath = relPath;
        currentDestPath = destPath;
        currentHandle = handle;
        let writePos = 0;
        currentRedactor = redactCredentialStream(key, bytes => {
          if (bytes.length === 0) return;
          const copy = Buffer.from(bytes);
          writeChain = writeChain.then(async () => {
            await handle.write(copy, 0, copy.length, writePos);
            writePos += copy.length;
          });
        });
      };

      const processLine = async (rawLine: string) => {
        const trimmed = rawLine.trim();
        if (!trimmed) return;
        if (++totalEntries > SESSION_MAX_ENTRIES) {
          truncated = true;
          throw new Error('entry_limit');
        }
        let frame: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad_frame');
          frame = parsed as Record<string, unknown>;
        } catch {
          failed = true;
          throw new Error('bad_json');
        }
        if (frame.done === true) {
          await closeCurrentFile(true);
          sawDone = true;
          socket.end('{"ok":true}\n');
          return;
        }
        if (typeof frame.path !== 'string' || typeof frame.data_base64 !== 'string' || !isSafeSessionRelPath(frame.path)) {
          failed = true;
          throw new Error('invalid_path');
        }
        if (frame.path !== currentPath) {
          await closeCurrentFile(true);
          await openFile(frame.path);
        }
        const decoded = Buffer.from(frame.data_base64, 'base64');
        if (totalDecodedBytes + decoded.length > maxBytes) {
          const allowed = Math.max(0, maxBytes - totalDecodedBytes);
          if (allowed > 0) {
            currentRedactor?.push(decoded.subarray(0, allowed));
            totalDecodedBytes += allowed;
          }
          currentRedactor?.push(Buffer.from('\n[cr: session archive truncated at byte limit]\n'));
          truncated = true;
          await closeCurrentFile(true);
          throw new Error('byte_limit');
        }
        totalDecodedBytes += decoded.length;
        if (decoded.length > 0) currentRedactor?.push(decoded);
        await writeChain;
      };

      let buffer = '';
      try {
        for await (const chunk of socket) {
          buffer += (chunk as Buffer).toString('utf8');
          let nl = buffer.indexOf('\n');
          while (nl !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (Buffer.byteLength(line) > SESSION_MAX_LINE_BYTES) {
              failed = true;
              throw new Error('line_too_large');
            }
            await processLine(line);
            nl = buffer.indexOf('\n');
          }
          if (Buffer.byteLength(buffer) > SESSION_MAX_LINE_BYTES) {
            failed = true;
            throw new Error('line_too_large');
          }
        }
        if (buffer.trim()) await processLine(buffer);
        if (!sawDone && !truncated) failed = true;
      } catch {
        if (!truncated) failed = true;
        socket.destroy();
      } finally {
        await closeCurrentFile(false).catch(() => { failed = true; });
        active = false;
      }
    })();
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  });

  return {
    server,
    async finalize() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 1_500); timer.unref(); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      finish();
    },
    result: (): SessionArchiveResult => ({
      status: computeStatus(),
      files: [...archivedFiles].sort(),
    }),
  };
}

export type ContestChannelsHandle = (() => Promise<void>) & { stopInference: () => void };

export async function serveContestChannels(opts: { dir: string; profile: Antigravity; key: string; signal: AbortSignal;
  native?: NativeOverride; maxTurns?: number; requestTimeoutMs?: number; maxRequestBytes?: number;
  sessionArchive?: { dir: string; maxBytes?: number; onResult?: (result: SessionArchiveResult) => void };
  contest: Pick<ReturnType<typeof match>, 'submit' | 'status' | 'close'>; event: EventSink; finish: () => void; fault: (reason: string) => void }): Promise<ContestChannelsHandle> {
  const { dir, profile, key, signal, contest, event } = opts;
  const maxTurns = opts.maxTurns ?? protocol.maxTurns;
  const requestTimeoutMs = opts.requestTimeoutMs ?? protocol.requestTimeoutMs;
  const maxRequestBytes = opts.maxRequestBytes ?? relayMaxRequestBytes(protocol);
  await mkdir(dir, { mode: 0o755 });
  const stop = new AbortController();
  const current = AbortSignal.any([stop.signal, signal]);
  let calls = 0;
  let finished = false;
  let inFlight = false;
  let peers = 0;
  const connections = new Set<Socket>();
  const track = (socket: Socket) => { connections.add(socket); socket.once('close', () => connections.delete(socket)); };
  const relay = createServer((req, res) => {
    const reject = (status: number, message: string) => { if (res.headersSent) res.destroy(); else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message } })); };
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'POST') {
      event({ type: 'model_request_rejected', reason: 'Unsupported HTTP method' });
      reject(405, 'Unsupported HTTP method');
      return;
    }
    let resolved: ReturnType<typeof resolveRelayTarget>;
    try { resolved = resolveRelayTarget(profile.base_url, req.url ?? '', profile.api); }
    catch (error) {
      const msg = error instanceof Error ? error.message : 'Invalid relay path';
      event({ type: 'model_request_rejected', reason: msg });
      reject(msg === 'Unsupported model endpoint' ? 404 : 400, msg);
      return;
    }
    if (finished || current.aborted || inFlight) { reject(429, 'Model request already in flight or run closed'); return; }
    if (calls >= maxTurns) {
      finished = true;
      contest.close();
      opts.fault('turn_limit');
      reject(429, 'Run model request limit reached');
      return;
    }
    inFlight = true;
    void (async () => {
      const headers = forwardHeaders(req.headers, key, profile.api, resolved.subpath);
      let rawBody: Buffer;
      try { rawBody = await rawRequestBody(req, maxRequestBytes); }
      catch (error) {
        if (current.aborted || finished) { reject(499, 'Run closed'); return; }
        event({ type: 'model_request_rejected', reason: error instanceof Error ? error.message : 'Request too large' });
        opts.fault('invalid_model_request'); reject(400, 'Disallowed request'); return;
      }
      if (current.aborted || finished) { reject(499, 'Run closed'); return; }
      let parsedJson: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected JSON object');
        parsedJson = parsed as Record<string, unknown>;
      } catch (error) {
        event({ type: 'model_request_rejected', reason: error instanceof Error && !(error instanceof SyntaxError) ? error.message : 'Invalid JSON' });
        opts.fault('invalid_model_request'); reject(400, 'Disallowed request'); return;
      }
      // Dispatch strictly by canonical route — never allow payload sniffing to switch validators.
      let checked: Record<string, unknown>;
      const isResponsesRoute = resolved.subpath === '/responses' || resolved.subpath === '/responses/compact';
      try {
        if (resolved.subpath === '/responses') {
          checked = checkModelRequest(parsedJson, profile.model);
          // Host enforces billing tier and configured reasoning effort; never let sandbox spoof them.
          delete checked.service_tier;
          const mappedServiceTier = responsesServiceTier(profile.service_tier);
          if (mappedServiceTier) checked.service_tier = mappedServiceTier;
          if (profile.reasoning_effort) {
            const existing = checked.reasoning && typeof checked.reasoning === 'object' && !Array.isArray(checked.reasoning)
              ? checked.reasoning as Record<string, unknown> : {};
            checked.reasoning = { ...existing, effort: profile.reasoning_effort };
          }
          // Antigravity may omit native verbosity for models absent from its catalog.
          // Apply the explicitly configured value to the approved Responses request.
          const verbosity = opts.native?.model_verbosity;
          if (verbosity) {
            const text = checked.text;
            checked.text = { ...(text && typeof text === 'object' && !Array.isArray(text) ? text : {}), verbosity };
          }
        } else if (resolved.subpath === '/responses/compact') {
          checked = checkResponsesCompactRequest(parsedJson, profile.model);
          if (profile.reasoning_effort && checked.reasoning !== undefined) {
            const existing = checked.reasoning && typeof checked.reasoning === 'object' && !Array.isArray(checked.reasoning)
              ? checked.reasoning as Record<string, unknown> : {};
            checked.reasoning = { ...existing, effort: profile.reasoning_effort };
          }
        } else {
          checked = checkChatOrMessagesRequest(parsedJson, profile.model, resolved.subpath);
        }
      } catch (error) {
        event({ type: 'model_request_rejected', reason: error instanceof Error ? error.message : 'Disallowed request' });
        opts.fault('invalid_model_request'); reject(400, 'Disallowed request'); return;
      }
      const outgoingBody = Buffer.from(JSON.stringify(checked));
      const reasoning = checked.reasoning ?? null;
      const turn = ++calls;
      event({ type: 'model_request', turn, method, path: resolved.subpath, model: profile.model, reasoning });
      const disconnected = new AbortController();
      res.once('close', () => { if (!res.writableFinished) disconnected.abort(); });
      const requestSignal = AbortSignal.any([current, disconnected.signal, AbortSignal.timeout(requestTimeoutMs)]);
      const startedAt = performance.now();
      let completed = false;
      let ttftMs: number | undefined;
      let upstreamStatus: number | undefined;
      try {
        const upstream = await fetch(resolved.target, {
          method, headers, body: new Uint8Array(outgoingBody),
          redirect: 'error', signal: requestSignal,
        });
        upstreamStatus = upstream.status;
        const headersMs = Math.max(0, Math.round(performance.now() - startedAt));
        const type = upstream.headers.get('content-type') ?? 'application/json';
        event({ type: 'model_response', turn, status: upstream.status, request_id: upstream.headers.get('x-request-id'), ttft_ms: headersMs, path: resolved.subpath });
        if (!upstream.ok || !upstream.body) {
          void upstream.body?.cancel().catch(() => {});
          event({ type: 'model_timing', turn, method, path: resolved.subpath, status: upstream.status, ttft_ms: headersMs, duration_ms: Math.max(0, Math.round(performance.now() - startedAt)) });
          opts.fault('model_request_failed'); reject(502, 'Upstream model request failed'); return;
        }
        res.writeHead(upstream.status, { 'content-type': type });
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
            if (isResponsesRoute && typeof value.model === 'string' && value.model !== profile.model && /^gpt-.*-\d{4}-\d{2}-\d{2}$/.test(profile.model)) {
              opts.fault('unexpected_model');
            }
            if (record.type === 'response.completed' || record.object === 'response' || record.object === 'response.compaction') {
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
        if (type.includes('text/event-stream')) {
          reader.on('data', (chunk: Buffer) => {
            if (ttftMs === undefined) ttftMs = Math.max(0, Math.round(performance.now() - startedAt));
            line += decoder.decode(chunk, { stream: true });
            const lines = line.split('\n'); line = lines.pop() ?? '';
            if (line.length > 1_000_000) line = '';
            for (const rawL of lines) {
              const l = rawL.replace(/\r$/, '');
              if (l.startsWith('data:')) observe(l.slice(5));
            }
          });
          reader.once('end', () => {
            const tail = (line + decoder.decode()).replace(/\r$/, '');
            if (tail.startsWith('data:')) observe(tail.slice(5));
          });
        } else {
          reader.on('data', (chunk: Buffer) => {
            if (ttftMs === undefined) ttftMs = Math.max(0, Math.round(performance.now() - startedAt));
            if (line.length <= 1_000_000) line += decoder.decode(chunk, { stream: true });
          });
          reader.once('end', () => observe(line + decoder.decode()));
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
  const sessionReceiver = opts.sessionArchive
    ? createSessionReceiver({
      targetDir: opts.sessionArchive.dir,
      key,
      maxBytes: opts.sessionArchive.maxBytes ?? SESSION_MAX_BYTES,
      track,
      stop,
      onResult: opts.sessionArchive.onResult,
    })
    : undefined;

  const servers: Endpoint[] = [relay, mcp, ...(sessionReceiver ? [sessionReceiver.server] : [])];
  const close = (async () => {
    stop.abort();
    await sessionReceiver?.finalize();
    for (const connection of connections) connection.destroy();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }) as ContestChannelsHandle;
  close.stopInference = () => { finished = true; };
  try {
    await listen(relay, join(dir, 'model.sock'));
    await listen(mcp, join(dir, 'mcp.sock'));
    if (sessionReceiver) await listen(sessionReceiver.server, join(dir, 'session.sock'));
  } catch (error) { await close(); throw error; }
  return close;
}
