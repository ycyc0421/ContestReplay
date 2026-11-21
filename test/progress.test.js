import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveContest, sha256 } from '../dist/config.js';
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
  const hash = opts.contestRevision ?? 'a'.repeat(64);
  const runJson = {
    schema_version: 1,
    run_id: runId,
    created_at: opts.createdAt ?? '2026-04-01T00:00:00.000Z',
    contest_id: opts.contestId ?? 'contest-demo',
    contest_title: opts.contestTitle ?? 'Contest Demo',
    data_version: opts.dataVersion ?? 1,
    contest_revision: hash,
    agent_id: opts.agentId ?? 'agent-alpha',
    ...(opts.agentName ? { agent_name: opts.agentName } : {}),
    ...(opts.scoringMode ? { scoring_mode: opts.scoringMode } : {}),
    rules: {
      time_limit_ms: opts.timeLimitMs ?? 3_600_000,
      max_submissions: opts.maxSubmissions ?? 50,
    },
    ...(opts.problems ? { problems: opts.problems } : {}),
    ...(opts.localInputs ? { local_inputs: opts.localInputs } : {}),
    input_sha256: opts.inputSha256 ?? { contest: hash },
    protocol_id: opts.protocolId === null ? undefined : (opts.protocolId ?? 'codex-pdf-pages-mcp'),
    protocol_version: opts.protocolVersion === null ? undefined : (opts.protocolVersion ?? 2),
    protocol_sha256: opts.protocolSha256 === null ? undefined : (opts.protocolSha256 ?? 'b'.repeat(64)),
    agent_revision: hash,
    harness: { kind: 'codex', version: '0.170.0' },
    model: { model: 'gpt-5.3-codex', base_url: 'https://private.internal.example/v1' },
  };
  await writeFile(join(dir, 'run.json'), JSON.stringify(runJson, null, 2) + '\n', 'utf8');
  if (opts.rawEventsContent !== undefined) {
    await writeFile(join(dir, 'events.jsonl'), opts.rawEventsContent, 'utf8');
  } else if (opts.events !== undefined) {
    const lines = opts.events.map((event, idx) => JSON.stringify({ schema_version: 1, seq: event.seq ?? idx + 1, ...event }));
    const content = lines.join('\n') + (opts.trailingPartial !== undefined ? '\n' + opts.trailingPartial : '\n');
    await writeFile(join(dir, 'events.jsonl'), content, 'utf8');
  }
  return { runId, dir };
}

