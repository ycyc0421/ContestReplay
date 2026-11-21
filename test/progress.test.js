import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  buildGhostRace,
  buildRunReplay,
  evaluateGhostRaceAt,
  ghostRaceSchema,
  logSliceSchema,
  projectScoreAt,
  readRunLogSlice,
  readRunProgress,
  runProgressSchema,
  runReplaySchema,
  summarizeLiveRun,
  unifiedLineDiff,
} from '../dist/progress.js';

async function createRunFixture(root, opts) {
  const runId = opts.runId ?? randomUUID();
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  const hash = 'a'.repeat(64);
  const runJson = {
    schema_version: 1,
    run_id: runId,
    created_at: opts.createdAt ?? '2026-04-01T00:00:00.000Z',
    contest_id: opts.contestId ?? 'contest-demo',
    contest_title: opts.contestTitle ?? 'Contest Demo',
    data_version: opts.dataVersion ?? 1,
    agent_id: opts.agentId ?? 'agent-alpha',
    ...(opts.agentName ? { agent_name: opts.agentName } : {}),
    ...(opts.scoringMode ? { scoring_mode: opts.scoringMode } : {}),
    rules: {
      time_limit_ms: opts.timeLimitMs ?? 3_600_000,
      max_submissions: opts.maxSubmissions ?? 50,
    },
    ...(opts.problems ? { problems: opts.problems } : {}),
    ...(opts.localInputs ? { local_inputs: opts.localInputs } : {}),
    input_sha256: { contest: hash },
    protocol_id: 'codex-pdf-pages-mcp',
    protocol_version: 2,
    protocol_sha256: hash,
    agent_revision: hash,
    harness: { kind: 'codex', version: '0.170.0' },
    model: { model: 'gpt-5.3-codex', base_url: 'https://private.internal.example/v1' },
  };
  await writeFile(join(dir, 'run.json'), JSON.stringify(runJson, null, 2) + '\n', 'utf8');
  if (opts.events !== undefined) {
    const lines = opts.events.map((event, idx) => JSON.stringify({ schema_version: 1, seq: idx + 1, ...event }));
    const content = lines.join('\n') + (opts.trailingPartial !== undefined ? '\n' + opts.trailingPartial : '\n');
    await writeFile(join(dir, 'events.jsonl'), content, 'utf8');
  }
  return { runId, dir };
}

