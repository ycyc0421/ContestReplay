import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { z } from 'zod';
import { codeforcesContest, saveAgent, saveContest } from './author.js';
import { Connections } from './connections.js';
import { OjAccounts, type previewContest as defaultPreviewContest } from './judges/index.js';
import { makePlan, type Plan } from './plan.js';
import {
  buildGhostRace,
  buildRunReplay,
  readRunLogSlice,
  readRunProgress,
  scoringModeSchema,
  summarizeLiveRun,
} from './progress.js';
import {
  createPushTargetSchema,
  patchPushTargetSchema,
  PushDispatcher,
  PushTargetError,
  pushTargetId,
  PushTargets,
  rotatePushTargetSchema,
} from './push.js';
import {
  concurrencySchema,
  dispatch,
  enqueue,
  getBatch,
  listBatches,
  lookupRun,
  readRunLog,
  requestBatchStop,
  requestRunCancel,
  summarize,
  type QueueOptions,
} from './queue.js';
import { exportBatch, exportRun, rankResults, resultBundle, type Result } from './results.js';
import { configError, configRoute, isConfigRoute } from './studio-config-api.js';
import { coverageResponseSchema, type CoverageCell } from './studio-contract.js';
import { serveStudioStatic, studioCsp } from './studio-static.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

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
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': studioCsp,
    'Referrer-Policy': 'no-referrer',
  });
  res.end(content);
}

const raceRequestSchema = z.strictObject({
  run_ids: z.array(z.uuid()).min(1).max(8),
  scoring_mode: scoringModeSchema.optional(),
  sample_step_ms: z.number().int().positive().max(3_600_000).optional(),
});

export interface StartStudioOptions {
  base?: string;
  getImage?: Parameters<typeof makePlan>[2];
  queue?: QueueOptions;
  store?: Connections;
  ojAccounts?: OjAccounts;
  pushTargets?: PushTargets;
  pushDispatcher?: PushDispatcher;
  previewContest?: typeof defaultPreviewContest;
  ssePollMs?: number;
}