test('readRunProgress handles live incomplete events.jsonl with trailing partial JSON line and summarizes live runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-progress-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const startedAt = '2026-04-01T10:00:00.000Z';
  const nowMs = Date.parse(startedAt) + 180_000;

  const { runId } = await createRunFixture(root, {
    agentId: 'codex-fast',
    agentName: 'Antigravity Fast (High)',
    contestId: 'icpc-live',
    contestTitle: 'ICPC Live Mock',
    scoringMode: 'icpc',
    timeLimitMs: 900_000,
    maxSubmissions: 25,
    problems: [
      { id: 'A', max_points: 500 },
      { id: 'B', max_points: 1000 },
      { id: 'C', max_points: 1500 },
      { id: 'D', max_points: 2000 },
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

  // Weighted contest under scoring_mode='icpc' must consistently score 1 per solved problem in progress AND replay!
  assert.equal(progress.status, 'running');
  assert.equal(progress.score, 1);
  assert.equal(progress.max_score, 4);
  assert.equal(progress.solved_count, 1);
  assert.equal(progress.problem_count, 4);

  const replay = await buildRunReplay(root, runId);
  assert.equal(replay.frames[replay.frames.length - 1].cumulative_score, 1);
  assert.equal(projectScoreAt(replay, 180_000, 'icpc').score, 1);

  assert.deepEqual(progress.telemetry, {
    model_turns: 2,
    total_model_wait_ms: 27_000,
    total_input_tokens: 3600,
    total_output_tokens: 1050,
  });

  const byId = Object.fromEntries(progress.problems.map(p => [p.id, p]));
  assert.equal(byId.A.status, 'accepted');
  assert.equal(byId.A.attempts, 2);
  assert.equal(byId.A.first_ac_ms, 70_000);
  assert.equal(byId.B.status, 'wrong');
  assert.equal(byId.C.status, 'pending');
  assert.equal(byId.D.status, 'unattempted');

  assert.deepEqual(summarizeLiveRun(progress), {
    solved_count: 1,
    problem_count: 4,
    score: 1,
    max_score: 4,
    remaining_ms: 720_000,
    last_submission: { problem_id: 'C', verdict: 'pending', elapsed_ms: 120_000 },
    active: true,
  });
});

test('readRunProgress verifies local_inputs digests, ignores tampered files, blocks symlinks, and rejects invalid_submission ghost problems', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-progress-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 1. Untampered local_inputs with matching judge sha256 discovers problems safely without leaking answers/paths
  const demoJudgePath = resolve('examples/demo/judge.json');
  const demoJudgeHash = sha256(await readFile(demoJudgePath));
  const { runId: verifiedRun } = await createRunFixture(root, {
    localInputs: { contest: resolve('examples/demo/contest.json'), judge: demoJudgePath },
    inputSha256: { contest: 'a'.repeat(64), judge: demoJudgeHash },
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      // Missing turn on model_request + model_response must count as 1 synthetic turn, not 2
      { elapsed_ms: 1_000, type: 'model_request' },
      { elapsed_ms: 3_000, type: 'model_response', status: 200, usage: { input_tokens: 900, output_tokens: 250 } },
      // Invalid submission targeting unknown problem 'GHOST' must NOT pollute problem_count or max_score
      { elapsed_ms: 5_000, type: 'submission_received', submission_id: 's1', problem_id: 'GHOST', answer: 'bad' },
      { elapsed_ms: 5_000, type: 'submission_judged', submission_id: 's1', verdict: 'invalid_submission', points_awarded: 0 },
      { elapsed_ms: 10_000, type: 'submission_received', submission_id: 's2', problem_id: '1', answer: '3' },
      { elapsed_ms: 10_000, type: 'submission_judged', submission_id: 's2', verdict: 'accepted', points_awarded: 3 },
      { elapsed_ms: 11_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 3, max_score: 8 },
    ],
  });
  const verifiedProgress = await readRunProgress(root, verifiedRun);
  assert.equal(verifiedProgress.problem_count, 2);
  assert.deepEqual(verifiedProgress.problems.map(p => p.id), ['1', '2']);
  assert.equal(verifiedProgress.submissions_used, 2);
  assert.equal(verifiedProgress.max_score, 8);
  assert.equal(verifiedProgress.score, 3);
  assert.equal(verifiedProgress.model_turns, 1);
  assert.ok(!JSON.stringify(verifiedProgress).includes('examples/demo'));

  // 2. Unseeded run with invalid_submission targeting unknown 'GHOST' does NOT create a phantom problem
  const { runId: unseededGhostRun } = await createRunFixture(root, {
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 2_000, type: 'submission_received', submission_id: 's1', problem_id: 'GHOST', answer: 'x' },
      { elapsed_ms: 2_000, type: 'submission_judged', submission_id: 's1', verdict: 'invalid_submission' },
      { elapsed_ms: 5_000, type: 'submission_received', submission_id: 's2', problem_id: 'A', answer: '42' },
      { elapsed_ms: 5_000, type: 'submission_judged', submission_id: 's2', verdict: 'accepted', points_awarded: 10 },
      { elapsed_ms: 6_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 10, max_score: 10 },
    ],
  });
  const unseededProg = await readRunProgress(root, unseededGhostRun);
  assert.equal(unseededProg.problem_count, 1);
  assert.deepEqual(unseededProg.problems.map(p => p.id), ['A']);
  assert.equal(unseededProg.submissions_used, 2);

  // 1b. Production resolveContest() digest verification on a real Codeforces v2 contest manifest
  const cfDir = join(root, 'cf-manifest');
  await mkdir(cfDir, { recursive: true });
  const cfManifestPath = join(cfDir, 'contest.json');
  const cfManifestRaw = {
    schema_version: 2,
    contest_id: 'cf-1234',
    data_version: 1,
    title: 'Codeforces Round 1234',
    source: { name: 'Codeforces' },
    materials: { entrypoint: { kind: 'pdf', path: resolve('examples/demo/problems.pdf') } },
    problems: [
      { id: 'A', max_points: 500 },
      { id: 'B', max_points: 1000 },
    ],
    judge: {
      kind: 'codeforces',
      contest_id: 1234,
      handle: 'cr_bot',
      languages: { cpp17: 54 },
    },
  };
  await writeFile(cfManifestPath, JSON.stringify(cfManifestRaw, null, 2));
  const resolvedCf = await resolveContest(cfManifestRaw, cfManifestPath);
  const { runId: cfRun } = await createRunFixture(root, {
    contestId: 'cf-1234',
    localInputs: { contest: cfManifestPath },
    inputSha256: { contest: resolvedCf.contestDigest },
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 10_000, type: 'submission_received', submission_id: 's1', problem_id: 'A', language: 'cpp17', source: 'int main(){}' },
      { elapsed_ms: 12_000, type: 'submission_judged', submission_id: 's1', verdict: 'OK' },
      { elapsed_ms: 15_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 500, max_score: 1500 },
    ],
  });
  const cfProg = await readRunProgress(root, cfRun);
  assert.equal(cfProg.problem_breakdown_unavailable, undefined);
  assert.equal(cfProg.problem_count, 2);
  assert.equal(cfProg.score, 500);
  assert.equal(cfProg.max_score, 1500);

  // Tampering with cfManifestPath breaks resolved.contestDigest -> sets problem_breakdown_unavailable: true
  await writeFile(cfManifestPath, JSON.stringify({ ...cfManifestRaw, problems: [{ id: 'A', max_points: 9999 }] }));
  const cfTampered = await readRunProgress(root, cfRun);
  assert.equal(cfTampered.problem_breakdown_unavailable, true);
  assert.equal(cfTampered.problems[0].max_points, 1);

  // 3. Tampered local contest.json / judge.json (digest mismatch) is NOT trusted and marks breakdown unavailable
  const tamperedContest = join(root, 'tampered-contest.json');
  await writeFile(tamperedContest, JSON.stringify({ problems: [{ id: 'FAKE', max_points: 9999 }] }));
  const { runId: tamperedRun } = await createRunFixture(root, {
    localInputs: { contest: tamperedContest },
    inputSha256: { contest: 'f'.repeat(64) }, // does not match tamperedContest
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 1_000, type: 'run_ended', status: 'completed', reason: 'finish', score: 0, max_score: 10 },
    ],
  });
  const tamperedProg = await readRunProgress(root, tamperedRun);
  assert.equal(tamperedProg.problem_breakdown_unavailable, true);
  assert.equal(tamperedProg.problem_count, 0);
  assert.equal(tamperedProg.max_score, 10);

  // 4. Symlinked run directory, swapped directory, and symlinked session directory are rejected
  const externalDir = await mkdtemp(join(tmpdir(), 'cr-outside-'));
  t.after(() => rm(externalDir, { recursive: true, force: true }));
  await writeFile(join(externalDir, 'run.json'), '{}');
  await writeFile(join(externalDir, 'agent.stdout.log'), 'outside');
  const symRunId = randomUUID();
  await symlink(externalDir, join(root, symRunId));
  await assert.rejects(readRunProgress(root, symRunId), /symlink/i);
  await assert.rejects(readRunLogSlice(root, symRunId, 'stdout'), /symlink/i);

  // Directory replacement: real run dir removed and replaced by symlink is rejected
  const { runId: replacedRunId, dir: replacedDir } = await createRunFixture(root, {
    problems: [{ id: 'A', max_points: 1 }],
    events: [{ elapsed_ms: 0, type: 'run_started' }],
  });
  await rm(replacedDir, { recursive: true, force: true });
  await symlink(externalDir, replacedDir);
  await assert.rejects(readRunProgress(root, replacedRunId), /symlink/i);

  const { runId: symSessionRun, dir: symSessionDir } = await createRunFixture(root, {
    problems: [{ id: 'A', max_points: 1 }],
    events: [{ elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' }],
  });
  await symlink(externalDir, join(symSessionDir, 'session'));
  await assert.rejects(buildRunReplay(root, symSessionRun, { includeSession: true }), /symlink/i);

  // 5. Corrupted mid-file JSON, bad schema_version, sequence gap, and post-run_ended events all throw explicitly
  const { runId: badJsonRun } = await createRunFixture(root, {
    problems: [{ id: 'A', max_points: 1 }],
    rawEventsContent: [
      JSON.stringify({ schema_version: 1, seq: 1, elapsed_ms: 0, type: 'run_started' }),
      '{"corrupted_mid_line": true',
      JSON.stringify({ schema_version: 1, seq: 2, elapsed_ms: 1000, type: 'run_ended', status: 'completed' }),
      '',
    ].join('\n'),
  });
  await assert.rejects(readRunProgress(root, badJsonRun), /Corrupted run event log/);

  const { runId: badSchemaRun } = await createRunFixture(root, {
    problems: [{ id: 'A', max_points: 1 }],
    rawEventsContent: JSON.stringify({ schema_version: 99, seq: 1, elapsed_ms: 0, type: 'run_started' }) + '\n',
  });
  await assert.rejects(readRunProgress(root, badSchemaRun), /schema_version/);

  const { runId: afterEndRun } = await createRunFixture(root, {
    problems: [{ id: 'A', max_points: 1 }],
    events: [
      { elapsed_ms: 0, type: 'run_started' },
      { elapsed_ms: 1000, type: 'run_ended', status: 'completed' },
      { elapsed_ms: 2000, type: 'submission_received', submission_id: 's1', problem_id: 'A' },
    ],
  });
  await assert.rejects(readRunProgress(root, afterEndRun), /after run_ended/);

  const { runId: seqGapRun } = await createRunFixture(root, {
    problems: [{ id: 'A', max_points: 1 }],
    events: [
      { seq: 1, elapsed_ms: 0, type: 'run_started' },
      { seq: 3, elapsed_ms: 1000, type: 'run_ended', status: 'completed' },
    ],
  });
  await assert.rejects(readRunProgress(root, seqGapRun), /invalid sequence number/);
});