test('readRunProgress handles live incomplete events.jsonl with trailing partial JSON line and summarizes live runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-progress-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const startedAt = '2026-04-01T10:00:00.000Z';
  const nowMs = Date.parse(startedAt) + 180_000; // 3 minutes elapsed

  const { runId } = await createRunFixture(root, {
    agentId: 'codex-fast',
    agentName: 'Codex Fast (High)',
    contestId: 'icpc-live',
    contestTitle: 'ICPC Live Mock',
    scoringMode: 'icpc',
    timeLimitMs: 900_000,
    maxSubmissions: 25,
    problems: [
      { id: 'A', max_points: 1 },
      { id: 'B', max_points: 1 },
      { id: 'C', max_points: 1 },
      { id: 'D', max_points: 1 },
    ],
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: startedAt },
      { elapsed_ms: 5_000, type: 'model_request', turn: 1 },
      { elapsed_ms: 17_000, type: 'model_response', turn: 1, duration_ms: 12_000, usage: { input_tokens: 1500, output_tokens: 400 } },
      { elapsed_ms: 30_000, type: 'submission_received', submission_id: 's1', problem_id: 'A', language: 'cpp17', source: 'int main(){return 1;}' },
      { elapsed_ms: 34_000, type: 'submission_judged', submission_id: 's1', verdict: 'WRONG_ANSWER' },
      { elapsed_ms: 40_000, type: 'model_request', turn: 2 },
      { elapsed_ms: 55_000, type: 'model_response', turn: 2, usage: { input_tokens: 2100, output_tokens: 650 } },
      { elapsed_ms: 70_000, type: 'submission_received', submission_id: 's2', problem_id: 'A', language: 'cpp17', source: 'int main(){return 0;}' },
      { elapsed_ms: 73_000, type: 'submission_judged', submission_id: 's2', verdict: 'OK' },
      { elapsed_ms: 100_000, type: 'submission_received', submission_id: 's3', problem_id: 'B', language: 'cpp17', source: 'int main(){}' },
      { elapsed_ms: 104_000, type: 'submission_judged', submission_id: 's3', verdict: 'TIME_LIMIT_EXCEEDED' },
      { elapsed_ms: 120_000, type: 'submission_received', submission_id: 's4', problem_id: 'C', language: 'pypy3', source: 'print(42)' },
    ],
    trailingPartial: '{"schema_version":1,"seq":13,"elapsed_ms":125000,"type":"submiss',
  });

  const progress = await readRunProgress(root, runId, { now: nowMs, maxActivity: 10 });
  assert.doesNotThrow(() => runProgressSchema.parse(progress));

  assert.equal(progress.status, 'running');
  assert.equal(progress.agent_id, 'codex-fast');
  assert.equal(progress.agent_name, 'Codex Fast (High)');
  assert.equal(progress.scoring_mode, 'icpc');
  assert.equal(progress.elapsed_ms, 180_000);
  assert.equal(progress.remaining_ms, 720_000);
  assert.equal(progress.submissions_used, 4);
  assert.equal(progress.max_submissions, 25);
  assert.equal(progress.model_turns, 2);
  assert.equal(progress.last_activity_ms, 120_000);
  assert.equal(progress.last_activity_type, 'submission_received');
  assert.equal(progress.score, 1);
  assert.equal(progress.max_score, 4);
  assert.equal(progress.solved_count, 1);
  assert.equal(progress.problem_count, 4);

  assert.deepEqual(progress.telemetry, {
    model_turns: 2,
    total_model_wait_ms: 27_000, // 12_000 explicit + (55_000 - 40_000)
    total_input_tokens: 3600,
    total_output_tokens: 1050,
  });

  const byId = Object.fromEntries(progress.problems.map(p => [p.id, p]));
  assert.equal(byId.A.status, 'accepted');
  assert.equal(byId.A.attempts, 2);
  assert.equal(byId.A.first_ac_ms, 70_000);
  assert.equal(byId.B.status, 'wrong');
  assert.equal(byId.B.last_verdict, 'TIME_LIMIT_EXCEEDED');
  assert.equal(byId.C.status, 'pending');
  assert.equal(byId.D.status, 'unattempted');

  assert.equal(progress.recent_activity.length, 10);
  assert.equal(progress.recent_activity[0].seq, 12);
  assert.equal(progress.recent_activity[0].problem_id, 'C');
  assert.equal(progress.recent_activity[0].verdict, 'pending');

  const summary = summarizeLiveRun(progress);
  assert.deepEqual(summary, {
    solved_count: 1,
    problem_count: 4,
    score: 1,
    max_score: 4,
    remaining_ms: 720_000,
    last_submission: { problem_id: 'C', verdict: 'pending', elapsed_ms: 120_000 },
    active: true,
  });
});

