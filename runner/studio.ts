import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { saveAgent, saveContest, codeforcesContest } from './author.js';
import { exportBatch } from './results.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { makePlan, type Plan } from './plan.js';
import { dispatch, enqueue, listBatches, lookupRun, readRunLog, requestBatchStop, requestRunCancel, summarize, type QueueOptions } from './queue.js';
import { serveStudioStatic, studioCsp } from './studio-static.js';
import { Connections } from './connections.js';
import { configError, configRoute, isConfigRoute } from './studio-config-api.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function body(req: IncomingMessage, limit = 64 * 1024) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Expected application/json');
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'Request too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Expected JSON object');
  return data as Record<string, unknown>;
}
function reply(res: ServerResponse, status: number, content: string, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': studioCsp,
    'Referrer-Policy': 'no-referrer' });
  res.end(content);
}
export async function startStudio(root: string, port = 0, opts: { base?: string; getImage?: Parameters<typeof makePlan>[2]; queue?: QueueOptions; store?: Connections } = {}) {
  const base = resolve(opts.base ?? process.cwd());
  const store = opts.store ?? new Connections();
  const plans = new Map<string, Plan>();
  const control = new AbortController();
  let worker: Promise<unknown> | undefined;
  let lastError: string | null = null;
  let host = '';
  const json = (res: ServerResponse, data: unknown, status = 200) => reply(res, status, JSON.stringify(data));
  const launch = async (start: () => Promise<string>) => {
    if (worker || control.signal.aborted) throw new HttpError(409, 'Studio is already running a batch or shutting down');
    lastError = null;
    const id = start();
    const task = id.then(batchId => dispatch(root, batchId, control.signal, { ...opts.queue, store }));
    worker = task.catch(error => { lastError = error instanceof Error ? error.message : 'Batch failed'; })
      .finally(() => { worker = undefined; });
    return id;
  };
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    void (async () => {
      if (req.headers.host !== host) throw new HttpError(403, 'Invalid host');
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Invalid origin');
      if (['POST', 'PATCH', 'DELETE'].includes(req.method ?? '') && (origin !== `http://${host}` || req.headers['x-cr-studio'] !== '1')) throw new HttpError(403, 'Same-origin Studio requests only');
      const path = new URL(req.url ?? '/', 'http://' + host).pathname;
      if (req.method === 'GET' && path !== '/api' && !path.startsWith('/api/') && await serveStudioStatic(path, res)) return;
      if (isConfigRoute(path)) {
        try {
          const result = await configRoute(path, req, { root, base, store, signal: control.signal, getImage: opts.getImage }, () => body(req, 512 * 1024));
          return json(res, result.data, result.status);
        } catch (error) {
          if (error instanceof HttpError) return json(res, { error: error.message, issues: [] }, error.status);
          const { status, ...failure } = configError(error);
          return json(res, path === '/api/agents/validate' ? { valid: false, ...failure, warnings: [] } : failure, status);
        }
      }
      if (req.method === 'GET' && path === '/api/batches') {
        const batches = (await listBatches(root)).map(summarize);
        return json(res, { batches, error: lastError, busy: !!worker });
      }
      if (req.method === 'POST' && ['/api/config/agent', '/api/config/contest', '/api/config/codeforces'].includes(path)) {
        const { file, config } = await body(req);
        if (typeof file !== 'string' || !file.trim()) throw new HttpError(400, 'Expected local output path');
        const target = resolve(opts.base ?? process.cwd(), file);
        const saved = path.endsWith('/agent') ? await saveAgent(target, config)
          : path.endsWith('/codeforces') ? await codeforcesContest(target, config, control.signal) : await saveContest(target, config);
        return json(res, { path: saved }, 201);
      }
      const exported = path.match(/^\/api\/batches\/([0-9a-f-]+)\/results$/);
      if (req.method === 'GET' && exported) {
        res.setHeader('Content-Disposition', 'attachment; filename="results.json"');
        return json(res, await exportBatch(root, exported[1]!));
      }
      if (req.method === 'POST' && path === '/api/plan') {
        const plan = await makePlan(await body(req), base, opts.getImage, store);
        while (plans.size >= 8) plans.delete(plans.keys().next().value!);
        const token = randomUUID();
        plans.set(token, plan);
        return json(res, { token, jobs: plan.jobs.map(({ agent_id, agent_name, agent_revision, contest_id, data_version, speed_tier }) => ({
          agent_id, ...(agent_name ? { agent_name } : {}), agent_revision, contest_id, data_version, ...(speed_tier ? { speed_tier } : {}),
        })) });
      }
      if (req.method === 'POST' && path === '/api/batches') {
        const { token } = await body(req);
        const plan = typeof token === 'string' ? plans.get(token) : undefined;
        if (!plan) throw new HttpError(400, 'Preview the plan again');
        const id = await launch(async () => (await enqueue(root, plan)).id);
        plans.delete(token as string);
        return json(res, { id }, 202);
      }
      const batch = path.match(/^\/api\/batches\/([0-9a-f-]+)\/(stop|resume)$/);
      if (req.method === 'POST' && batch) {
        await body(req);
        const id = batch[1]!;
        if (batch[2] === 'resume') await launch(async () => id);
        else await requestBatchStop(root, id);
        return json(res, { id }, 202);
      }
      const run = path.match(/^\/api\/runs\/([0-9a-f-]+)\/(logs|cancel)$/);
      if (req.method === 'GET' && run?.[2] === 'logs') {
        const id = run[1]!;
        if (!await lookupRun(root, id)) throw new HttpError(404, 'Unknown batch run');
        const [stdout, stderr] = await Promise.all([readRunLog(root, id, 'stdout'), readRunLog(root, id, 'stderr')]);
        return json(res, { stdout, stderr });
      }
      if (req.method === 'POST' && run?.[2] === 'cancel') {
        await body(req);
        await requestRunCancel(root, run[1]!);
        return json(res, { requested: true }, 202);
      }
      throw new HttpError(404, 'Not found');
    })().catch(error => {
      if (!res.destroyed) json(res, { error: error instanceof Error ? error.message : 'Request failed' },
        error instanceof HttpError ? error.status : 400);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Unable to bind Studio'));
      host = `127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return { url: `http://${host}`, async close() {
    control.abort();
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await Promise.all([closed, worker]);
  } };
}
export async function serveStudio(root: string, port: number, signal: AbortSignal) {
  const studio = await startStudio(root, port);
  console.log(`Studio: ${studio.url}`);
  try {
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } finally { await studio.close(); }
}
