import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadContest, loadInputs, resolveContest } from '../dist/config.js';
import { Connections } from '../dist/connections.js';
import { JudgeInfrastructureError, OjAccountPool, OjAccounts } from '../dist/judges/index.js';
import { match } from '../dist/match.js';
import { makePlan, verifyPlan } from '../dist/plan.js';
import { PushDispatcher, PushTargets } from '../dist/push.js';
import { dispatch, enqueue, getBatch, requestBatchStop, requestRunCancel } from '../dist/queue.js';

const FAKE_IMAGE = 'sha256:' + 'a'.repeat(64);
const getImage = async () => FAKE_IMAGE;
const DEMO_PDF = resolve('examples/demo/problems.pdf');
const DEMO_AGENT = resolve('examples/demo/codex.toml');

async function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function baseContestDoc(judge, extra = {}) {
  return {
    schema_version: 2,
    contest_id: 'multi-oj-demo',
    data_version: 1,
    title: 'Multi-OJ Demo',
    source: { name: 'Fixture' },
    materials: { entrypoint: { kind: 'pdf', path: DEMO_PDF } },
    problems: [
      { id: 'P1', max_points: 100 },
      { id: 'P2', max_points: 100 },
    ],
    judge,
    rules: { time_limit_ms: 600_000, max_submissions: 50, scoring_mode: 'ioi' },
    ...extra,
  };
}

