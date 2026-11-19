import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkRuntime, executeJob, planSchema, readJson, verifyPlan, type Plan } from './plan.js';
import { removeContainer } from './docker.js';
import { z } from 'zod';

const idSchema = z.uuid();
const jobSchema = z.strictObject({
  status: z.enum(['queued', 'running', 'completed', 'void', 'cancelled', 'interrupted']),
  run_id: idSchema.optional(), reason: z.string().optional(),
});
const batchSchema = z.strictObject({
  schema_version: z.literal(1), id: idSchema, created_at: z.iso.datetime(),
  plan: planSchema, jobs: z.array(jobSchema),
}).refine(b => b.jobs.length === b.plan.jobs.length && b.jobs.every(j => j.status !== 'running' || j.run_id));
export type Batch = z.infer<typeof batchSchema>;
export type Execute = typeof executeJob;
export type QueueOptions = {
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
    return { ...job, agent_id: input.agent_id, agent_revision: input.agent_revision,
      contest_id: input.contest_id, data_version: input.data_version, harness: input.harness, model_family_id: input.model_family_id };
  });
  return { id: batch.id, created_at: batch.created_at, jobs };
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
export async function enqueue(root: string, plan: Plan) {
  const batch: Batch = { schema_version: 1, id: randomUUID(), created_at: new Date().toISOString(),
    plan: planSchema.parse(plan), jobs: plan.jobs.map(() => ({ status: 'queued' })) };
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
    const preflight = options.preflight ?? (async (plan: Plan) => {
      await checkRuntime(plan);
      await verifyPlan(plan, true);
    });
    const cancelPending = async () => {
      if (!await exists(batchStop(root, batchId))) return false;
      for (const job of batch.jobs) if (job.status === 'queued') { job.status = 'cancelled'; job.reason = 'batch_stopped'; }
      await persist(root, batch);
      return true;
    };
    if (await cancelPending() || signal.aborted || !batch.jobs.some(j => j.status === 'queued')) return batch;
    await preflight({ ...batch.plan, jobs: batch.plan.jobs.filter((_job, i) => batch.jobs[i]?.status === 'queued') });
    for (const [i, job] of batch.jobs.entries()) {
      if (await cancelPending() || signal.aborted) break;
      if (job.status !== 'queued') continue;
      const runId = randomUUID();
      job.run_id = runId;
      job.status = 'running';
      await persist(root, batch);
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
        const result = await (options.execute ?? executeJob)(batch.plan, batch.plan.jobs[i]!, { out: root, runId, signal: subscribed });
        cleanupFailed = result.reason === 'sandbox_cleanup_failed';
        job.status = result.status;
        job.reason = result.reason;
      } catch {
        job.status = 'void'; job.reason = 'runner_error';
      } finally { done = true; await monitor; }
      if (monitorError) { job.status = 'void'; job.reason = 'queue_monitor_error'; }
      if (job.status !== 'completed' && !monitorError && !cleanupFailed) {
        if (await stopped()) { job.status = 'cancelled'; job.reason = 'cancelled'; }
        else if (signal.aborted) { job.status = 'interrupted'; job.reason = 'executor_stopped'; }
      }
      if (cleanupFailed) {
        // Keep the job marked running until recovery can confirm removal;
        // don't dispatch another job on top of a possibly live sandbox.
        job.status = 'running';
        await persist(root, batch);
        throw new Error(`Could not confirm cleanup for ${runId}; resume the batch after Docker is healthy`);
      }
      await persist(root, batch);
      if (monitorError) throw new Error('Could not monitor cancellation requests');
    }
    await cancelPending();
    return batch;
  } finally { release(); }
}

export async function readRunLog(root: string, runId: string, stream: 'stdout' | 'stderr') {
  id(runId);
  try { return await readFile(join(root, runId, `agent.${stream}.log`), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