test('progress and replay redact JSON secrets, file:// paths, Windows paths, and never leak answers or source when disabled', async t => {
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
      { elapsed_ms: 1500, type: 'run_ended', status: 'void', reason: `url=file://${hostPath} win=C:\\Users\\bob\\secret.txt {"cookie": "sess_secret_999"} Bearer ${secretToken}` },
    ],
  });

  await mkdir(join(dir, 'session'), { recursive: true });
  await writeFile(
    join(dir, 'session', 'transcript.jsonl'),
    JSON.stringify({ role: 'assistant', text: `path=${hostPath} {"api_key": "json-key-secret-777"} Bearer ${secretToken}` }) + '\n',
    'utf8',
  );

  const progress = await readRunProgress(root, runId);
  const progressJson = JSON.stringify(progress);
  for (const forbidden of [
    secretAnswer,
    secretToken,
    secretSource,
    hostPath,
    '/home/alice',
    'C:\\Users\\bob',
    'sess_secret_999',
    'private.internal.example',
  ]) {
    assert.ok(!progressJson.includes(forbidden), `Progress leaked forbidden string: ${forbidden}`);
  }

  const replayNoSrc = await buildRunReplay(root, runId, { includeSession: true, includeSources: false });
  const replayJson = JSON.stringify(replayNoSrc);
  for (const forbidden of [secretAnswer, secretToken, secretSource, hostPath, 'json-key-secret-777']) {
    assert.ok(!replayJson.includes(forbidden), `Replay leaked forbidden string: ${forbidden}`);
  }
  assert.equal(replayNoSrc.session_summaries?.length, 1);
  assert.match(replayNoSrc.session_summaries[0].entries[0].summary, /\[path\]/);
  assert.match(replayNoSrc.session_summaries[0].entries[0].summary, /\[REDACTED\]/);
});