test('readRunProgress aggregates IOI partial scores and handles completed/void/unknown states', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-progress-ioi-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { runId: ioiRun } = await createRunFixture(root, {
    scoringMode: 'ioi',
    timeLimitMs: 1_800_000,
    problems: [
      { id: 'P1', max_points: 100 },
      { id: 'P2', max_points: 100 },
    ],
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 60_000, type: 'submission_received', submission_id: 's1', problem_id: 'P1', language: 'cpp20', source: 'v1' },
      { elapsed_ms: 62_000, type: 'submission_judged', submission_id: 's1', verdict: 'partial', points_awarded: 35 },
      { elapsed_ms: 120_000, type: 'submission_received', submission_id: 's2', problem_id: 'P1', language: 'cpp20', source: 'v2' },
      { elapsed_ms: 122_000, type: 'submission_judged', submission_id: 's2', verdict: 'partial', score: 70 },
      { elapsed_ms: 180_000, type: 'submission_received', submission_id: 's3', problem_id: 'P1', language: 'cpp20', source: 'v3' },
      { elapsed_ms: 182_000, type: 'submission_judged', submission_id: 's3', verdict: 'WRONG_ANSWER', points_awarded: 20 },
      { elapsed_ms: 240_000, type: 'submission_received', submission_id: 's4', problem_id: 'P2', language: 'cpp20', source: 'p2-v1' },
      { elapsed_ms: 245_000, type: 'submission_judged', submission_id: 's4', verdict: 'partial', points_awarded: 50 },
      { elapsed_ms: 300_000, type: 'submission_received', submission_id: 's5', problem_id: 'P2', language: 'cpp20', source: 'p2-v2' },
      { elapsed_ms: 305_000, type: 'submission_judged', submission_id: 's5', verdict: 'accepted', points_awarded: 100 },
      { elapsed_ms: 310_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 170, max_score: 200 },
    ],
  });

  const completed = await readRunProgress(root, ioiRun);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.reason, 'finish');
  assert.equal(completed.score, 170);
  assert.equal(completed.max_score, 200);
  assert.equal(completed.solved_count, 1);
  assert.equal(completed.problems[0].status, 'partial');
  assert.equal(completed.problems[0].best_score, 70);
  assert.equal(completed.problems[0].attempts, 3);
  assert.equal(completed.problems[1].status, 'accepted');
  assert.equal(completed.problems[1].best_score, 100);
  assert.equal(completed.problems[1].first_ac_ms, 300_000);
  assert.equal(summarizeLiveRun(completed).active, false);

  const { runId: unknownRun } = await createRunFixture(root, {
    problems: [{ id: 'A', max_points: 1 }],
  });
  const unknown = await readRunProgress(root, unknownRun);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.problem_count, 1);

  // Discover problems from local_inputs (run.ts default layout) without exposing answers or host paths,
  // and merge Codex model_response + model_usage telemetry without double-counting turns.
  const { runId: codexRun } = await createRunFixture(root, {
    localInputs: {
      contest: resolve('examples/demo/contest.json'),
      judge: resolve('examples/demo/judge.json'),
    },
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 1_000, type: 'model_request', turn: 1 },
      { elapsed_ms: 2_500, type: 'model_response', turn: 1, status: 200 },
      { elapsed_ms: 6_000, type: 'model_usage', turn: 1, usage: { input_tokens: 900, output_tokens: 250 } },
      { elapsed_ms: 10_000, type: 'submission_received', submission_id: 's1', problem_id: '1', answer: '3' },
      { elapsed_ms: 10_000, type: 'submission_judged', submission_id: 's1', verdict: 'accepted', points_awarded: 3 },
      { elapsed_ms: 11_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 3, max_score: 8 },
    ],
  });
  const codexProgress = await readRunProgress(root, codexRun);
  assert.equal(codexProgress.problem_count, 2);
  assert.equal(codexProgress.max_score, 8);
  assert.equal(codexProgress.score, 3);
  assert.equal(codexProgress.solved_count, 1);
  assert.equal(codexProgress.problems[1].id, '2');
  assert.equal(codexProgress.problems[1].status, 'unattempted');
  assert.deepEqual(codexProgress.telemetry, {
    model_turns: 1,
    total_model_wait_ms: 5_000,
    total_input_tokens: 900,
    total_output_tokens: 250,
  });
  assert.ok(!JSON.stringify(codexProgress).includes('examples/demo'));
  const codexReplay = await buildRunReplay(root, codexRun);
  assert.equal(codexReplay.frames.filter(f => f.kind === 'model_turn').length, 1);
  assert.equal(codexReplay.frames.find(f => f.kind === 'model_turn').input_tokens, 900);
});

test('progress and replay never leak local answers, secrets, raw source code in progress, or host paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-progress-sec-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const secretAnswer = 'SUPER_SECRET_CONTEST_ANSWER_99182';
  const secretToken = 'sk-live-very-secret-token-xyz123456789';
  const secretSource = 'int secretSourceMarker_7741 = 1;';
  const hostPath = '/home/alice/private-contests/secret-judge.json';

  const { runId, dir } = await createRunFixture(root, {
    localInputs: { contest: '/home/alice/private-contests/contest.json', judge: hostPath },
    problems: [{ id: '1', max_points: 5 }],
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 1000, type: 'submission_received', submission_id: 's1', problem_id: '1', answer: secretAnswer, source: secretSource, language: 'cpp17' },
      { elapsed_ms: 1200, type: 'submission_judged', submission_id: 's1', verdict: 'accepted', points_awarded: 5 },
      { elapsed_ms: 1500, type: 'run_ended', status: 'void', reason: `error reading ${hostPath} with Bearer ${secretToken}` },
    ],
  });

  await mkdir(join(dir, 'session'), { recursive: true });
  await writeFile(
    join(dir, 'session', 'transcript.jsonl'),
    JSON.stringify({ role: 'assistant', text: `Checked ${hostPath} using Bearer ${secretToken}` }) + '\n',
    'utf8',
  );

  const progress = await readRunProgress(root, runId);
  const progressJson = JSON.stringify(progress);
  for (const forbidden of [secretAnswer, secretToken, secretSource, hostPath, '/home/alice', 'private.internal.example']) {
    assert.ok(!progressJson.includes(forbidden), `Progress leaked forbidden string: ${forbidden}`);
  }
  assert.match(progress.reason ?? '', /\[path\]/);
  assert.match(progress.reason ?? '', /Bearer \[REDACTED\]/);

  const replayNoSrc = await buildRunReplay(root, runId, { includeSession: true, includeSources: false });
  const replayJson = JSON.stringify(replayNoSrc);
  for (const forbidden of [secretAnswer, secretToken, secretSource, hostPath, '/home/alice']) {
    assert.ok(!replayJson.includes(forbidden), `Replay leaked forbidden string: ${forbidden}`);
  }
  assert.equal(replayNoSrc.session_summaries?.length, 1);
  assert.match(replayNoSrc.session_summaries[0].entries[0].summary, /\[path\]/);
  assert.match(replayNoSrc.session_summaries[0].entries[0].summary, /Bearer \[REDACTED\]/);
});

