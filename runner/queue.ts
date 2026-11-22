import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Connections } from './connections.js';
import { removeContainer } from './docker.js';
import { OjAccountPool, OjAccounts } from './oj-accounts.js';
import { checkRuntime, executeJob, planSchema, readJson, verifyPlan, type Plan, type PlanInputLoaders, type PlanJob } from './plan.js';
import { readRunProgress } from './progress.js';
import type { PushDispatcher } from './push.js';

const idSchema = z.uuid();
export const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const PER_QUEUED_JOB_TERMINAL_HEADROOM = 256;
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
  pushDrainTimeoutMs?: number;
  execute?: Execute;
  inputLoaders?: Partial<PlanInputLoaders>;
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
function serializeBatchChecked(batch: Batch): string {
  const payload = JSON.stringify(batch, null, 2) + '\n';
  const queuedJobs = batch.jobs.filter(j => j.status === 'queued').length;
  const worstCaseBytes = Buffer.byteLength(payload, 'utf8') + queuedJobs * PER_QUEUED_JOB_TERMINAL_HEADROOM;
  if (worstCaseBytes > MAX_BATCH_BYTES) {
    throw new Error(`Batch exceeds maximum persisted size (${MAX_BATCH_BYTES} bytes)`);
  }
  return payload;
}
async function persist(root: string, batch: Batch) {
  const payload = serializeBatchChecked(batch);
  const target = batchFile(root, batch.id);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, payload, { flag: 'wx', mode: 0o600 });
    await rename(tmp, target);
  } finally { await rm(tmp, { force: true }); }
}
export async function getBatch(root: string, batchId: string) {
  const batch = batchSchema.parse(await readJson(batchFile(root, batchId), MAX_BATCH_BYTES));
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
  // Validate worst-case serialized size BEFORE touching .batches/ so unreadable batches can never be published.
  serializeBatchChecked(batch);
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
  let persistQueue = Promise.resolve();
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

    // Serialize all in-memory batch mutations and batch.json writes so concurrent
    // workers never observe transient mutations or overwrite each other on disk.
    const persistLocked = (mutate?: () => boolean | void) => {
      const next = persistQueue.then(() => {
        const shouldWrite = mutate ? mutate() !== false : true;
        if (!shouldWrite) return;
        return persist(root, batch);
      });
      persistQueue = next.then(() => {}, () => {});
      return next;
    };

    const ojAccounts = options.ojAccounts ?? new OjAccounts();
    const ojPool = options.ojPool ?? new OjAccountPool(ojAccounts);

    const preflight = options.preflight ?? (async (plan: Plan) => {
      await checkRuntime(plan);
      await verifyPlan(plan, true, options.store, ojAccounts, options.inputLoaders);
    });
    const cancelPending = async () => {
      if (!await exists(batchStop(root, batchId))) return false;
      await persistLocked(() => {
        let changed = false;
        for (const job of batch.jobs) {
          if (job.status === 'queued') {
            job.status = 'cancelled';
            job.reason = 'batch_stopped';
            changed = true;
          }
        }
        return changed;
      });
      return true;
    };
    if (await cancelPending() || signal.aborted || !batch.jobs.some(j => j.status === 'queued')) return batch;
    await preflight({ ...batch.plan, jobs: batch.plan.jobs.filter((_job, i) => batch.jobs[i]?.status === 'queued') });

    const pushDrain = new AbortController();
    const pushSignal = AbortSignal.any([signal, pushDrain.signal]);
    const pendingPushes: Promise<unknown>[] = [];
    const fireRunPush = (
      planJob: PlanJob,
      status: Batch['jobs'][number]['status'],
      reason: string | undefined,
      runId: string,
    ) => {
      const dispatcher = options.pushDispatcher;
      if (!dispatcher || pushSignal.aborted) return;
      if (status !== 'completed' && status !== 'void' && status !== 'cancelled' && status !== 'interrupted') return;
      const task = (async () => {
        const progress = await readRunProgress(root, runId).catch(() => undefined);
        if (pushSignal.aborted) return;
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
            ...(reason ? { reason } : {}),
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
          { signal: pushSignal },
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
    let fatalWorkerError: Error | undefined;
    let stopDispatching = false;
    const workerAbort = new AbortController();

    const worker = async () => {
      try {
        while (true) {
          if (stopDispatching || fatalCleanupError || fatalMonitorError || fatalWorkerError || signal.aborted) break;
          if (await exists(batchStop(root, batchId))) {
            stopDispatching = true;
            break;
          }
          // Recheck admission gate after awaiting filesystem check.
          if (stopDispatching || fatalCleanupError || fatalMonitorError || fatalWorkerError || signal.aborted) break;
          const i = queuedIndices[cursor++];
          if (i === undefined) break;
          const job = batch.jobs[i]!;
          if (job.status !== 'queued') continue;
          const planJob = batch.plan.jobs[i]!;

          const runId = randomUUID();
          await persistLocked(() => {
            job.run_id = runId;
            job.status = 'running';
          });
          options.onJobStart?.(runId, join(root, runId));

          const abort = new AbortController();
          const subscribed = AbortSignal.any([signal, workerAbort.signal, abort.signal]);
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
          let nextStatus: Batch['jobs'][number]['status'] = 'void';
          let nextReason: string | undefined = 'runner_error';
          try {
            const result = await (options.execute ?? executeJob)(batch.plan, planJob, {
              out: root,
              runId,
              signal: subscribed,
              store: options.store,
              ojAccounts,
              ojPool,
              loadInputs: options.inputLoaders?.loadInputs,
            });
            cleanupFailed = result.reason === 'sandbox_cleanup_failed';
            if (cleanupFailed) {
              // Immediately close admissions BEFORE awaiting monitor so no sibling can launch another job.
              stopDispatching = true;
              fatalCleanupError ??= new Error(`Could not confirm cleanup for ${runId}; resume the batch after Docker is healthy`);
              nextStatus = 'running';
              nextReason = result.reason;
            } else {
              nextStatus = result.status;
              nextReason = result.reason;
            }
          } catch {
            nextStatus = 'void';
            nextReason = 'runner_error';
          } finally {
            done = true;
            await monitor;
          }

          if (cleanupFailed) {
            // Keep the job marked running in memory and on disk at all times so recovery cleans up the sandbox.
            await persistLocked(() => {
              job.status = 'running';
              job.reason = nextReason;
            });
            break;
          }

          if (monitorError) {
            nextStatus = 'void';
            nextReason = 'queue_monitor_error';
            stopDispatching = true;
            fatalMonitorError ??= new Error('Could not monitor cancellation requests');
          } else if (nextStatus !== 'completed') {
            if (await stopped()) {
              nextStatus = 'cancelled';
              nextReason = 'cancelled';
            } else if (signal.aborted || workerAbort.signal.aborted) {
              nextStatus = 'interrupted';
              nextReason = 'executor_stopped';
            }
          }

          await persistLocked(() => {
            job.status = nextStatus;
            job.reason = nextReason;
          });

          if (monitorError) break;
          fireRunPush(planJob, nextStatus, nextReason, runId);
        }
      } catch (error) {
        stopDispatching = true;
        fatalWorkerError ??= error instanceof Error ? error : new Error(String(error));
        workerAbort.abort(fatalWorkerError);
      }
    };

    const workerCount = Math.min(concurrency, queuedIndices.length);
    const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        fatalWorkerError ??= outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
      }
    }

    if (!fatalWorkerError) {
      await cancelPending().catch(error => {
        fatalWorkerError ??= error instanceof Error ? error : new Error(String(error));
      });
    }

    await persistQueue;

    if (options.pushDispatcher && !fatalCleanupError && !fatalMonitorError && !fatalWorkerError && !pushSignal.aborted) {
      const counts = { completed: 0, void: 0, cancelled: 0, interrupted: 0, queued: 0, running: 0 };
      for (const j of batch.jobs) counts[j.status]++;
      // Emit batch.completed ONLY when the batch is actually terminal (no queued or running jobs left).
      if (counts.queued === 0 && counts.running === 0) {
        const batchStatus = counts.cancelled > 0 || counts.interrupted > 0
          ? 'stopped'
          : counts.void === batch.jobs.length
            ? 'failed'
            : counts.completed === batch.jobs.length
              ? 'completed'
              : 'partial';
        pendingPushes.push(
          options.pushDispatcher.deliver(
            'batch.completed',
            {
              batch_id: batch.id,
              status: batchStatus,
              total: batch.jobs.length,
              completed: counts.completed,
              void: counts.void,
              cancelled: counts.cancelled,
              interrupted: counts.interrupted,
              duration_ms: Math.max(0, Date.now() - dispatchStartMs),
              ...(batch.jobs.length <= 1000 ? {
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
              } : {}),
              timestamp: new Date().toISOString(),
            },
            { signal: pushSignal },
          ).catch(() => {
            // Never fail dispatch on webhook delivery error.
          }),
        );
      }
    }

    if (pendingPushes.length) {
      const drainTimeoutMs = Math.max(50, Math.min(15_000, Math.floor(options.pushDrainTimeoutMs ?? 5_000)));
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let onSignalAbort: (() => void) | undefined;
      const drainLimit = new Promise<void>(resolveDrain => {
        const finish = () => {
          pushDrain.abort();
          resolveDrain();
        };
        onSignalAbort = finish;
        if (signal.aborted) {
          finish();
          return;
        }
        drainTimer = setTimeout(finish, drainTimeoutMs);
        drainTimer.unref();
        signal.addEventListener('abort', finish, { once: true });
      });
      try {
        await Promise.race([Promise.allSettled(pendingPushes), drainLimit]);
      } finally {
        if (drainTimer) clearTimeout(drainTimer);
        if (onSignalAbort) signal.removeEventListener('abort', onSignalAbort);
      }
    }

    if (fatalCleanupError) throw fatalCleanupError;
    if (fatalMonitorError) throw fatalMonitorError;
    if (fatalWorkerError) throw fatalWorkerError;
    return batch;
  } finally {
    await persistQueue.catch(() => {});
    release();
  }
}

export async function readRunLog(root: string, runId: string, stream: 'stdout' | 'stderr') {
  id(runId);
  try { return await readFile(join(root, runId, `agent.${stream}.log`), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
