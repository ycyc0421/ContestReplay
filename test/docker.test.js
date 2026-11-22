import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInputs } from '../dist/config.js';
import { inspectImage } from '../dist/docker.js';
import { runBench } from '../dist/run.js';
import { makePlan } from '../dist/plan.js';
import { dispatch, enqueue, getBatch, requestRunCancel } from '../dist/queue.js';
import { setTimeout as delay } from 'node:timers/promises';

const enabled = process.env.CR_TEST_DOCKER === '1';
const model = 'gpt-4.1-2025-04-14';
const answer = (id, name, args) => ({ model, status: 'completed', output: [
  { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) },
] });

test('fresh Docker containers run MCP turns, redact failed scores and clean up', { skip: !enabled, timeout: 30_000 }, async () => {
  const inputs = await loadInputs('examples/demo/contest.json', 'examples/demo/agent.json');
  const image = await inspectImage();
  const out = await mkdtemp(join(tmpdir(), 'cr-docker-test-'));
  const read = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  const gone = id => assert.equal(execFileSync('docker', ['ps', '-a', '-q', '--filter', 'label=org.contestreplay.run='+id], { encoding: 'utf8' }).trim(), '');
  try {
    const signal = new AbortController().signal;
    let turn = 0;
    let id;
    const ok = await runBench(inputs, { out, image, signal, onStart: runId => { id = runId; }, infer: async history => {
      assert.equal(history[0].content[0].file_data, 'data:application/pdf;base64,' + inputs.pdf.toString('base64'));
      turn++;
      if (turn === 1) {
        const [container] = JSON.parse(execFileSync('docker', ['inspect', 'cr-'+id], { encoding: 'utf8' }));
        assert.equal(container.HostConfig.NetworkMode, 'none');
        assert.equal(container.HostConfig.ReadonlyRootfs, true);
        assert.equal(container.Config.User, '1000:1000');
        assert.ok(!container.Config.Env.some(value => value.startsWith('OPENAI_API_KEY=')));
        assert.deepEqual(container.Mounts.map(m => [m.Destination, m.RW]), [['/inputs/problems.pdf', false]]);
        const probe = execFileSync('docker', ['exec', 'cr-'+id, 'node', '-e',
          'console.log(JSON.stringify(Object.keys(require("node:os").networkInterfaces())))'], { encoding: 'utf8' });
        assert.ok(JSON.parse(probe).every(name => name === 'lo'));
        return answer('a', 'submit', { problem_id: '1', answer: '2' });
      }
      if (turn === 2) {
        assert.equal(JSON.parse(history.at(-1).output).verdict, 'wrong_answer');
        return answer('b', 'submit', { problem_id: '1', answer: '3' });
      }
      assert.equal(JSON.parse(history.at(-1).output).verdict, 'accepted');
      return answer('c', 'finish', {});
    }});
    assert.equal(ok.status, 'completed', ok.reason);
    const logs = await read(join(ok.directory, 'events.jsonl'));
    assert.deepEqual(logs.filter(e => e.type === 'submission_judged').map(e => e.verdict), ['wrong_answer', 'accepted']);
    assert.ok(logs.some(e => e.type === 'model_response' && typeof e.duration_ms === 'number'));
    assert.equal(logs.at(-1).score, 3);
    const runMeta = JSON.parse(await readFile(join(ok.directory, 'run.json'), 'utf8'));
    assert.equal(runMeta.protocol_preset, 'short');
    assert.equal(runMeta.scoring_mode, 'last_ac');
    assert.deepEqual(runMeta.problems, [{ id: '1', max_points: 3 }, { id: '2', max_points: 5 }]);
    gone(ok.runId);
    const bad = await runBench(inputs, { out, image, signal, infer: async history => {
      if (history.length === 1) return answer('a', 'submit', { problem_id: '2', answer: '12' });
      throw new Error('simulated network error');
    }});
    assert.notEqual(bad.runId, ok.runId);
    assert.equal(bad.status, 'void');
    assert.equal(bad.reason, 'model_request_failed');
    const failed = await read(join(bad.directory, 'events.jsonl'));
    assert.ok(failed.some(e => e.type === 'submission_judged' && e.verdict === 'accepted'));
    assert.equal(failed.at(-1).score, null);
    gone(bad.runId);
    const abort = new AbortController();
    const cancelled = await runBench(inputs, { out, image, signal: abort.signal, infer: async (_history, signal) => {
      abort.abort();
      assert.ok(signal.aborted);
      signal.throwIfAborted();
    }});
    assert.equal(cancelled.status, 'void');
    assert.equal(cancelled.reason, 'interrupted');
    assert.match(await readFile(join(cancelled.directory, 'agent.stdout.log'), 'utf8'), /model turn 1/);
    assert.equal(await readFile(join(cancelled.directory, 'agent.stderr.log'), 'utf8'), '');
    gone(cancelled.runId);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('a queued Docker run can be stopped while inference is stalled, and the next job completes', { skip: !enabled, timeout: 30_000 }, async () => {
  const inputs = await loadInputs('examples/demo/contest.json', 'examples/demo/agent.json');
  const basePlan = await makePlan({
    schema_version: 2,
    cells: [{ agent: inputs.agentPath, contest: inputs.contestPath, repeats: 2 }],
  }, process.cwd());
  const plan = basePlan;
  const out = await mkdtemp(join(tmpdir(), 'cr-docker-queue-test-'));
  const abort = new AbortController();
  let task;
  try {
    const batch = await enqueue(out, plan);
    let attempts = 0;
    let entered;
    const firstRequest = new Promise(resolve => { entered = resolve; });
    task = dispatch(out, batch.id, abort.signal, { preflight: async () => {}, execute: async (_plan, _job, opts) => {
      const attempt = ++attempts;
      return runBench(inputs, { ...opts, image: plan.jobs[0].image, infer: async (_history, signal) => {
        if (attempt === 1) {
          entered(opts.runId);
          await delay(5_000, null, { signal });
          assert.fail('First request was not cancelled');
        }
        return answer('finish', 'finish', {});
      } });
    } });
    const id = await Promise.race([firstRequest, task.then(() => assert.fail('No model request'))]);
    assert.equal((await getBatch(out, batch.id)).jobs[0].status, 'running');
    const stdout = join(out, id, 'agent.stdout.log');
    let log = '';
    for (let attempt = 0; attempt < 20 && !log.includes('model turn 1'); attempt++) {
      log = await readFile(stdout, 'utf8');
      if (!log.includes('model turn 1')) await delay(25);
    }
    assert.match(log, /model turn 1/);
    await requestRunCancel(out, id);
    const result = await task;
    assert.deepEqual(result.jobs.map(job => job.status), ['cancelled', 'completed']);
    for (const job of result.jobs) {
      assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', 'label=org.contestreplay.run='+job.run_id], { encoding: 'utf8' }).trim(), '');
    }
  } finally {
    abort.abort();
    await task?.catch(() => {});
    await rm(out, { recursive: true, force: true });
  }
});