test('readRunLogSlice handles ENOENT, incremental byte-offset polling, UTF-8 boundary slicing, and truncation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-log-slice-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const runId = randomUUID();
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });

  // ENOENT returns empty slice cleanly
  const empty = await readRunLogSlice(root, runId, 'stdout');
  assert.doesNotThrow(() => logSliceSchema.parse(empty));
  assert.deepEqual(empty, { stream: 'stdout', offset: 0, next_offset: 0, total_bytes: 0, has_more: false, chunk: '' });

  // Multi-byte UTF-8 content (CJK 3-byte chars + emoji 4-byte chars)
  const initialContent = 'start-中文测试日志-🚀-line1\n第二行🎯done\n';
  const logPath = join(dir, 'agent.stdout.log');
  await writeFile(logPath, initialContent, 'utf8');

  let offset = 0;
  let assembled = '';
  let polls = 0;
  while (true) {
    const slice = await readRunLogSlice(root, runId, 'stdout', offset, 7);
    assert.doesNotThrow(() => logSliceSchema.parse(slice));
    assert.ok(!slice.chunk.includes('\uFFFD'), `Split multi-byte UTF-8 character in slice at offset ${offset}`);
    assembled += slice.chunk;
    assert.ok(slice.next_offset > offset || !slice.has_more);
    offset = slice.next_offset;
    polls++;
    if (!slice.has_more) break;
    assert.ok(polls < 100, 'Log tailing loop failed to converge');
  }
  assert.equal(assembled, initialContent);
  assert.equal(offset, Buffer.byteLength(initialContent, 'utf8'));

  // Poll at EOF returns empty without advancing
  const atEof = await readRunLogSlice(root, runId, 'stdout', offset, 64);
  assert.equal(atEof.chunk, '');
  assert.equal(atEof.has_more, false);
  assert.equal(atEof.next_offset, offset);

  // Append more bytes -> incremental tail reads only new suffix
  const appended = 'appended-尾声\n';
  await writeFile(logPath, initialContent + appended, 'utf8');
  const nextSlice = await readRunLogSlice(root, runId, 'stdout', offset, 64);
  assert.equal(nextSlice.offset, offset);
  assert.equal(nextSlice.chunk, appended);
  assert.equal(nextSlice.has_more, false);

  // Truncation / shrink resets cleanly to offset 0
  const shrunk = 'reset\n';
  await writeFile(logPath, shrunk, 'utf8');
  const afterTruncate = await readRunLogSlice(root, runId, 'stdout', nextSlice.next_offset, 64);
  assert.equal(afterTruncate.offset, 0);
  assert.equal(afterTruncate.chunk, shrunk);
  assert.equal(afterTruncate.next_offset, Buffer.byteLength(shrunk, 'utf8'));
  assert.equal(afterTruncate.total_bytes, Buffer.byteLength(shrunk, 'utf8'));
});