test('readRunLogSlice handles ENOENT, UTF-8 boundary slicing, live EOF half-character writes, and truncation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-log-slice-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const runId = randomUUID();
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });

  const empty = await readRunLogSlice(root, runId, 'stdout');
  assert.doesNotThrow(() => logSliceSchema.parse(empty));
  assert.deepEqual(empty, { stream: 'stdout', offset: 0, next_offset: 0, total_bytes: 0, has_more: false, chunk: '' });

  // Live EOF write with half of a 3-byte UTF-8 character ('中' = E4 B8 AD) flushed to disk
  const logPath = join(dir, 'agent.stdout.log');
  const fullChar = Buffer.from('hi-中', 'utf8'); // 3 ASCII bytes + 3 UTF-8 bytes
  await writeFile(logPath, fullChar.subarray(0, 5)); // Ends with E4 B8 (incomplete!)
  const livePartial = await readRunLogSlice(root, runId, 'stdout', 0, 64);
  assert.equal(livePartial.chunk, 'hi-');
  assert.ok(!livePartial.chunk.includes('\uFFFD'), 'Must never emit replacement char on live partial UTF-8 tail');
  assert.equal(livePartial.next_offset, 3);
  assert.equal(livePartial.has_more, false);

  // Writer flushes final byte (AD) -> next poll from offset 3 reads complete '中'
  await writeFile(logPath, fullChar);
  const liveCompleted = await readRunLogSlice(root, runId, 'stdout', livePartial.next_offset, 64);
  assert.equal(liveCompleted.chunk, '中');
  assert.equal(liveCompleted.next_offset, 6);
  assert.equal(liveCompleted.has_more, false);

  // Multi-slice polling with small maxBytes (clamped min 4) across CJK + 4-byte emoji
  const initialContent = 'start-中文测试日志-🚀-line1\n第二行🎯done\n';
  await writeFile(logPath, initialContent, 'utf8');
  let offset = 0;
  let assembled = '';
  while (true) {
    const slice = await readRunLogSlice(root, runId, 'stdout', offset, 2); // clamps to 4 bytes
    assert.ok(!slice.chunk.includes('\uFFFD'));
    assembled += slice.chunk;
    offset = slice.next_offset;
    if (!slice.has_more) break;
  }
  assert.equal(assembled, initialContent);

  // Truncation resets cleanly to offset 0
  await writeFile(logPath, 'reset\n', 'utf8');
  const afterTruncate = await readRunLogSlice(root, runId, 'stdout', offset, 64);
  assert.equal(afterTruncate.offset, 0);
  assert.equal(afterTruncate.chunk, 'reset\n');
});

