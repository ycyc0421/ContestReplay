import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { makePlan, verifyPlan } from '../dist/plan.js';
import { dispatch, enqueue, getBatch, requestBatchStop, requestRunCancel } from '../dist/queue.js';
import { startStudio } from '../dist/studio.js';

const image = 'sha256:' + '1'.repeat(64);
const getImage = async () => image;
const noPreflight = async () => {};
const done = ({ runId, out }) => ({ runId, directory: join(out, runId), status: 'completed', reason: 'finish' });
async function eventually(fn) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(35);
  }
  throw new Error('Timed out waiting for test state');
}
async function workspace(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'cr-queue-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const assets = join(tmp, 'demo');
  const root = join(tmp, 'runs');
  await cp(resolve('examples/demo'), assets, { recursive: true });
  const extraAgent = JSON.parse(await readFile(join(assets, 'agent.json'), 'utf8'));
  extraAgent.agent_id = 'another-agent';
  await writeFile(join(assets, 'another-agent.json'), JSON.stringify(extraAgent));
  const extraContest = JSON.parse(await readFile(join(assets, 'contest.json'), 'utf8'));
  extraContest.contest_id = 'another-contest';
  await writeFile(join(assets, 'another-contest.json'), JSON.stringify(extraContest));
  const spec = { schema_version: 1, agents: ['agent.json', 'another-agent.json'], contests: ['contest.json', 'another-contest.json'] };
  const plan = await makePlan(spec, assets, getImage);
  return { root, assets, spec, plan };
}

test('plan expands in stable row order and rejects drift before launching', async t => {
  const { root, assets, plan } = await workspace(t);
  assert.equal(plan.jobs.length, 4);
  assert.equal(plan.jobs[0].agent_id, plan.jobs[1].agent_id);
  assert.equal(plan.jobs[0].contest_id, plan.jobs[2].contest_id);
  await verifyPlan(plan);
  await writeFile(join(assets, 'responses.toml'), 'model="gpt-4.1-2025-04-14"\ntemperature=1\n');
  const batch = await enqueue(root, plan);
  await assert.rejects(dispatch(root, batch.id, new AbortController().signal,
    { preflight: verifyPlan, execute: async () => assert.fail('stale plan ran') }), /regenerate the plan/);
  assert.ok((await getBatch(root, batch.id)).jobs.every(j => j.status === 'queued' && !j.run_id));
});

test('cancelling a live job is independent of logs; other cells still run serially', async t => {
  const { root, plan } = await workspace(t);
  const batch = await enqueue(root, plan);
  const other = await enqueue(root, plan);
  const seen = [];
  const abort = new AbortController();
  const task = dispatch(root, batch.id, abort.signal, { preflight: noPreflight, execute: async (_plan, job, opts) => {
    seen.push(job);
    if (seen.length === 1) {
      await sleep(5000, null, { signal: opts.signal });
      assert.fail('first job was not cancelled');
    }
    return done(opts);
  } });
  try {
    const id = await eventually(async () => (await getBatch(root, batch.id)).jobs[0].run_id);
    await assert.rejects(dispatch(root, other.id, abort.signal, { preflight: noPreflight }), /owns this workspace/);
    await requestRunCancel(root, id);
    const ended = await task;
    assert.deepEqual(ended.jobs.map(j => j.status), ['cancelled', 'completed', 'completed', 'completed']);
    assert.equal(new Set(ended.jobs.map(j => j.run_id)).size, 4);
    assert.deepEqual(seen, plan.jobs);
  } finally { abort.abort(); await task.catch(() => {}); }
});

test('stop a queued batch without creating runs; shutdown preserves later cells', async t => {
  const { root, plan } = await workspace(t);
  const stopped = await enqueue(root, plan);
  await requestBatchStop(root, stopped.id);
  const stoppedJobs = (await getBatch(root, stopped.id)).jobs;
  assert.ok(stoppedJobs.every(job => job.status === 'cancelled' && !job.run_id));
  const batch = await enqueue(root, plan);
  const abort = new AbortController();
  const first = await dispatch(root, batch.id, abort.signal, { preflight: noPreflight, execute: async (_plan, _job, opts) => {
    abort.abort();
    opts.signal.throwIfAborted();
  } });
  assert.deepEqual(first.jobs.map(j => j.status), ['interrupted', 'queued', 'queued', 'queued']);
  const resumed = await dispatch(root, batch.id, new AbortController().signal,
    { preflight: noPreflight, execute: async (_plan, _job, opts) => done(opts) });
  assert.equal(resumed.jobs[0].run_id, first.jobs[0].run_id);
  assert.deepEqual(resumed.jobs.map(j => j.status), ['interrupted', 'completed', 'completed', 'completed']);
});

test('Studio previews a matrix, serves separate live logs and stops a whole batch', async t => {
  const { root, assets, spec } = await workspace(t);
  const studio = await startStudio(root, 0, { base: assets, getImage, queue: {
    preflight: noPreflight,
    execute: async (_plan, _job, opts) => {
      const dir = join(opts.out, opts.runId);
      await mkdir(dir);
      await writeFile(join(dir, 'agent.stdout.log'), '<em>plain text</em>');
      await writeFile(join(dir, 'agent.stderr.log'), 'operator diagnostic');
      await sleep(5000, null, { signal: opts.signal });
      return done(opts);
    },
  } });
  t.after(() => studio.close());
  const get = path => fetch(studio.url + path);
  const post = (path, data, origin = studio.url) => fetch(studio.url + path, { method: 'POST', headers: {
    Origin: origin, 'X-CR-Studio': '1', 'Content-Type': 'application/json',
  }, body: JSON.stringify(data) });
  assert.match(await (await get('/')).text(), /ContestReplay Studio/);
  const script = await (await get('/studio.js')).text();
  assert.doesNotThrow(() => new Function(script));
  assert.equal((await post('/api/plan', spec, 'https://example.org')).status, 403);
  assert.equal((await get('/api/batches').then(r => r.json())).batches.length, 0);
  const plan = await post('/api/plan', spec).then(r => r.json());
  assert.equal(plan.jobs.length, 4);
  assert.equal((await get('/api/batches').then(r => r.json())).batches.length, 0);
  const start = await post('/api/batches', { token: plan.token });
  assert.equal(start.status, 202);
  const batch = await start.json();
  const id = await eventually(async () => (await getBatch(root, batch.id)).jobs[0].run_id);
  const logs = await eventually(async () => {
    const result = await get('/api/runs/' + id + '/logs').then(r => r.json());
    return result.stderr && result;
  });
  assert.deepEqual(logs, { stdout: '<em>plain text</em>', stderr: 'operator diagnostic' });
  assert.equal((await post('/api/batches/' + batch.id + '/stop', {})).status, 202);
  const ended = await eventually(async () => {
    const value = await getBatch(root, batch.id);
    return value.jobs.every(j => j.status === 'cancelled') && value;
  });
  assert.equal(ended.jobs.filter(j => j.run_id).length, 1);
});
