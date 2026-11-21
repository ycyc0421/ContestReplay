import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { loadContest } from './config.js';
import type { Connections } from './connections.js';
import { removeContainer } from './docker.js';
import { OjAccountPool, type OjAccounts } from './oj-accounts.js';
import { checkRuntime, executeJob, planSchema, readJson, verifyPlan, type Plan, type PlanJob } from './plan.js';
import { readRunProgress } from './progress.js';
import type { PushDispatcher } from './push.js';

const idSchema = z.uuid();
export const concurrencySchema = z.number().int().min(1).max(8);
const jobSchema = z.strictObject({
  status: z.enum(['queued', 'running', 'completed', 'void', 'cancelled', 'interrupted']),
  run_id: idSchema.optional(),
  reason: z.string().optional(),
});
const batchSchema = z.strictObject({
  schema_version: z.literal(1),
  id: idSchema,
  created_at: z.iso.datetime(),
  concurrency: concurrencySchema.optional(),
  plan: planSchema,
  jobs: z.array(jobSchema),
}).refine(b => b.jobs.length === b.plan.jobs.length && b.jobs.every(j => j.status !== 'running' || j.run_id));
export type Batch = z.infer<typeof batchSchema>;
export type Execute = typeof executeJob;
export type QueueOptions = {
  store?: Connections;
  concurrency?: number;
  ojAccounts?: OjAccounts;
  ojPool?: OjAccountPool;
  pushDispatcher?: PushDispatcher;
  execute?: Execute;
  preflight?: (plan: Plan) => Promise<unknown>;
  recover?: (id: string) => Promise<void>;
  onJobStart?: (id: string, directory: string) => void;
};
export function workdir(value = 'runs') { return resolve(value); }
function id(value: string) { return idSchema.parse(value); }
const batchesDir = (root: string) => join(root, '.batches');
const batchFile = (root: string, batchId: string) => join(batchesDir(root), `${id(batchId)}.json`);
const batchStop = (root: string, batchId: string) => join(batchesDir(root), `${id(batchId)}.stop`);
const runStop = (root: string, runId: string) => join(batchesDir(root), `${id(runId)}.cancel`);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function exists(path: string) {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function persist(root: string, batch: Batch) {
  const target = batchFile(root, batch.id);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(batch, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tmp, target);
  } finally { await rm(tmp, { force: true }); }
}
export async function getBatch(root: string, batchId: string) {
  const batch = batchSchema.parse(await readJson(batchFile(root, batchId)));
  if (batch.id !== batchId) throw new Error('Batch ID does not match its file');
  if (await exists(batchStop(root, batchId))) {
    for (const job of batch.jobs) if (job.status === 'queued') {
      job.status = 'cancelled'; job.reason = 'batch_stopped';
    }
  }
  return batch;
}
export async function listBatches(root: string) {
  let entries: string[];
  try { entries = await readdir(batchesDir(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const batches = [];
  for (const entry of entries) {
    if (entry.endsWith('.json') && idSchema.safeParse(entry.slice(0, -5)).success) {
      batches.push(await getBatch(root, entry.slice(0, -5)));
    }
  }
  return batches.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export function summarize(batch: Batch) {
  const jobs = batch.jobs.map((job, i) => {
    const input = batch.plan.jobs[i]!;
    return {
      ...job,
      agent_id: input.agent_id,
      ...(input.agent_name ? { agent_name: input.agent_name } : {}),
      agent_revision: input.agent_revision,
      contest_id: input.contest_id,
      data_version: input.data_version,
      harness: input.harness,
      ...(input.model_family_id ? { model_family_id: input.model_family_id } : {}),
      ...(input.speed_tier ? { speed_tier: input.speed_tier } : {}),
      ...(input.repeat_index !== undefined ? { repeat_index: input.repeat_index } : {}),
      ...(input.repeat_total !== undefined ? { repeat_total: input.repeat_total } : {}),
    };
  });
  return {
    id: batch.id,
    created_at: batch.created_at,
    ...(batch.concurrency !== undefined ? { concurrency: batch.concurrency } : {}),
    jobs,
  };
}
export async function lookupRun(root: string, runId: string) {
  id(runId);
  for (const batch of await listBatches(root)) {
    const job = batch.jobs.find(job => job.run_id === runId);
    if (job) return { job, batchId: batch.id };
  }
}
export async function requestRunCancel(root: string, runId: string) {
  const run = await lookupRun(root, runId);
  if (!run || run.job.status !== 'running') throw new Error('No active batch job with this run ID');
  await writeFile(runStop(root, runId), '', { mode: 0o600 });
}
export async function requestBatchStop(root: string, batchId: string) {
  const batch = await getBatch(root, batchId);
  if (!batch.jobs.some(j => j.status === 'running' || j.status === 'queued')) throw new Error('Batch has no unfinished jobs');
  await writeFile(batchStop(root, batchId), '', { mode: 0o600 });
}
export async function enqueue(root: string, plan: Plan, opts: { concurrency?: number } = {}) {
  const concurrency = opts.concurrency !== undefined ? concurrencySchema.parse(opts.concurrency) : undefined;
  const batch: Batch = {
    schema_version: 1,
    id: randomUUID(),
    created_at: new Date().toISOString(),
    ...(concurrency !== undefined ? { concurrency } : {}),
    plan: planSchema.parse(plan),
    jobs: plan.jobs.map(() => ({ status: 'queued' })),
  };
  await mkdir(batchesDir(root), { recursive: true, mode: 0o700 });
  await persist(root, batch);
  return batch;
}

// Lock the actual open file description in the child, then keep the parent's
// copy of the fd open. Linux releases it even when the owner is killed.
async function lock(root: string) {
  await mkdir(batchesDir(root), { recursive: true, mode: 0o700 });
  const fd = openSync(join(batchesDir(root), '.executor.lock'), 'a', 0o600);
  try {
    const result = spawnSync('flock', ['-n', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    if (result.status === 75) throw new Error('Another batch executor owns this workspace');
    if (result.error || result.status !== 0) throw new Error('Local queue requires Linux flock (util-linux)');
  } catch (error) { closeSync(fd); throw error; }
  return () => closeSync(fd);
}

export async function dispatch(root: string, batchId: string, signal: AbortSignal, options: QueueOptions = {}) {
  id(batchId);
  const dispatchStartMs = Date.now();
  const release = await lock(root);
  try {
    // A running job left by a previous lock owner was interrupted, not queued.
    // Stop its sandbox before allowing any new job to launch in this workspace.
    for (const stale of await listBatches(root)) {
      let changed = false;
      for (const job of stale.jobs) {
        if (job.status !== 'running') continue;
        if (options.recover) await options.recover(job.run_id!);
        else { await removeContainer(`render-${job.run_id!}`); await removeContainer(job.run_id!); }
        if (await exists(runStop(root, job.run_id!)) || await exists(batchStop(root, stale.id))) {
          job.status = 'cancelled'; job.reason = 'cancelled';
        } else { job.status = 'interrupted'; job.reason = 'executor_lost'; }
        changed = true;
      }
      if (changed) await persist(root, stale);
    }
    const batch = await getBatch(root, batchId);
    const concurrency = concurrencySchema.parse(options.concurrency ?? batch.concurrency ?? 1);
    if (options.concurrency !== undefined && batch.concurrency !== concurrency) {
      batch.concurrency = concurrency;
    }

    // Serialize all batch.json writes so concurrent workers never overwrite each other.
    let persistQueue = Promise.resolve();
    const persistLocked = () => {
      const next = persistQueue.then(() => persist(root, batch));
      persistQueue = next.then(() => {}, () => {});
      return next;
    };

    const preflight = options.preflight ?? (async (plan: Plan) => {
      await checkRuntime(plan);
      await verifyPlan(plan, true, options.store, options.ojAccounts);
    });
    const cancelPending = async () => {
      if (!await exists(batchStop(root, batchId))) return false;
      let changed = false;
      for (const job of batch.jobs) {
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.reason = 'batch_stopped';
          changed = true;
        }
      }
      if (changed) await persistLocked();
      return true;
    };
    if (await cancelPending() || signal.aborted || !batch.jobs.some(j => j.status === 'queued')) return batch;
    await preflight({ ...batch.plan, jobs: batch.plan.jobs.filter((_job, i) => batch.jobs[i]?.status === 'queued') });

    const ojPool = options.ojPool ?? (options.ojAccounts ? new OjAccountPool(options.ojAccounts) : undefined);
    const contestProblemIdsCache = new Map<string, string[] | undefined>();
    const loadValidProblemIds = async (contestPath: string): Promise<string[] | undefined> => {
      if (contestProblemIdsCache.has(contestPath)) return contestProblemIdsCache.get(contestPath);
      try {
        const loaded = await loadContest(contestPath);
        const ids = loaded.contest.problems.map(p => p.id);
        contestProblemIdsCache.set(contestPath, ids);
        return ids;
      } catch {
        contestProblemIdsCache.set(contestPath, undefined);
        return undefined;
      }
    };

    const pendingPushes: Promise<unknown>[] = [];
    const fireRunPush = (planJob: PlanJob, jobState: Batch['jobs'][number], runId: string) => {
      const dispatcher = options.pushDispatcher;
      if (!dispatcher) return;
      const status = jobState.status;
      if (status !== 'completed' && status !== 'void' && status !== 'cancelled' && status !== 'interrupted') return;
      const task = (async () => {
        const validProblemIds = await loadValidProblemIds(planJob.contest_path);
        const progress = await readRunProgress(root, runId).catch(() => undefined);
        await dispatcher.deliver(
          'run.completed',
          {
            run_id: runId,
            contest_id: planJob.contest_id,
            ...(progress?.contest_title ? { contest_title: progress.contest_title } : {}),
            data_version: planJob.data_version,
            agent_id: planJob.agent_id,
            ...(planJob.agent_name ? { agent_name: planJob.agent_name } : {}),
            agent_revision: planJob.agent_revision,
            status,
            ...(jobState.reason ? { reason: jobState.reason } : {}),
            ...(progress ? {
              score: status === 'completed' ? progress.score : null,
              max_score: progress.max_score,
              solved_count: progress.solved_count,
              problem_count: progress.problem_count,
              elapsed_ms: progress.elapsed_ms,
              submissions_used: progress.submissions_used,
            } : {}),
            timestamp: new Date().toISOString(),
          },
          { ...(validProblemIds ? { validProblemIds } : {}) },
        );
      })().catch(() => {
        // Push delivery failures must never fail or block runs.
      });
      pendingPushes.push(task);
    };

    const queuedIndices = batch.jobs.map((j, idx) => (j.status === 'queued' ? idx : -1)).filter(idx => idx >= 0);
    let cursor = 0;
    let fatalCleanupError: Error | undefined;
    let fatalMonitorError: Error | undefined;
    let stopDispatching = false;

    const worker = async () => {
      while (true) {
        if (stopDispatching || fatalCleanupError || fatalMonitorError || signal.aborted) break;
        if (await exists(batchStop(root, batchId))) {
          stopDispatching = true;
          break;
        }
        const i = queuedIndices[cursor++];
        if (i === undefined) break;
        const job = batch.jobs[i]!;
        if (job.status !== 'queued') continue;
        const planJob = batch.plan.jobs[i]!;

        const runId = randomUUID();
        job.run_id = runId;
        job.status = 'running';
        await persistLocked();
        options.onJobStart?.(runId, join(root, runId));

        const abort = new AbortController();
        const subscribed = AbortSignal.any([signal, abort.signal]);
        const stopped = async () => await exists(runStop(root, runId)) || await exists(batchStop(root, batchId));
        let done = false;
        let monitorError: unknown;
        const monitor = (async () => {
          try {
            while (!done && !subscribed.aborted) {
              if (await stopped()) { abort.abort(); break; }
              await sleep(150);
            }
          } catch (error) { monitorError = error; abort.abort(); }
        })();

        let cleanupFailed = false;
        try {
          const result = await (options.execute ?? executeJob)(batch.plan, planJob, {
            out: root,
            runId,
            signal: subscribed,
            store: options.store,
            ojAccounts: options.ojAccounts,
            ojPool,
          });
          cleanupFailed = result.reason === 'sandbox_cleanup_failed';
          job.status = result.status;
          job.reason = result.reason;
        } catch {
          job.status = 'void';
          job.reason = 'runner_error';
        } finally {
          done = true;
          await monitor;
        }

        if (monitorError) {
          job.status = 'void';
          job.reason = 'queue_monitor_error';
        }
        if (job.status !== 'completed' && !monitorError && !cleanupFailed) {
          if (await stopped()) { job.status = 'cancelled'; job.reason = 'cancelled'; }
          else if (signal.aborted) { job.status = 'interrupted'; job.reason = 'executor_stopped'; }
        }
        if (cleanupFailed) {
          // Keep the job marked running until recovery can confirm removal;
          // prevent workers from launching additional jobs on top of a possibly live sandbox.
          job.status = 'running';
          stopDispatching = true;
          fatalCleanupError ??= new Error(`Could not confirm cleanup for ${runId}; resume the batch after Docker is healthy`);
          await persistLocked();
          break;
        }

        await persistLocked();
        if (monitorError) {
          stopDispatching = true;
          fatalMonitorError ??= new Error('Could not monitor cancellation requests');
          break;
        }
        fireRunPush(planJob, job, runId);
      }
    };

    const workerCount = Math.min(concurrency, queuedIndices.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    await cancelPending();

    if (options.pushDispatcher && !fatalCleanupError && !fatalMonitorError) {
      const counts = { completed: 0, void: 0, cancelled: 0, interrupted: 0, queued: 0, running: 0 };
      for (const j of batch.jobs) counts[j.status]++;
      const batchStatus = counts.cancelled > 0 || counts.interrupted > 0
        ? 'stopped'
        : counts.void === batch.jobs.length
          ? 'failed'
          : counts.completed === batch.jobs.length
            ? 'completed'
            : 'partial';
      pendingPushes.push(
        options.pushDispatcher.deliver('batch.completed', {
          batch_id: batch.id,
          status: batchStatus,
          total: batch.jobs.length,
          completed: counts.completed,
          void: counts.void,
          cancelled: counts.cancelled,
          interrupted: counts.interrupted,
          duration_ms: Math.max(0, Date.now() - dispatchStartMs),
          jobs: batch.jobs.map((j, idx) => {
            const p = batch.plan.jobs[idx]!;
            return {
              ...(j.run_id ? { run_id: j.run_id } : {}),
              agent_id: p.agent_id,
              ...(p.agent_name ? { agent_name: p.agent_name } : {}),
              contest_id: p.contest_id,
              data_version: p.data_version,
              status: j.status,
              ...(j.reason ? { reason: j.reason } : {}),
            };
          }),
          timestamp: new Date().toISOString(),
        }).catch(() => {
          // Never fail dispatch on webhook delivery error.
        }),
      );
    }

    if (pendingPushes.length) {
      await Promise.allSettled(pendingPushes);
    }

    if (fatalCleanupError) throw fatalCleanupError;
    if (fatalMonitorError) throw fatalMonitorError;
    return batch;
  } finally { release(); }
}

export async function readRunLog(root: string, runId: string, stream: 'stdout' | 'stderr') {
  id(runId);
  try { return await readFile(join(root, runId, `agent.${stream}.log`), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