test('buildRunReplay builds diffs and projectScoreAt does NOT prematurely reveal post-contest settled verdicts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-replay-settle-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const srcV1 = 'int main() {\n  return 1;\n}\n';
  const srcV2 = 'int main() {\n  return 0;\n}\n';

  const { runId } = await createRunFixture(root, {
    scoringMode: 'icpc',
    timeLimitMs: 60_000,
    problems: [{ id: 'A', max_points: 500 }],
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 20_000, type: 'submission_received', submission_id: 's1', problem_id: 'A', language: 'cpp17', source: srcV1 },
      { elapsed_ms: 22_000, type: 'submission_judged', submission_id: 's1', verdict: 'WRONG_ANSWER' },
      // Submitted at 59s (before 60s time limit), but settled at 75s (after time limit)!
      { elapsed_ms: 59_000, type: 'submission_received', submission_id: 's2', problem_id: 'A', language: 'cpp17', source: srcV2 },
      { elapsed_ms: 60_000, type: 'settling' },
      { elapsed_ms: 75_000, type: 'submission_judged', submission_id: 's2', verdict: 'OK' },
      { elapsed_ms: 76_000, type: 'run_ended', status: 'completed', reason: 'time_limit', score: 500, max_score: 500 },
    ],
  });

  const replay = await buildRunReplay(root, runId, { includeSources: true });
  assert.doesNotThrow(() => runReplaySchema.parse(replay));
  assert.match(replay.frames.find(f => f.submission_id === 's2' && f.kind === 'submission_received').diff, /-  return 1;\n\+  return 0;/);
  assert.equal(unifiedLineDiff('x\n', 'x\n'), '');

  // At t = 60_000 (end of contest, BEFORE judged_ms = 75_000): verdict MUST remain pending!
  const atLimit = projectScoreAt(replay, 60_000, 'icpc');
  assert.equal(atLimit.solved_count, 0);
  assert.equal(atLimit.problems[0].status, 'pending');

  // At t = 75_000 (settlement complete): verdict is accepted, scored/penalized by received_ms = 59_000!
  const atSettled = projectScoreAt(replay, 75_000, 'icpc');
  assert.equal(atSettled.solved_count, 1);
  assert.equal(atSettled.score, 1);
  assert.equal(atSettled.problems[0].first_ac_ms, 59_000);
  assert.equal(atSettled.penalty, 20); // floor(59_000 / 60_000) + 1*20 = 20
});