test('buildRunReplay builds frames with per-problem unified code diffs and projectScoreAt scrubs cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-replay-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const srcV1 = [
    '#include <iostream>',
    'using namespace std;',
    'int main() {',
    '  int a, b;',
    '  cin >> a >> b;',
    '  cout << (a - b) << "\\n";',
    '  return 0;',
    '}',
  ].join('\n');
  const srcV2 = [
    '#include <iostream>',
    'using namespace std;',
    'int main() {',
    '  int a, b;',
    '  cin >> a >> b;',
    '  cout << (a + b) << "\\n";',
    '  return 0;',
    '}',
  ].join('\n');

  const { runId } = await createRunFixture(root, {
    scoringMode: 'icpc',
    timeLimitMs: 3_600_000,
    problems: [
      { id: 'A', max_points: 500 },
      { id: 'B', max_points: 1000 },
    ],
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 60_000, type: 'submission_received', submission_id: 's1', problem_id: 'A', language: 'cpp17', source: srcV1 },
      { elapsed_ms: 65_000, type: 'submission_judged', submission_id: 's1', verdict: 'WRONG_ANSWER' },
      { elapsed_ms: 180_000, type: 'submission_received', submission_id: 's2', problem_id: 'A', language: 'cpp17', source: srcV2 },
      { elapsed_ms: 185_000, type: 'submission_judged', submission_id: 's2', verdict: 'OK' },
      { elapsed_ms: 300_000, type: 'submission_received', submission_id: 's3', problem_id: 'B', language: 'pypy3', source: 'print(42)' },
      { elapsed_ms: 310_000, type: 'submission_judged', submission_id: 's3', verdict: 'OK' },
      { elapsed_ms: 320_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 1500, max_score: 1500 },
    ],
  });

  const replay = await buildRunReplay(root, runId, { includeSources: true });
  assert.doesNotThrow(() => runReplaySchema.parse(replay));

  const subFrames = replay.frames.filter(f => f.kind === 'submission_received');
  assert.equal(subFrames.length, 3);
  assert.equal(subFrames[0].source, srcV1);
  assert.equal(subFrames[0].diff, undefined);
  assert.equal(subFrames[1].source, srcV2);
  assert.ok(subFrames[1].diff, 'Expected unified diff for second submission on problem A');
  assert.match(subFrames[1].diff, /^--- s1\n\+\+\+ s2\n@@ /);
  assert.match(subFrames[1].diff, /-  cout << \(a - b\)/);
  assert.match(subFrames[1].diff, /\+  cout << \(a \+ b\)/);
  // Different problem B has no diff against A
  assert.equal(subFrames[2].diff, undefined);

  // Verify unifiedLineDiff directly
  assert.equal(unifiedLineDiff('a\nb', 'a\nb'), '');

  // Timeline scrubbing with projectScoreAt
  const at100s = projectScoreAt(replay, 100_000, 'icpc');
  assert.equal(at100s.solved_count, 0);
  assert.equal(at100s.problems[0].status, 'wrong');

  // At 182s: s2 was received at 180s, judged at 185s -> pending!
  const at182s = projectScoreAt(replay, 182_000, 'icpc');
  assert.equal(at182s.solved_count, 0);
  assert.equal(at182s.problems[0].status, 'pending');

  // At 190s: s2 judged -> accepted at received time 180_000 (3 min) + 20 min penalty = 23 min
  const at190s = projectScoreAt(replay, 190_000, 'icpc');
  assert.equal(at190s.solved_count, 1);
  assert.equal(at190s.score, 1);
  assert.equal(at190s.penalty, 23);
  assert.equal(at190s.problems[0].first_ac_ms, 180_000);
});