export async function startStudio(root: string, port = 0, opts: StartStudioOptions = {}) {
  const base = resolve(opts.base ?? process.cwd());
  const store = opts.store ?? new Connections();
  const ojAccounts = opts.ojAccounts ?? opts.queue?.ojAccounts ?? new OjAccounts();
  const pushTargets = opts.pushTargets ?? new PushTargets();
  const pushDispatcher = opts.pushDispatcher ?? opts.queue?.pushDispatcher ?? new PushDispatcher(pushTargets);
  const ssePollMs = Math.max(50, Math.min(5_000, Math.floor(opts.ssePollMs ?? 750)));
  const plans = new Map<string, Plan>();
  const control = new AbortController();
  const sseResponses = new Set<ServerResponse>();
  let worker: Promise<unknown> | undefined;
  let lastError: string | null = null;
  let host = '';
  const json = (res: ServerResponse, data: unknown, status = 200) => reply(res, status, JSON.stringify(data));

  const launch = async (start: () => Promise<string>, concurrency?: number) => {
    if (worker || control.signal.aborted) throw new HttpError(409, 'Studio is already running a batch or shutting down');
    lastError = null;
    const id = start();
    const task = id.then(batchId => dispatch(root, batchId, control.signal, {
      ...opts.queue,
      store,
      ojAccounts,
      pushDispatcher,
      ...(concurrency !== undefined ? { concurrency } : {}),
    }));
    worker = task.catch(error => { lastError = error instanceof Error ? error.message : 'Batch failed'; })
      .finally(() => { worker = undefined; });
    return id;
  };

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    void (async () => {
      if (req.headers.host !== host) throw new HttpError(403, 'Invalid host');
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Invalid origin');
      if (
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') &&
        (origin !== `http://${host}` || req.headers['x-cr-studio'] !== '1')
      ) {
        throw new HttpError(403, 'Same-origin Studio requests only');
      }
      const url = new URL(req.url ?? '/', 'http://' + host);
      const path = url.pathname;

      if (req.method === 'GET' && path !== '/api' && !path.startsWith('/api/') && await serveStudioStatic(path, res)) return;

      if (isConfigRoute(path)) {
        try {
          const result = await configRoute(
            path,
            req,
            {
              root,
              base,
              store,
              ojAccounts,
              signal: control.signal,
              getImage: opts.getImage,
              previewContest: opts.previewContest,
            },
            () => body(req, 512 * 1024),
          );
          return json(res, result.data, result.status);
        } catch (error) {
          if (error instanceof HttpError) return json(res, { error: error.message, issues: [] }, error.status);
          const { status, ...failure } = configError(error);
          return json(res, path === '/api/agents/validate' ? { valid: false, ...failure, warnings: [] } : failure, status);
        }
      }

      // Push targets & deliveries
      const pushMatch = path.match(/^\/api\/push-targets(?:\/([^/]+)(\/rotate|\/test)?)?$/);
      if (pushMatch) {
        try {
          if (!pushMatch[1]) {
            if (req.method === 'GET') return json(res, { targets: await pushTargets.list() });
            if (req.method === 'POST') {
              const created = await pushTargets.create(createPushTargetSchema.parse(await body(req)));
              return json(res, created, 201);
            }
          } else {
            const targetId = pushTargetId.parse(pushMatch[1]);
            if (pushMatch[2] === '/rotate' && req.method === 'POST') {
              const rotated = await pushTargets.rotate(targetId, rotatePushTargetSchema.parse(await body(req)));
              return json(res, rotated);
            }
            if (pushMatch[2] === '/test' && req.method === 'POST') {
              if (req.headers['content-type']?.split(';')[0] === 'application/json') {
                await body(req);
              }
              const delivery = await pushDispatcher.testTarget(targetId);
              return json(res, delivery);
            }
            if (!pushMatch[2]) {
              if (req.method === 'PATCH') {
                const updated = await pushTargets.patch(targetId, patchPushTargetSchema.parse(await body(req)));
                return json(res, updated);
              }
              if (req.method === 'DELETE') {
                await pushTargets.remove(targetId);
                return json(res, { deleted: true });
              }
            }
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof PushTargetError) throw new HttpError(error.status, error.message);
          if (error instanceof z.ZodError) throw new HttpError(400, error.issues.map(i => i.message).join('; '));
          throw error;
        }
      }

      if (req.method === 'GET' && path === '/api/push-deliveries') {
        try {
          const limitRaw = url.searchParams.get('limit');
          const limit = limitRaw !== null ? Number(limitRaw) : 50;
          if (!Number.isFinite(limit) || limit < 1) throw new HttpError(400, 'Invalid limit parameter');
          const targetParam = url.searchParams.get('target_id') ?? undefined;
          const targetId = targetParam ? pushTargetId.parse(targetParam) : undefined;
          return json(res, { deliveries: await pushDispatcher.listDeliveries(limit, targetId) });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof PushTargetError) throw new HttpError(error.status, error.message);
          throw new HttpError(400, error instanceof Error ? error.message : 'Invalid query');
        }
      }

      // Batches with live_summary on running jobs
      if (req.method === 'GET' && path === '/api/batches') {
        const summaries = (await listBatches(root)).map(summarize);
        await Promise.all(
          summaries.flatMap(b =>
            b.jobs.map(async job => {
              if (job.status === 'running' && job.run_id) {
                const progress = await readRunProgress(root, job.run_id).catch(() => undefined);
                if (progress) {
                  (job as typeof job & { live_summary?: ReturnType<typeof summarizeLiveRun> }).live_summary =
                    summarizeLiveRun(progress);
                }
              }
            }),
          ),
        );
        return json(res, { batches: summaries, error: lastError, busy: !!worker });
      }

      if (req.method === 'POST' && ['/api/config/agent', '/api/config/contest', '/api/config/codeforces'].includes(path)) {
        const { file, config } = await body(req);
        if (typeof file !== 'string' || !file.trim()) throw new HttpError(400, 'Expected local output path');
        const target = resolve(opts.base ?? process.cwd(), file);
        const saved = path.endsWith('/agent')
          ? await saveAgent(target, config)
          : path.endsWith('/codeforces')
            ? await codeforcesContest(target, config, control.signal)
            : await saveContest(target, config);
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
        return json(res, {
          token,
          jobs: plan.jobs.map(({ agent_id, agent_name, agent_revision, contest_id, data_version, speed_tier, repeat_index, repeat_total }) => ({
            agent_id,
            ...(agent_name ? { agent_name } : {}),
            agent_revision,
            contest_id,
            data_version,
            ...(speed_tier ? { speed_tier } : {}),
            ...(repeat_index !== undefined ? { repeat_index } : {}),
            ...(repeat_total !== undefined ? { repeat_total } : {}),
          })),
        });
      }

      if (req.method === 'POST' && path === '/api/batches') {
        const payload = await body(req);
        const { token, concurrency: rawConcurrency } = payload;
        const plan = typeof token === 'string' ? plans.get(token) : undefined;
        if (!plan) throw new HttpError(400, 'Preview the plan again');
        const concurrency = rawConcurrency !== undefined ? concurrencySchema.parse(rawConcurrency) : undefined;
        const id = await launch(async () => (await enqueue(root, plan, { concurrency })).id, concurrency);
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

      // Coverage-driven matrix endpoint
      if (req.method === 'GET' && path === '/api/coverage') {
        const batches = await listBatches(root); // newest first
        const map = new Map<string, CoverageCell>();
        for (const b of batches) {
          for (let i = b.jobs.length - 1; i >= 0; i--) {
            const job = b.jobs[i]!;
            const planJob = b.plan.jobs[i]!;
            const key = JSON.stringify([planJob.agent_id, planJob.agent_revision, planJob.contest_id, planJob.data_version]);
            let cell = map.get(key);
            if (!cell) {
              cell = {
                agent_id: planJob.agent_id,
                agent_revision: planJob.agent_revision,
                contest_id: planJob.contest_id,
                data_version: planJob.data_version,
                completed_count: 0,
                void_count: 0,
                latest_status: job.status,
                ...(job.run_id ? { latest_run_id: job.run_id } : {}),
              };
              map.set(key, cell);
            }
            if (job.status === 'completed') {
              cell.completed_count++;
              if (job.run_id) {
                const progress = await readRunProgress(root, job.run_id).catch(() => undefined);
                if (progress) {
                  cell.best_score = cell.best_score === undefined ? progress.score : Math.max(cell.best_score, progress.score);
                  cell.max_score = cell.max_score === undefined ? progress.max_score : Math.max(cell.max_score, progress.max_score);
                }
              }
            } else if (job.status === 'void') {
              cell.void_count++;
            }
          }
        }
        return json(res, coverageResponseSchema.parse({ cells: [...map.values()] }));
      }

      // Ranked results (supports Policy C model grouping & multi-scoring)
      if (req.method === 'GET' && path === '/api/results/ranked') {
        const scoringParam = url.searchParams.get('scoring') ?? undefined;
        const scoring = scoringParam ? scoringModeSchema.parse(scoringParam) : undefined;
        const groupByParam = url.searchParams.get('group_by') ?? 'revision';
        const groupBy = z.enum(['revision', 'model']).parse(groupByParam);
        const vendor = url.searchParams.get('vendor') || undefined;
        const family = url.searchParams.get('family') || undefined;
        const batchIdParam = url.searchParams.get('batch_id') || undefined;

        const targetBatches = batchIdParam ? [await getBatch(root, z.uuid().parse(batchIdParam))] : await listBatches(root);
        const seenRunIds = new Set<string>();
        const results: Result[] = [];
        for (const b of targetBatches) {
          for (const job of b.jobs) {
            if (job.status !== 'completed' || !job.run_id || seenRunIds.has(job.run_id)) continue;
            seenRunIds.add(job.run_id);
            const exportedRun = await exportRun(root, job.run_id).catch(() => undefined);
            if (exportedRun) results.push(exportedRun);
          }
        }
        const groups = rankResults(resultBundle(results), { scoring, groupBy, vendor, family });
        return json(res, {
          scoring_mode: scoring ?? null,
          group_by: groupBy,
          groups,
        });
      }

      // Ghost Race
      if (req.method === 'POST' && path === '/api/runs/race') {
        const input = raceRequestSchema.parse(await body(req));
        for (const runId of input.run_ids) {
          if (!await lookupRun(root, runId)) throw new HttpError(404, `Unknown batch run: ${runId}`);
        }
        const race = await buildGhostRace(root, input.run_ids, {
          scoringMode: input.scoring_mode,
          sampleStepMs: input.sample_step_ms,
        });
        return json(res, race);
      }

      // Run-specific routes: progress, events (SSE), logs (full or sliced), replay, cancel
      const run = path.match(/^\/api\/runs\/([0-9a-f-]+)\/(logs|cancel|progress|events|replay)$/);
      if (run) {
        const runId = run[1]!;
        const action = run[2]!;

        if (req.method === 'GET' && action === 'progress') {
          if (!await lookupRun(root, runId)) throw new HttpError(404, 'Unknown batch run');
          return json(res, await readRunProgress(root, runId));
        }

        if (req.method === 'GET' && action === 'events') {
          if (!await lookupRun(root, runId)) throw new HttpError(404, 'Unknown batch run');
          req.setTimeout(0);
          res.setTimeout(0);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': studioCsp,
            'Referrer-Policy': 'no-referrer',
          });
          sseResponses.add(res);
          let closed = false;
          let timer: ReturnType<typeof setInterval> | undefined;
          let lastSent = '';
          let polling = false;

          const cleanup = () => {
            if (closed) return;
            closed = true;
            if (timer) clearInterval(timer);
            sseResponses.delete(res);
            control.signal.removeEventListener('abort', cleanup);
            if (!res.writableEnded && !res.destroyed) res.end();
          };

          req.once('close', cleanup);
          res.once('close', cleanup);
          control.signal.addEventListener('abort', cleanup, { once: true });

          const tick = async () => {
            if (closed || polling) return;
            polling = true;
            try {
              const snapshot = await readRunProgress(root, runId);
              if (closed) return;
              const serialized = JSON.stringify(snapshot);
              if (serialized !== lastSent) {
                lastSent = serialized;
                res.write(`event: progress\ndata: ${serialized}\n\n`);
              } else {
                res.write(': ping\n\n');
              }
              if (snapshot.status === 'completed' || snapshot.status === 'void') {
                cleanup();
              }
            } catch {
              if (!closed) res.write(': ping\n\n');
            } finally {
              polling = false;
            }
          };

          await tick();
          if (!closed) {
            timer = setInterval(() => { void tick(); }, ssePollMs);
            timer.unref();
          }
          return;
        }

        if (req.method === 'GET' && action === 'logs') {
          if (!await lookupRun(root, runId)) throw new HttpError(404, 'Unknown batch run');
          if (url.searchParams.has('stream') || url.searchParams.has('offset') || url.searchParams.has('limit')) {
            const stream = z.enum(['stdout', 'stderr']).parse(url.searchParams.get('stream') ?? 'stdout');
            const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
            const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
            if (!Number.isFinite(offset) || offset < 0) throw new HttpError(400, 'Invalid offset parameter');
            if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new HttpError(400, 'Invalid limit parameter');
            return json(res, await readRunLogSlice(root, runId, stream, offset, limit));
          }
          const [stdout, stderr] = await Promise.all([readRunLog(root, runId, 'stdout'), readRunLog(root, runId, 'stderr')]);
          return json(res, { stdout, stderr });
        }

        if (req.method === 'GET' && action === 'replay') {
          if (!await lookupRun(root, runId)) throw new HttpError(404, 'Unknown batch run');
          const includeSources = ['1', 'true'].includes((url.searchParams.get('include_sources') ?? '').toLowerCase());
          const includeSession = ['1', 'true'].includes((url.searchParams.get('include_session') ?? '').toLowerCase());
          return json(res, await buildRunReplay(root, runId, { includeSources, includeSession }));
        }

        if (req.method === 'POST' && action === 'cancel') {
          await body(req);
          await requestRunCancel(root, runId);
          return json(res, { requested: true }, 202);
        }
      }

      throw new HttpError(404, 'Not found');
    })().catch(error => {
      if (!res.destroyed && !res.headersSent) {
        const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 400;
        const message = error instanceof z.ZodError
          ? error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
          : error instanceof Error ? error.message : 'Request failed';
        json(res, { error: message }, status);
      } else if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      const address = server.address();
      if (!address || typeof address === 'string') return rejectPromise(new Error('Unable to bind Studio'));
      host = `127.0.0.1:${address.port}`;
      resolvePromise();
    });
  });

  return {
    url: `http://${host}`,
    async close() {
      control.abort();
      for (const sse of sseResponses) {
        if (!sse.writableEnded && !sse.destroyed) sse.end();
      }
      sseResponses.clear();
      const closed = new Promise<void>((resolvePromise, rejectPromise) => server.close(error => error ? rejectPromise(error) : resolvePromise()));
      server.closeAllConnections();
      await Promise.all([closed, worker]);
    },
  };
}

export async function serveStudio(root: string, port: number, signal: AbortSignal) {
  const studio = await startStudio(root, port);
  console.log(`Studio: ${studio.url}`);
  try {
    if (!signal.aborted) await new Promise<void>(resolvePromise => signal.addEventListener('abort', () => resolvePromise(), { once: true }));
  } finally { await studio.close(); }
}