test('buildGhostRace enforces strict compatibility, isolates void runs, marks running provisional, and fixes last_ac ranking', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-ghost-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const problems = [
    { id: 'A', max_points: 500 },
    { id: 'B', max_points: 1000 },
    { id: 'C', max_points: 1500 },
  ];
  const timeLimitMs = 3_600_000;

  const { runId: alphaId } = await createRunFixture(root, {
    contestId: 'cf-ghost-1',
    agentId: 'alpha',
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

  // Running (provisional) agent with 0 full ACs and 500 partial on B (tests last_ac 0-solve ranking fix!)
  const { runId: partialZeroAcId } = await createRunFixture(root, {
    contestId: 'cf-ghost-1',
    agentId: 'partial-only',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 100_000, type: 'submission_received', submission_id: 'p1', problem_id: 'B', language: 'cpp20', source: 'B' },
      { elapsed_ms: 101_000, type: 'submission_judged', submission_id: 'p1', verdict: 'partial', points_awarded: 500 },
    ],
  });

  // Void agent that solved everything before voiding -> MUST be unranked (rank: null, score: 0, placed last)
  const { runId: voidId } = await createRunFixture(root, {
    contestId: 'cf-ghost-1',
    agentId: 'void-agent',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started', started_at: '2026-04-01T00:00:00.000Z' },
      { elapsed_ms: 10_000, type: 'submission_received', submission_id: 'v1', problem_id: 'A', language: 'cpp20', source: 'A' },
      { elapsed_ms: 11_000, type: 'submission_judged', submission_id: 'v1', verdict: 'OK', points_awarded: 500 },
      { elapsed_ms: 20_000, type: 'run_ended', status: 'void', reason: 'judge_unsettled', score: null, max_score: 3000 },
    ],
  });

  const race = await buildGhostRace(root, [alphaId, partialZeroAcId, voidId], { scoringMode: 'last_ac', sampleStepMs: 900_000 });
  assert.doesNotThrow(() => ghostRaceSchema.parse(race));
  assert.doesNotThrow(() => ghostRaceSchema.parse(JSON.parse(JSON.stringify(race))));

  // At t = 310_000 in last_ac:
  // alpha: score=500, solved=1, last_ac_ms=300_000
  // partial-only: score=500, solved=0, last_ac_ms=0 -> MUST NOT beat alpha despite last_ac_ms=0!
  // void-agent: unranked, rank=null, placed last!
  const at310s = race.evaluateAt(310_000, 'last_ac');
  assert.deepEqual(
    at310s.standings.map(s => ({ id: s.agent_id, rank: s.rank, score: s.score, provisional: s.provisional, unranked: s.unranked })),
    [
      { id: 'alpha', rank: 1, score: 500, provisional: false, unranked: false },
      { id: 'partial-only', rank: 2, score: 500, provisional: true, unranked: false },
      { id: 'void-agent', rank: null, score: 0, provisional: false, unranked: true },
    ],
  );
  // Non-IOI partial score must show status 'partial', not 'wrong'
  const partialRow = at310s.standings.find(s => s.agent_id === 'partial-only');
  assert.equal(partialRow.problems.find(p => p.id === 'B').status, 'partial');

  // Standalone evaluateGhostRaceAt matches method
  assert.deepEqual(evaluateGhostRaceAt(JSON.parse(JSON.stringify(race)), 310_000, 'last_ac'), at310s);

  // Exact CF and IOI final score assertions
  const cfFinal = race.evaluateAt(2_000_000, 'cf');
  // alpha: A(500*(1 - 0.5*5/60) = 479.17) + B(1000*(1 - 0.5*15/60) - 50 = 825) = 1304.17
  assert.equal(cfFinal.standings[0].agent_id, 'alpha');
  assert.equal(cfFinal.standings[0].score, 1304.17);
  const ioiFinal = race.evaluateAt(2_000_000, 'ioi');
  assert.equal(ioiFinal.standings[0].agent_id, 'alpha');
  assert.equal(ioiFinal.standings[0].score, 2100);
  assert.equal(ioiFinal.standings[1].agent_id, 'partial-only');
  assert.equal(ioiFinal.standings[1].score, 500);

  // Compatibility rejections: data_version, contest_revision, protocol_sha256, missing metadata, time_limit_ms, problem set/weight
  const incompatCases = [
    { label: 'data_version', opts: { contestId: 'cf-ghost-1', dataVersion: 2, timeLimitMs, problems }, pattern: /Data version mismatch/ },
    { label: 'contest_revision', opts: { contestId: 'cf-ghost-1', contestRevision: 'c'.repeat(64), timeLimitMs, problems }, pattern: /Contest revision mismatch/ },
    { label: 'protocol_sha256', opts: { contestId: 'cf-ghost-1', protocolSha256: 'd'.repeat(64), timeLimitMs, problems }, pattern: /Protocol mismatch/ },
    { label: 'missing_protocol', opts: { contestId: 'cf-ghost-1', protocolSha256: null, timeLimitMs, problems }, pattern: /missing required compatibility metadata/ },
    { label: 'time_limit_ms', opts: { contestId: 'cf-ghost-1', timeLimitMs: 1_800_000, problems }, pattern: /Time limit mismatch/ },
    { label: 'problem_set_diff', opts: { contestId: 'cf-ghost-1', timeLimitMs, problems: [{ id: 'A', max_points: 500 }, { id: 'B', max_points: 1000 }] }, pattern: /Problem set or weight mismatch/ },
    { label: 'problem_weight', opts: { contestId: 'cf-ghost-1', timeLimitMs, problems: [{ id: 'A', max_points: 999 }, { id: 'B', max_points: 1000 }, { id: 'C', max_points: 1500 }] }, pattern: /Problem set or weight mismatch/ },
  ];
  for (const tc of incompatCases) {
    const { runId: badId } = await createRunFixture(root, {
      ...tc.opts,
      events: [{ elapsed_ms: 0, type: 'run_started' }],
    });
    await assert.rejects(buildGhostRace(root, [alphaId, badId]), tc.pattern, `Failed to reject ${tc.label}`);
  }
});