test('multi-OJ config validates all 5 backends, problem_map uniqueness, and deterministic contestRevision', async t => {
  const dir = await makeTempDir('cr-multi-oj-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contestPath = join(dir, 'contest.json');

  // Codeforces with pool/account_id (no handle required), gym flag
  const cfPool = await resolveContest(
    baseContestDoc({
      kind: 'codeforces',
      contest_id: 104000,
      gym: true,
      pool: 'cf-main',
      languages: { cpp20: '89', cpp17: 54 },
      problem_map: { P1: 'A', P2: 'B' },
    }),
    contestPath,
  );
  const cfOtherAccount = await resolveContest(
    baseContestDoc({
      kind: 'codeforces',
      contest_id: 104000,
      gym: true,
      account_id: 'acc-alt',
      handle: 'ignored-handle',
      languages: { cpp17: 54, cpp20: '89' },
      problem_map: { P1: 'A', P2: 'B' },
    }),
    contestPath,
  );
  assert.equal(cfPool.contestRevision, cfOtherAccount.contestRevision, 'account_id/pool/handle must not alter contestRevision');

  // Regular vs Gym must change contestRevision
  const cfRegular = await resolveContest(
    baseContestDoc({
      kind: 'codeforces',
      contest_id: 104000,
      gym: false,
      pool: 'cf-main',
      languages: { cpp20: '89', cpp17: 54 },
      problem_map: { P1: 'A', P2: 'B' },
    }),
    contestPath,
  );
  assert.notEqual(cfPool.contestRevision, cfRegular.contestRevision);

  // Codeforces with none of handle / account_id / pool must be rejected
  await assert.rejects(
    resolveContest(
      baseContestDoc({
        kind: 'codeforces',
        contest_id: 1900,
        languages: { cpp20: '89' },
        problem_map: { P1: 'A', P2: 'B' },
      }),
      contestPath,
    ),
    /Invalid config/,
  );

  // QOJ backend
  const qoj = await resolveContest(
    baseContestDoc({
      kind: 'qoj',
      contest_id: 1420,
      pool: 'qoj-pool',
      languages: { cpp20: 'C++20' },
      problem_map: { P1: 'qoj:7001', P2: 'qoj:7002' },
    }),
    contestPath,
  );
  assert.equal(qoj.contest.judge.kind, 'qoj');

  // VJudge backend with custom settlement_ms and direct upstream refs
  const vj = await resolveContest(
    baseContestDoc({
      kind: 'vjudge',
      account_id: 'vj-1',
      languages: { cpp20: 'C++20' },
      problem_map: { P1: 'CodeForces-1234A', P2: 'AtCoder-abc300_a' },
      settlement_ms: 420_000,
    }),
    contestPath,
  );
  assert.equal(vj.contest.judge.kind, 'vjudge');
  assert.equal(vj.contest.judge.settlement_ms, 420_000);

  // Hydro backend with domain and live_contest
  const hydroA = await resolveContest(
    baseContestDoc({
      kind: 'hydro',
      base_url: 'https://oj.example.org',
      domain: 'oi',
      contest_id: 'c100',
      live_contest: false,
      account_id: 'hydro-1',
      languages: { cpp20: 'cc.cc20o2' },
      problem_map: { P1: 'P1001', P2: 'P1002' },
    }),
    contestPath,
  );
  const hydroB = await resolveContest(
    baseContestDoc({
      kind: 'hydro',
      base_url: 'https://oj.example.org',
      domain: 'acm',
      contest_id: 'c100',
      account_id: 'hydro-1',
      languages: { cpp20: 'cc.cc20o2' },
      problem_map: { P1: 'P1001', P2: 'P1002' },
    }),
    contestPath,
  );
  assert.notEqual(hydroA.contestRevision, hydroB.contestRevision, 'Hydro domain must affect contestRevision');

  // Duplicate problem_map target and empty languages must be rejected across remote backends
  await assert.rejects(
    resolveContest(
      baseContestDoc({
        kind: 'qoj',
        pool: 'qoj',
        languages: { cpp20: 'C++20' },
        problem_map: { P1: '7001', P2: '7001' },
      }),
      contestPath,
    ),
    /duplicate qoj target/i,
  );
  await assert.rejects(
    resolveContest(
      baseContestDoc({
        kind: 'hydro',
        base_url: 'https://oj.example.org',
        languages: {},
      }),
      contestPath,
    ),
    /requires explicit problems and language IDs/i,
  );
});

test('match() supports unified ProgramJudge across QOJ/Hydro, accumulates IOI partial scores, and marks JudgeInfrastructureError as void', async t => {
  const dir = await makeTempDir('cr-match-ioi-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contestFile = join(dir, 'qoj-contest.json');
  await writeFile(
    contestFile,
    JSON.stringify(
      baseContestDoc({
        kind: 'qoj',
        contest_id: 99,
        handle: 'tester',
        languages: { cpp20: 'C++20' },
        problem_map: { P1: '7001', P2: '7002' },
      }),
    ),
  );
  const inputs = await loadInputs(contestFile, DEMO_AGENT);

  // 1. IOI partial score accumulation & clamping
  let seq = 0;
  const verdictQueue = new Map();
  const unifiedJudge = {
    kind: 'qoj',
    settlementMs: 180_000,
    async submit() { return `sub-${++seq}`; },
    async verdicts(ids) {
      const out = new Map();
      for (const id of ids) {
        if (verdictQueue.has(id)) out.set(id, verdictQueue.get(id));
      }
      return out;
    },
  };
  let now = 0;
  const events = [];
  const m = match(inputs, e => events.push({ elapsed: now, ...e }), unifiedJudge, () => now, 5);
  try {
    now = 10;
    const s1 = m.submit({ problem_id: 'P1', language: 'cpp20', source: '// 40 pts' });
    assert.equal(s1.verdict, 'pending');
    verdictQueue.set('sub-1', { remote_submission_id: 'sub-1', verdict: 'partial', raw_verdict: '40', score: 40, max_score: 100, final: true });
    await m.settle(AbortSignal.timeout(1000));
    assert.equal(m.score(), 40);

    // Higher partial score (135 gets clamped to max_points=100)
    now = 20;
    m.submit({ problem_id: 'P1', language: 'cpp20', source: '// 135 -> 100' });
    verdictQueue.set('sub-2', { remote_submission_id: 'sub-2', verdict: 'partial', raw_verdict: '135', score: 135, max_score: 100, final: true });
    await m.settle(AbortSignal.timeout(1000));
    assert.equal(m.score(), 100);

    // Lower subsequent submission on P1 must NOT reduce bestScore
    now = 30;
    m.submit({ problem_id: 'P1', language: 'cpp20', source: '// 25 pts' });
    verdictQueue.set('sub-3', { remote_submission_id: 'sub-3', verdict: 'partial', raw_verdict: '25', score: 25, max_score: 100, final: true });
    await m.settle(AbortSignal.timeout(1000));
    assert.equal(m.score(), 100);

    // Accepted on P2 awards full max_points (100)
    now = 40;
    m.submit({ problem_id: 'P2', language: 'cpp20', source: '// AC' });
    verdictQueue.set('sub-4', { remote_submission_id: 'sub-4', verdict: 'accepted', raw_verdict: 'Accepted', final: true });
    await m.settle(AbortSignal.timeout(1000));
    assert.equal(m.score(), 200);

    const judged = events.filter(e => e.type === 'submission_judged');
    assert.equal(judged.length, 4);
    assert.equal(judged[0].score, 40);
    assert.equal(judged[0].max_score, 100);
    assert.equal(judged[1].score, 100);
    assert.equal(judged[3].score, 100);
    assert.equal(judged[3].verdict, 'accepted');
  } finally {
    await m.dispose();
  }

  // 2. JudgeInfrastructureError from verdicts() marks failure (judge_error), never wrong_answer
  const failingJudge = {
    kind: 'qoj',
    settlementMs: 180_000,
    async submit() { return 'sub-fail-1'; },
    async verdicts() {
      throw new JudgeInfrastructureError('auth_expired', 'Session expired', { platform: 'qoj', status: 403 });
    },
  };
  const failEvents = [];
  const mFail = match(inputs, e => failEvents.push(e), failingJudge, () => 0, 5);
  try {
    mFail.submit({ problem_id: 'P1', language: 'cpp20', source: '// test' });
    await assert.rejects(mFail.settle(AbortSignal.timeout(1000)), /did not settle/i);
    assert.equal(mFail.failed(), true);
    assert.ok(failEvents.some(e => e.type === 'judge_error'));
    assert.equal(failEvents.some(e => e.type === 'submission_judged' && e.verdict === 'wrong_answer'), false);
  } finally {
    await mFail.dispose();
  }
});

test('makePlan repeats expansion, verifyPlan OJ readiness, parallel dispatch concurrency, OJ pool leasing, and push webhooks', async t => {
  const dir = await makeTempDir('cr-parallel-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsRoot = join(dir, 'runs');
  const store = new Connections(join(dir, 'connections'));
  const ojAccounts = new OjAccounts(join(dir, 'oj-accounts'));
  const pushTargets = new PushTargets(join(dir, 'push-targets'));

  // Create provider + agent + QOJ contest using a 2-account pool
  await store.create({
    id: 'openai-main',
    label: 'OpenAI',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-test-parallel-secret',
  });
  const agentFile = join(dir, 'agent.toml');
  await writeFile(
    agentFile,
    [
      'kind = "contestreplay.dev/agent"',
      'schema_version = 1',
      'id = "solver-a"',
      'name = "Solver A"',
      'model = "gpt-5.4"',
      'provider = "openai-main"',
      '',
      '[harness]',
      'kind = "codex"',
      'version = "0.170.0"',
      '',
    ].join('\n'),
  );
  const contestFile = join(dir, 'qoj.json');
  await writeFile(
    contestFile,
    JSON.stringify(
      baseContestDoc({
        kind: 'qoj',
        contest_id: 500,
        pool: 'qoj-workers',
        languages: { cpp20: 'C++20' },
        problem_map: { P1: '7001', P2: '7002' },
      }),
    ),
  );

  // Plan with repeats: 3 -> expands to 3 jobs with repeat_index 1..3 and repeat_total 3
  const plan = await makePlan(
    { schema_version: 2, cells: [{ agent: agentFile, contest: contestFile, repeats: 3 }] },
    dir,
    getImage,
    store,
  );
  assert.equal(plan.jobs.length, 3);
  assert.deepEqual(
    plan.jobs.map(j => [j.repeat_index, j.repeat_total]),
    [[1, 3], [2, 3], [3, 3]],
  );

  // verifyPlan(runtime=true) fails when no OJ account exists in pool
  await assert.rejects(verifyPlan(plan, true, store, ojAccounts), /No ready qoj OJ accounts in pool "qoj-workers"/);

  // Add 2 ready accounts to the pool -> verifyPlan passes!
  await ojAccounts.create({
    id: 'qoj-acc-1',
    label: 'QOJ 1',
    platform: 'qoj',
    handle: 'bot1',
    pool: 'qoj-workers',
    transport: 'cookie',
    secret: 'UOJSESSID=cookie-one-1234',
  });
  await ojAccounts.create({
    id: 'qoj-acc-2',
    label: 'QOJ 2',
    platform: 'qoj',
    handle: 'bot2',
    pool: 'qoj-workers',
    transport: 'cookie',
    secret: 'UOJSESSID=cookie-two-5678',
  });
  await verifyPlan(plan, true, store, ojAccounts);

  // Start local webhook receiver + also register one unreachable push target to verify non-blocking failure tolerance
  const receivedHooks = [];
  const hookServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      receivedHooks.push({
        event: req.headers['x-cr-event'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise(resolvePromise => hookServer.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise(resolvePromise => hookServer.close(() => resolvePromise())));
  const hookPort = hookServer.address().port;

  await pushTargets.create({
    id: 'hook-ok',
    label: 'Local Hook',
    url: `http://127.0.0.1:${hookPort}/webhook`,
    events: ['run.completed', 'batch.completed'],
    auth_mode: 'none',
    timeout_ms: 2000,
    max_retries: 0,
  });
  await pushTargets.create({
    id: 'hook-dead',
    label: 'Dead Hook',
    url: 'http://127.0.0.1:1/unreachable',
    events: ['run.completed', 'batch.completed'],
    auth_mode: 'none',
    timeout_ms: 500,
    max_retries: 0,
  });
  const pushDispatcher = new PushDispatcher(pushTargets, { sleep: async () => {} });

  // Dispatch with concurrency: 3 across 3 jobs while leasing from the 2-account OJ pool
  const batch = await enqueue(runsRoot, plan, { concurrency: 3 });
  assert.equal(batch.concurrency, 3);

  let inFlight = 0;
  let peakInFlight = 0;
  let peakLeases = 0;
  const activeLeasedIds = new Set();
  const usedAccounts = new Set();

  const finished = await dispatch(runsRoot, batch.id, new AbortController().signal, {
    store,
    ojAccounts,
    pushDispatcher,
    concurrency: 3,
    preflight: async p => verifyPlan(p, true, store, ojAccounts),
    execute: async (_plan, job, opts) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const lease = await opts.ojPool.acquire('qoj', { pool: 'qoj-workers' }, opts.signal);
      try {
        assert.equal(activeLeasedIds.has(lease.account.id), false, 'Account lease must be exclusive');
        activeLeasedIds.add(lease.account.id);
        usedAccounts.add(lease.account.id);
        peakLeases = Math.max(peakLeases, activeLeasedIds.size);
        await new Promise(r => setTimeout(r, 80));
        // Write minimal run.json + events.jsonl so run.completed push includes progress
        const runDir = join(opts.out, opts.runId);
        await mkdir(runDir, { recursive: true, mode: 0o700 });
        await writeFile(
          join(runDir, 'run.json'),
          JSON.stringify({
            schema_version: 1,
            run_id: opts.runId,
            contest_id: job.contest_id,
            data_version: job.data_version,
            agent_id: job.agent_id,
            problems: [{ id: 'P1', max_points: 100 }, { id: 'P2', max_points: 100 }],
            rules: { time_limit_ms: 600_000, max_submissions: 50 },
          }),
        );
        await writeFile(
          join(runDir, 'events.jsonl'),
          [
            JSON.stringify({ schema_version: 1, seq: 1, elapsed_ms: 0, type: 'run_started', started_at: new Date().toISOString() }),
            JSON.stringify({ schema_version: 1, seq: 2, elapsed_ms: 1000, type: 'run_ended', status: 'completed', reason: 'finish', score: 100, max_score: 200 }),
          ].join('\n') + '\n',
        );
        return { runId: opts.runId, directory: runDir, status: 'completed', reason: 'finish' };
      } finally {
        activeLeasedIds.delete(lease.account.id);
        lease.release();
        inFlight--;
      }
    },
  });

  assert.equal(peakInFlight, 3, 'All 3 workers should run concurrently');
  assert.equal(peakLeases, 2, 'Pool of 2 accounts should lease at most 2 simultaneously');
  assert.equal(usedAccounts.size, 2, 'Both accounts in the pool should be utilized');
  assert.ok(finished.jobs.every(j => j.status === 'completed'));

  // Persisted batch.json must be intact and match
  const reloaded = await getBatch(runsRoot, batch.id);
  assert.equal(reloaded.concurrency, 3);
  assert.equal(reloaded.jobs.filter(j => j.status === 'completed').length, 3);

  // Webhooks received 3 run.completed + 1 batch.completed (dead target did not break dispatch!)
  assert.equal(receivedHooks.filter(h => h.event === 'run.completed').length, 3);
  assert.equal(receivedHooks.filter(h => h.event === 'batch.completed').length, 1);
  assert.equal(receivedHooks.find(h => h.event === 'batch.completed').body.completed, 3);
});

test('parallel dispatch handles per-run cancellation, batch stop, and sandbox_cleanup_failed cleanly', async t => {
  const dir = await makeTempDir('cr-parallel-cancel-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsRoot = join(dir, 'runs');
  const contestFile = resolve('examples/demo/contest.json');
  const agentFile = resolve('examples/demo/codex.toml');

  const plan = await makePlan(
    { schema_version: 2, cells: [{ agent: agentFile, contest: contestFile, repeats: 4 }] },
    dir,
    getImage,
  );
  const batch = await enqueue(runsRoot, plan, { concurrency: 2 });

  const startedRuns = [];
  let cancelTriggered = false;
  const finished = await dispatch(runsRoot, batch.id, new AbortController().signal, {
    concurrency: 2,
    preflight: async () => {},
    onJobStart: runId => {
      startedRuns.push(runId);
      if (startedRuns.length === 1 && !cancelTriggered) {
        cancelTriggered = true;
        void requestRunCancel(runsRoot, runId);
      }
    },
    execute: async (_plan, _job, opts) => {
      const myIdx = startedRuns.indexOf(opts.runId);
      if (myIdx === 0) {
        await new Promise(resolvePromise => {
          if (opts.signal.aborted) return resolvePromise();
          opts.signal.addEventListener('abort', () => resolvePromise(), { once: true });
        });
        return { runId: opts.runId, directory: join(opts.out, opts.runId), status: 'void', reason: 'interrupted' };
      }
      if (myIdx === 1) {
        await new Promise(r => setTimeout(r, 50));
        await requestBatchStop(runsRoot, batch.id);
        return { runId: opts.runId, directory: join(opts.out, opts.runId), status: 'completed', reason: 'finish' };
      }
      return { runId: opts.runId, directory: join(opts.out, opts.runId), status: 'completed', reason: 'finish' };
    },
  });

  assert.equal(finished.jobs[0].status, 'cancelled');
  assert.equal(finished.jobs[1].status, 'completed');
  assert.equal(finished.jobs[2].status, 'cancelled');
  assert.equal(finished.jobs[3].status, 'cancelled');

  // Verify sandbox_cleanup_failed halts new job launches and keeps failed job running for recovery
  const batch2 = await enqueue(runsRoot, plan, { concurrency: 2 });
  let launchedCount = 0;
  await assert.rejects(
    dispatch(runsRoot, batch2.id, new AbortController().signal, {
      concurrency: 2,
      preflight: async () => {},
      execute: async (_plan, _job, opts) => {
        const n = ++launchedCount;
        if (n === 1) {
          return { runId: opts.runId, directory: join(opts.out, opts.runId), status: 'void', reason: 'sandbox_cleanup_failed' };
        }
        await new Promise(r => setTimeout(r, 60));
        return { runId: opts.runId, directory: join(opts.out, opts.runId), status: 'completed', reason: 'finish' };
      },
    }),
    /Could not confirm cleanup/,
  );
  assert.equal(launchedCount, 2, 'Should not dispatch queued jobs after sandbox_cleanup_failed');
  const persisted2 = await getBatch(runsRoot, batch2.id);
  assert.equal(persisted2.jobs[0].status, 'running');
  assert.equal(persisted2.jobs[1].status, 'completed');
  assert.equal(persisted2.jobs[2].status, 'queued');
});