test('buildGhostRace aligns 3 agents and ranks accurately across icpc, cf, ioi, and last_ac modes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-ghost-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const problems = [
    { id: 'A', max_points: 500 },
    { id: 'B', max_points: 1000 },
    { id: 'C', max_points: 1500 },
  ];
  const timeLimitMs = 3_600_000; // 60 minutes

  // Agent Alpha ("Speedster"): A clean @ 5m, B WA @ 10m + AC @ 15m, C partial 600 @ 20m
  const { runId: alphaId } = await createRunFixture(root, {
    contestId: 'cf-ghost-1',
    contestTitle: 'Ghost Race Round 1',
    agentId: 'alpha',
    agentName: 'Alpha Speedster',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 300_000, type: 'submission_received', submission_id: 'a1', problem_id: 'A', language: 'cpp20', source: 'A' },
      { elapsed_ms: 302_000, type: 'submission_judged', submission_id: 'a1', verdict: 'OK', points_awarded: 500 },
      { elapsed_ms: 600_000, type: 'submission_received', submission_id: 'a2', problem_id: 'B', language: 'cpp20', source: 'B1' },
      { elapsed_ms: 602_000, type: 'submission_judged', submission_id: 'a2', verdict: 'WRONG_ANSWER', points_awarded: 0 },
      { elapsed_ms: 900_000, type: 'submission_received', submission_id: 'a3', problem_id: 'B', language: 'cpp20', source: 'B2' },
      { elapsed_ms: 902_000, type: 'submission_judged', submission_id: 'a3', verdict: 'OK', points_awarded: 1000 },
      { elapsed_ms: 1_200_000, type: 'submission_received', submission_id: 'a4', problem_id: 'C', language: 'cpp20', source: 'C1' },
      { elapsed_ms: 1_202_000, type: 'submission_judged', submission_id: 'a4', verdict: 'partial', points_awarded: 600 },
      { elapsed_ms: 1_500_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 2100, max_score: 3000 },
    ],
  });

  // Agent Beta ("Steady"): A clean @ 12m, B clean @ 14m (zero WAs!), skips C
  const { runId: betaId } = await createRunFixture(root, {
    contestId: 'cf-ghost-1',
    contestTitle: 'Ghost Race Round 1',
    agentId: 'beta',
    agentName: 'Beta Steady',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 720_000, type: 'submission_received', submission_id: 'b1', problem_id: 'A', language: 'cpp20', source: 'A' },
      { elapsed_ms: 721_000, type: 'submission_judged', submission_id: 'b1', verdict: 'OK', points_awarded: 500 },
      { elapsed_ms: 840_000, type: 'submission_received', submission_id: 'b2', problem_id: 'B', language: 'cpp20', source: 'B' },
      { elapsed_ms: 841_000, type: 'submission_judged', submission_id: 'b2', verdict: 'OK', points_awarded: 1000 },
      { elapsed_ms: 900_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 1500, max_score: 3000 },
    ],
  });

  // Agent Gamma ("Late Heavy"): A 2 WAs + AC @ 30m, C partial 900 @ 25m + AC @ 40m
  const { runId: gammaId } = await createRunFixture(root, {
    contestId: 'cf-ghost-1',
    contestTitle: 'Ghost Race Round 1',
    agentId: 'gamma',
    agentName: 'Gamma Heavy',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 1_500_000, type: 'submission_received', submission_id: 'g1', problem_id: 'C', language: 'cpp20', source: 'C1' },
      { elapsed_ms: 1_501_000, type: 'submission_judged', submission_id: 'g1', verdict: 'partial', points_awarded: 900 },
      { elapsed_ms: 1_600_000, type: 'submission_received', submission_id: 'g2', problem_id: 'A', language: 'cpp20', source: 'A1' },
      { elapsed_ms: 1_601_000, type: 'submission_judged', submission_id: 'g2', verdict: 'WRONG_ANSWER', points_awarded: 0 },
      { elapsed_ms: 1_700_000, type: 'submission_received', submission_id: 'g3', problem_id: 'A', language: 'cpp20', source: 'A2' },
      { elapsed_ms: 1_701_000, type: 'submission_judged', submission_id: 'g3', verdict: 'WRONG_ANSWER', points_awarded: 0 },
      { elapsed_ms: 1_800_000, type: 'submission_received', submission_id: 'g4', problem_id: 'A', language: 'cpp20', source: 'A3' },
      { elapsed_ms: 1_801_000, type: 'submission_judged', submission_id: 'g4', verdict: 'OK', points_awarded: 500 },
      { elapsed_ms: 2_400_000, type: 'submission_received', submission_id: 'g5', problem_id: 'C', language: 'cpp20', source: 'C2' },
      { elapsed_ms: 2_401_000, type: 'submission_judged', submission_id: 'g5', verdict: 'OK', points_awarded: 1500 },
      { elapsed_ms: 2_500_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 2000, max_score: 3000 },
    ],
  });

  const race = await buildGhostRace(root, [alphaId, betaId, gammaId], { scoringMode: 'icpc', sampleStepMs: 600_000 });
  assert.doesNotThrow(() => ghostRaceSchema.parse(race));
  const serialized = JSON.parse(JSON.stringify(race));
  assert.doesNotThrow(() => ghostRaceSchema.parse(serialized));
  assert.equal(race.participants.length, 3);
  assert.ok(race.samples && race.samples.length >= 6);

  // Milestones sorted ascending by elapsed_ms
  for (let i = 1; i < race.milestones.length; i++) {
    assert.ok(race.milestones[i].elapsed_ms >= race.milestones[i - 1].elapsed_ms);
  }

  // At t = 6 min (360_000): Alpha leads (1 solved), Beta & Gamma tied at rank 2
  const at6m = race.evaluateAt(360_000, 'icpc');
  assert.equal(at6m.standings[0].agent_id, 'alpha');
  assert.equal(at6m.standings[0].rank, 1);
  assert.equal(at6m.standings[1].rank, 2);
  assert.equal(at6m.standings[2].rank, 2);

  // At t = 45 min (2_700_000) in ICPC: Beta (2, pen 26) > Alpha (2, pen 40) > Gamma (2, pen 110)
  const icpcFinal = race.evaluateAt(2_700_000, 'icpc');
  assert.deepEqual(icpcFinal.standings.map(s => [s.agent_id, s.rank, s.score, s.penalty]), [
    ['beta', 1, 2, 26],
    ['alpha', 2, 2, 40],
    ['gamma', 3, 2, 130], // A: 30 + 2*20 = 70; C: 40 + 1*20 (partial before AC) = 60 -> 130
  ]);

  // Verify standalone evaluateGhostRaceAt on deserialized JSON matches method identically
  assert.deepEqual(evaluateGhostRaceAt(serialized, 2_700_000, 'icpc'), icpcFinal);

  // At t = 45 min in IOI: Alpha (2100) > Gamma (2000) > Beta (1500)
  const ioiFinal = race.evaluateAt(2_700_000, 'ioi');
  assert.deepEqual(ioiFinal.standings.map(s => [s.agent_id, s.rank, s.score]), [
    ['alpha', 1, 2100],
    ['gamma', 2, 2000],
    ['beta', 3, 1500],
  ]);

  // At t = 45 min in last_ac: Alpha (2100, with partial 600 on C) vs wait — let's check exact last_ac scores!
  // Alpha: A(500) + B(1000) + C partial(600) = 2100; Gamma: A(500) + C(1500) = 2000; Beta: A(500) + B(1000) = 1500
  const lastAcAt16m = race.evaluateAt(960_000, 'last_ac');
  // At 16m: Beta (1500, last_ac=840_000) > Alpha (1500, last_ac=900_000) > Gamma (0)
  assert.deepEqual(lastAcAt16m.standings.map(s => [s.agent_id, s.rank, s.score, s.last_ac_ms]), [
    ['beta', 1, 1500, 840_000],
    ['alpha', 2, 1500, 900_000],
    ['gamma', 3, 0, 0],
  ]);

  // At t = 45 min in CF:
  // Gamma: A(500*(1 - 0.5*30/60) - 2*50 = 275) + C(1500*(1 - 0.5*40/60) - 1*50 = 950) = 1225
  // Beta: A(500*(1 - 0.5*12/60) = 450) + B(1000*(1 - 0.5*14/60) = 883.33) = 1333.33
  // Alpha: A(500*(1 - 0.5*5/60) = 479.17) + B(1000*(1 - 0.5*15/60) - 50 = 825) = 1304.17
  const cfFinal = race.evaluateAt(2_700_000, 'cf');
  assert.deepEqual(cfFinal.standings.map(s => s.agent_id), ['beta', 'alpha', 'gamma']);
  assert.equal(cfFinal.standings[0].score, 1333.33);
  assert.equal(cfFinal.standings[1].score, 1304.17);
  assert.equal(cfFinal.standings[2].score, 1225);

  // Validation errors: empty, >8, duplicates, contest mismatch
  await assert.rejects(buildGhostRace(root, []), /at least 1 run/);
  await assert.rejects(buildGhostRace(root, Array.from({ length: 9 }, () => randomUUID())), /at most 8 runs/);
  await assert.rejects(buildGhostRace(root, [alphaId, alphaId]), /Duplicate run IDs/);

  const { runId: otherContestRun } = await createRunFixture(root, {
    contestId: 'different-contest',
    problems: [{ id: 'X', max_points: 1 }],
    events: [{ elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' }],
  });
  await assert.rejects(buildGhostRace(root, [alphaId, otherContestRun]), /Contest mismatch/);
});