test('last_ac aligns with runner/results.ts (score then last_ac_ms without solved_count tiebreak) and IOI handles contradictory verdicts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-last-ac-ioi-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const problems = [
    { id: 'P1', max_points: 500 },
    { id: 'P2', max_points: 250 },
    { id: 'P3', max_points: 250 },
  ];
  const timeLimitMs = 60_000;

  // Agent FastOne: 1 solve (P1 = 500) at 10ms -> score 500, last_ac 10ms
  const { runId: fastOneId } = await createRunFixture(root, {
    contestId: 'tie-test',
    agentId: 'fast-one',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started' },
      { elapsed_ms: 10, type: 'submission_received', submission_id: 's1', problem_id: 'P1' },
      { elapsed_ms: 10, type: 'submission_judged', submission_id: 's1', verdict: 'accepted', points_awarded: 500 },
      { elapsed_ms: 15, type: 'run_ended', status: 'completed', reason: 'finish', score: 500, max_score: 1000 },
    ],
  });

  // Agent SlowTwo: 2 solves (P2 = 250 @ 20ms, P3 = 250 @ 40ms) -> score 500, last_ac 40ms
  const { runId: slowTwoId } = await createRunFixture(root, {
    contestId: 'tie-test',
    agentId: 'slow-two',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started' },
      { elapsed_ms: 20, type: 'submission_received', submission_id: 's1', problem_id: 'P2' },
      { elapsed_ms: 20, type: 'submission_judged', submission_id: 's1', verdict: 'accepted', points_awarded: 250 },
      { elapsed_ms: 40, type: 'submission_received', submission_id: 's2', problem_id: 'P3' },
      { elapsed_ms: 40, type: 'submission_judged', submission_id: 's2', verdict: 'accepted', points_awarded: 250 },
      { elapsed_ms: 45, type: 'run_ended', status: 'completed', reason: 'finish', score: 500, max_score: 1000 },
    ],
  });

  // Agent TieOne: 1 solve (P1 = 500) at 40ms -> exact tie with SlowTwo on score=500 & last_ac=40ms!
  const { runId: tieOneId } = await createRunFixture(root, {
    contestId: 'tie-test',
    agentId: 'tie-one',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started' },
      { elapsed_ms: 40, type: 'submission_received', submission_id: 's1', problem_id: 'P1' },
      { elapsed_ms: 40, type: 'submission_judged', submission_id: 's1', verdict: 'accepted', points_awarded: 500 },
      { elapsed_ms: 45, type: 'run_ended', status: 'completed', reason: 'finish', score: 500, max_score: 1000 },
    ],
  });

  const race = await buildGhostRace(root, [fastOneId, slowTwoId, tieOneId], { scoringMode: 'last_ac' });
  const final = race.evaluateAt(60_000, 'last_ac');
  // 10ms 1-solve beats 40ms 2-solves; 40ms 1-solve and 40ms 2-solves share rank 2!
  assert.equal(final.standings[0].agent_id, 'fast-one');
  assert.equal(final.standings[0].rank, 1);
  assert.equal(final.standings[0].score, 500);
  assert.equal(final.standings[0].last_ac_ms, 10);
  const tied = final.standings.slice(1).map(s => ({ id: s.agent_id, rank: s.rank, score: s.score, last_ac_ms: s.last_ac_ms }))
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(tied, [
    { id: 'slow-two', rank: 2, score: 500, last_ac_ms: 40 },
    { id: 'tie-one', rank: 2, score: 500, last_ac_ms: 40 },
  ]);

  // IOI contradictory inputs:
  // P1: verdict='AC' but score=60 < 500 -> partial (NOT solved!)
  // P2: verdict='WRONG_ANSWER' with score=250 == 250 -> NOT solved!
  // P3: verdict='partial' with score=250 == 250 -> solved!
  const { runId: ioiContraId } = await createRunFixture(root, {
    contestId: 'ioi-contra',
    scoringMode: 'ioi',
    timeLimitMs,
    problems,
    events: [
      { elapsed_ms: 0, type: 'run_started' },
      { elapsed_ms: 10, type: 'submission_received', submission_id: 's1', problem_id: 'P1' },
      { elapsed_ms: 10, type: 'submission_judged', submission_id: 's1', verdict: 'AC', score: 60 },
      { elapsed_ms: 20, type: 'submission_received', submission_id: 's2', problem_id: 'P2' },
      { elapsed_ms: 20, type: 'submission_judged', submission_id: 's2', verdict: 'WRONG_ANSWER', score: 250 },
      { elapsed_ms: 30, type: 'submission_received', submission_id: 's3', problem_id: 'P3' },
      { elapsed_ms: 30, type: 'submission_judged', submission_id: 's3', verdict: 'partial', score: 250 },
      { elapsed_ms: 35, type: 'run_ended', status: 'completed', reason: 'finish', score: 560, max_score: 1000 },
    ],
  });
  const ioiProg = await readRunProgress(root, ioiContraId);
  assert.equal(ioiProg.solved_count, 1);
  assert.equal(ioiProg.problems[0].status, 'partial');
  assert.equal(ioiProg.problems[1].status, 'partial');
  assert.equal(ioiProg.problems[2].status, 'accepted');
});
