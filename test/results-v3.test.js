import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  protocol, protocolDigest, protocolDigestForPreset, protocolForPreset, protocolPresets,
  resolveProtocolPreset, resolveScoringMode,
} from '../dist/protocol.js';
import { agentRevision, loadAgent, loadContest } from '../dist/config.js';
import { Connections } from '../dist/connections.js';
import { agentCatalog } from '../dist/catalog.js';
import { makePlan, verifyJob, verifyPlan } from '../dist/plan.js';
import { enqueue, summarize } from '../dist/queue.js';
import { archiveSessionDir } from '../dist/run.js';
import {
  exportRun, mergeResults, rankResults, rankResultsGrouped, resultBundle, resultsSchema, scoreResult,
} from '../dist/results.js';

const fakeImage = 'sha256:' + 'a'.repeat(64);
const getImage = async () => fakeImage;

test('protocol presets define relaxed limits, derive cleanly from time_limit_ms, and produce distinct digests', async t => {
  assert.equal(protocolPresets.short.maxTurns, 64);
  assert.equal(protocolPresets.short.requestTimeoutMs, 360_000);
  assert.equal(protocolPresets.short.pdfMaxPages, 64);
  assert.equal(protocolPresets.short.pdfMaxBytes, 32_000_000);
  assert.equal(protocolPresets.short.diagnosticMaxBytes, 8 * 1024 * 1024);
  assert.equal(protocolPresets.short.settlementMs, 120_000);
  assert.deepEqual(protocolPresets.short.sandbox, { memory: '4g', cpus: '2', pids: 256, workspace: '512m' });

  assert.equal(protocolPresets['cf-2h'].maxTurns, 192);
  assert.equal(protocolPresets['cf-2h'].requestTimeoutMs, 600_000);
  assert.equal(protocolPresets['cf-2h'].pdfMaxPages, 96);
  assert.equal(protocolPresets['cf-2h'].pdfMaxBytes, 64_000_000);
  assert.equal(protocolPresets['cf-2h'].diagnosticMaxBytes, 16 * 1024 * 1024);
  assert.equal(protocolPresets['cf-2h'].settlementMs, 240_000);
  assert.deepEqual(protocolPresets['cf-2h'].sandbox, { memory: '4g', cpus: '2', pids: 256, workspace: '512m' });

  assert.equal(protocolPresets['icpc-5h'].maxTurns, 512);
  assert.equal(protocolPresets['icpc-5h'].requestTimeoutMs, 600_000);
  assert.equal(protocolPresets['icpc-5h'].pdfMaxPages, 128);
  assert.equal(protocolPresets['icpc-5h'].pdfMaxBytes, 64_000_000);
  assert.equal(protocolPresets['icpc-5h'].diagnosticMaxBytes, 16 * 1024 * 1024);
  assert.equal(protocolPresets['icpc-5h'].settlementMs, 300_000);
  assert.deepEqual(protocolPresets['icpc-5h'].sandbox, { memory: '4g', cpus: '2', pids: 256, workspace: '1g' });

  assert.equal(resolveProtocolPreset({ time_limit_ms: 15 * 60_000 }), 'short');
  assert.equal(resolveProtocolPreset({ time_limit_ms: 30 * 60_000 }), 'short');
  assert.equal(resolveProtocolPreset({ time_limit_ms: 120 * 60_000 }), 'cf-2h');
  assert.equal(resolveProtocolPreset({ time_limit_ms: 180 * 60_000 }), 'cf-2h');
  assert.equal(resolveProtocolPreset({ time_limit_ms: 300 * 60_000 }), 'icpc-5h');
  assert.equal(resolveProtocolPreset({ time_limit_ms: 15 * 60_000, protocol_preset: 'icpc-5h' }), 'icpc-5h');
  assert.equal(resolveScoringMode(), 'last_ac');
  assert.equal(resolveScoringMode({ scoring_mode: 'icpc' }), 'icpc');

  assert.equal(protocol.maxTurns, 64);
  assert.equal(protocolDigest, protocolDigestForPreset('short'));
  assert.notEqual(protocolDigestForPreset('short'), protocolDigestForPreset('cf-2h'));
  assert.notEqual(protocolDigestForPreset('cf-2h'), protocolDigestForPreset('icpc-5h'));
  assert.equal(protocolForPreset('icpc-5h').codex.settlementMs, 300_000);

  const dir = await mkdtemp(join(tmpdir(), 'cr-preset-contest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(resolve('examples/demo/problems.pdf'), join(dir, 'problems.pdf'));
  await cp(resolve('examples/demo/judge.json'), join(dir, 'judge.json'));
  const contestFile = join(dir, 'contest.json');
  await writeFile(contestFile, JSON.stringify({
    schema_version: 2,
    contest_id: 'icpc-regional',
    data_version: 1,
    title: 'ICPC Regional',
    source: { name: 'Fixture' },
    materials: { entrypoint: { kind: 'pdf', path: 'problems.pdf' } },
    judge: { kind: 'local', answers: { path: 'judge.json' } },
    rules: { time_limit_ms: 5 * 60 * 60_000, max_submissions: 300, protocol_preset: 'icpc-5h', scoring_mode: 'icpc' },
  }));
  const loaded = await loadContest(contestFile);
  assert.equal(loaded.contest.rules.protocol_preset, 'icpc-5h');
  assert.equal(loaded.contest.rules.scoring_mode, 'icpc');
});

test('Agent name does not affect agent_revision or invalidate plans, while service_tier does', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-agent-meta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Connections(join(dir, '.providers'));
  const prev = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  t.after(() => { if (prev === undefined) delete process.env.CR_CREDENTIAL_STORAGE; else process.env.CR_CREDENTIAL_STORAGE = prev; });

  await store.create({ id: 'openai', label: 'OpenAI', protocol: 'passthrough', base_url: 'https://api.openai.com/v1', secret: 'fixture-key', supports_fast: true });

  const agentFile = join(dir, 'agent.json');
  const baseDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'gpt-high',
    name: '  GPT-5.3 (High · 标准版)  ',
    vendor: 'openai',
    model: 'gpt-5.3-codex',
    speed_tier: 'fast',
    provider: 'openai',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'high' } },
  };
  await writeFile(agentFile, JSON.stringify(baseDoc));
  const initial = await loadAgent(agentFile, store);
  assert.equal(initial.agentName, 'GPT-5.3 (High · 标准版)');
  assert.equal(initial.speedTier, 'fast');

  // Plan created before renaming
  const plan = await makePlan({
    schema_version: 2,
    cells: [{ agent: agentFile, contest: resolve('examples/demo/contest.json') }],
  }, dir, getImage, store);
  assert.equal(plan.jobs[0].agent_name, 'GPT-5.3 (High · 标准版)');
  assert.equal(plan.jobs[0].speed_tier, 'fast');
  assert.equal(plan.jobs[0].protocol_preset, 'short');

  // Catalog & queue summary surface name and speed_tier
  const catalog = await agentCatalog(dir, store);
  assert.equal(catalog[0].name, 'GPT-5.3 (High · 标准版)');
  assert.equal(catalog[0].speed_tier, 'fast');
  const batch = await enqueue(join(dir, 'runs'), plan);
  const summary = summarize(batch);
  assert.equal(summary.jobs[0].agent_name, 'GPT-5.3 (High · 标准版)');
  assert.equal(summary.jobs[0].speed_tier, 'fast');

  // Rename the agent: profileDigest, effectiveDigest, and agent_revision MUST stay identical, and plan MUST remain valid!
  await writeFile(agentFile, JSON.stringify({ ...baseDoc, name: 'GPT-5.3 Renamed Display Label' }));
  const renamed = await loadAgent(agentFile, store);
  assert.equal(renamed.agentName, 'GPT-5.3 Renamed Display Label');
  assert.equal(renamed.profileDigest, initial.profileDigest);
  assert.equal(renamed.effectiveDigest, initial.effectiveDigest);
  assert.equal(agentRevision(renamed, fakeImage, protocolDigest), agentRevision(initial, fakeImage, protocolDigest));
  await verifyPlan(plan, true, store);
  await verifyJob(plan, plan.jobs[0], store);

  // Change execution-affecting service_tier: effectiveDigest & agent_revision MUST change, invalidating existing plan!
  await writeFile(agentFile, JSON.stringify({
    ...baseDoc,
    harness: { ...baseDoc.harness, options: { reasoning_effort: 'high', service_tier: 'priority' } },
  }));
  const priority = await loadAgent(agentFile, store);
  assert.equal(priority.profile.service_tier, 'priority');
  assert.notEqual(priority.effectiveDigest, initial.effectiveDigest);
  assert.notEqual(agentRevision(priority, fakeImage, protocolDigest), agentRevision(initial, fakeImage, protocolDigest));
  await assert.rejects(verifyPlan(plan, false, store), /regenerate the plan/);

  // CLI cr agent init supports --name, --speed-tier, --service-tier
  const cliOut = join(dir, 'cli-agent.yaml');
  const initRes = spawnSync(process.execPath, [
    'dist/cli.js', 'agent', 'init', cliOut,
    '--id', 'cli-fast', '--name', 'CLI Fast Runner', '--harness', 'codex',
    '--model', 'gpt-5.3-codex', '--provider', 'openai', '--vendor', 'openai',
    '--speed-tier', 'ultrafast', '--service-tier', 'fast', '--reasoning-effort', 'medium',
  ], { encoding: 'utf8', env: { ...process.env, CR_CONNECTIONS_DIR: store.root } });
  assert.equal(initRes.status, 0, initRes.stderr);
  const cliLoaded = await loadAgent(cliOut, store);
  assert.equal(cliLoaded.agentName, 'CLI Fast Runner');
  assert.equal(cliLoaded.speedTier, 'ultrafast');
  assert.equal(cliLoaded.profile.service_tier, 'fast');
});

test('results.json v3 export collects telemetry/submissions, reads v1/v2/v3, scores icpc/ioi/cf/last_ac, and groups via Policy C', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-results-v3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = randomUUID();
  const runDir = join(root, runId);
  const hash = 'c'.repeat(64);
  await mkdir(runDir);
  await writeFile(join(runDir, 'run.json'), JSON.stringify({
    schema_version: 1,
    run_id: runId,
    contest_id: 'cf-round',
    contest_title: 'CF Round',
    data_version: 1,
    contest_revision: hash,
    input_sha256: { contest: hash },
    problems: [{ id: 'A', max_points: 500 }, { id: 'B', max_points: 1000 }],
    protocol_id: 'codex-pdf-pages-mcp',
    protocol_version: 2,
    protocol_preset: 'cf-2h',
    scoring_mode: 'icpc',
    protocol_sha256: hash,
    agent_id: 'gpt-high-fast',
    agent_name: 'GPT-5.3 High (Fast)',
    agent_revision: hash,
    harness: { kind: 'codex', version: '0.170.0' },
    model: {
      model: 'gpt-5.3-codex', vendor: 'openai', reasoning_effort: 'high',
      speed_tier: 'fast', service_tier: 'priority', base_url: 'https://private.internal/v1',
    },
    local_inputs: { pdf: '/secret/path.pdf' },
  }));
  const events = [
    { type: 'run_started', elapsed_ms: 0 },
    { type: 'model_request', turn: 1, elapsed_ms: 100 },
    { type: 'model_response', turn: 1, model: 'gpt-5.3-codex-2026-01', elapsed_ms: 900, ttft_ms: 250 },
    { type: 'model_usage', turn: 1, elapsed_ms: 1500, usage: { input_tokens: 1200, output_tokens: 300 } },
    { type: 'model_timing', turn: 1, elapsed_ms: 1500, ttft_ms: 250, duration_ms: 1400 },
    { type: 'submission_received', submission_id: 's1', problem_id: 'A', language: 'cpp20', source: 'int secret(){}', elapsed_ms: 120_000 },
    { type: 'submission_delivered', submission_id: 's1', remote_submission_id: 9001, elapsed_ms: 120_500 },
    { type: 'submission_judged', submission_id: 's1', verdict: 'WRONG_ANSWER', remote_submission_id: 9001, elapsed_ms: 125_000 },
    { type: 'model_request', turn: 2, elapsed_ms: 130_000 },
    { type: 'model_usage', turn: 2, elapsed_ms: 132_000, usage: { input_tokens: 1800, output_tokens: 450 } },
    { type: 'model_timing', turn: 2, elapsed_ms: 132_000, ttft_ms: 200, duration_ms: 2100 },
    { type: 'submission_received', submission_id: 's2', problem_id: 'A', language: 'cpp20', source: 'int main(){}', elapsed_ms: 600_000 },
    { type: 'submission_judged', submission_id: 's2', verdict: 'OK', remote_submission_id: 9002, elapsed_ms: 605_000 },
    { type: 'run_ended', status: 'completed', reason: 'finish', score: 500, max_score: 1500, elapsed_ms: 610_000 },
  ];
  await writeFile(join(runDir, 'events.jsonl'), events.map((e, i) => JSON.stringify({ schema_version: 1, seq: i + 1, ...e })).join('\n') + '\n');

  const exported = await exportRun(root, runId);
  assert.doesNotMatch(JSON.stringify(exported), /secret|private/);
  assert.equal(exported.agent_name, 'GPT-5.3 High (Fast)');
  assert.equal(exported.protocol_preset, 'cf-2h');
  assert.equal(exported.scoring_mode, 'icpc');
  assert.equal(exported.model.speed_tier, 'fast');
  assert.equal(exported.model.service_tier, 'priority');
  assert.deepEqual(exported.telemetry, {
    model_turns: 2,
    model_wait_ms: 3500,
    total_input_tokens: 3000,
    total_output_tokens: 750,
    wall_ms: 610_000,
  });
  assert.equal(exported.submissions[0].language, 'cpp20');
  assert.equal(exported.submissions[0].remote_submission_id, 9001);
  assert.equal(exported.submissions[0].max_points, 500);
  assert.equal(exported.submissions[1].score, 500);

  // Switchable scoring checks
  // ICPC: Problem A solved at 600_000ms (10 min) + 1 WA (20 min) = 30 min penalty
  const icpc = scoreResult(exported, 'icpc');
  assert.equal(icpc.solved, 1);
  assert.equal(icpc.penalty_minutes, 30);

  // CF: 500 * (1 - 10/250) - 50 * 1 = 480 - 50 = 430
  const cf = scoreResult(exported, 'cf');
  assert.equal(cf.points, 430);

  // IOI: partial scores across multiple attempts take per-problem maximum
  const ioiSample = {
    ...exported,
    run_id: randomUUID(),
    score: 130,
    max_score: 200,
    submissions: [
      { id: 's1', problem_id: 'A', elapsed_ms: 60_000, verdict: 'partial', score: 40, max_points: 100 },
      { id: 's2', problem_id: 'A', elapsed_ms: 120_000, verdict: 'partial', score: 70, max_points: 100 },
      { id: 's3', problem_id: 'A', elapsed_ms: 180_000, verdict: 'partial', score: 50, max_points: 100 },
      { id: 's4', problem_id: 'B', elapsed_ms: 240_000, verdict: 'partial', score: 60, max_points: 100 },
    ],
  };
  const ioi = scoreResult(ioiSample, 'ioi');
  assert.equal(ioi.points, 130);
  assert.equal(ioi.per_problem.A.points, 70);
  assert.equal(ioi.per_problem.B.points, 60);

  // Policy C grouping: 3 runs of openai/gpt-5.3-codex across variants (including duplicate variant) + 1 run of anthropic/claude-4.5
  const variantFast = {
    ...exported,
    run_id: randomUUID(),
    agent_id: 'gpt-high-fast',
    agent_revision: '1'.repeat(64),
    model: { requested: 'gpt-5.3-codex', observed: ['gpt-5.3-codex'], vendor: 'openai', reasoning_effort: 'high', speed_tier: 'fast' },
    score: 1500,
    submissions: [
      { id: 's1', problem_id: 'A', elapsed_ms: 300_000, verdict: 'OK', max_points: 500, score: 500 },
      { id: 's2', problem_id: 'B', elapsed_ms: 900_000, verdict: 'OK', max_points: 1000, score: 1000 },
    ],
  };
  const variantFastWorseDup = {
    ...variantFast,
    run_id: randomUUID(),
    score: 500,
    submissions: [
      { id: 's1', problem_id: 'A', elapsed_ms: 600_000, verdict: 'OK', max_points: 500, score: 500 },
    ],
  };
  const variantStd = {
    ...exported,
    run_id: randomUUID(),
    agent_id: 'gpt-high-std',
    agent_revision: '2'.repeat(64),
    model: { requested: 'gpt-5.3-codex', observed: ['gpt-5.3-codex'], vendor: 'openai', reasoning_effort: 'high', speed_tier: 'standard' },
    score: 1500,
    submissions: [
      { id: 's1', problem_id: 'A', elapsed_ms: 600_000, verdict: 'OK', max_points: 500, score: 500 },
      { id: 's2', problem_id: 'B', elapsed_ms: 1_800_000, verdict: 'OK', max_points: 1000, score: 1000 },
    ],
  };
  const claudeRun = {
    ...exported,
    run_id: randomUUID(),
    agent_id: 'claude-sonnet',
    agent_revision: '3'.repeat(64),
    model: { requested: 'claude-sonnet-4-5', observed: ['claude-sonnet-4-5'], vendor: 'anthropic', reasoning_effort: 'high', speed_tier: 'standard' },
    score: 1500,
    submissions: [
      { id: 's1', problem_id: 'A', elapsed_ms: 600_000, verdict: 'OK', max_points: 500, score: 500 },
      { id: 's2', problem_id: 'B', elapsed_ms: 1_200_000, verdict: 'OK', max_points: 1000, score: 1000 },
    ],
  };
  const bundleV3 = resultBundle([variantFastWorseDup, variantStd, claudeRun, variantFast]);
  assert.equal(bundleV3.schema_version, 3);
  assert.equal(resultsSchema.parse(bundleV3).schema_version, 3);

  const grouped = rankResultsGrouped(bundleV3, { scoring: 'icpc' })[0];
  assert.equal(grouped.length, 2);
  // Rank 1: openai/gpt-5.3-codex (primary = variantFast: 2 solved, penalty 5 + 15 = 20)
  assert.equal(grouped[0].rank, 1);
  assert.equal(grouped[0].result.run_id, variantFast.run_id);
  assert.equal(grouped[0].scoring.penalty_minutes, 20);
  // 2 distinct variants (fast + standard), worse duplicate of fast deduplicated!
  assert.equal(grouped[0].variants.length, 2);
  assert.deepEqual(grouped[0].variants.map(v => v.result.model.speed_tier), ['fast', 'standard']);

  // Rank 2: anthropic/claude-sonnet-4-5 (2 solved, penalty 10 + 20 = 30)
  assert.equal(grouped[1].rank, 2);
  assert.equal(grouped[1].result.run_id, claudeRun.run_id);
  assert.equal(grouped[1].scoring.penalty_minutes, 30);
  assert.equal(grouped[1].variants.length, 1);

  // Revision mode keeps all 3 distinct agent revisions flat
  const flat = rankResults(bundleV3, { scoring: 'icpc', groupBy: 'revision' })[0];
  assert.equal(flat.length, 3);
  assert.deepEqual(flat.map(r => r.result.run_id), [variantFast.run_id, claudeRun.run_id, variantStd.run_id]);

  // CLI cr results rank supports --scoring and --group-by
  const bundlePath = join(root, 'results.json');
  await writeFile(bundlePath, JSON.stringify(bundleV3));
  const cliRank = spawnSync(process.execPath, [
    'dist/cli.js', 'results', 'rank', bundlePath, '--scoring', 'cf', '--group-by', 'model',
  ], { encoding: 'utf8' });
  assert.equal(cliRank.status, 0, cliRank.stderr);
  const parsedRank = JSON.parse(cliRank.stdout);
  assert.equal(parsedRank[0].length, 2);
  assert.equal(parsedRank[0][0].scoring.mode, 'cf');
  assert.equal(parsedRank[0][0].variants.length, 2);

  // Backward compatibility: merge v1 + v2 + v3 -> v3
  const v1 = {
    schema_version: 1,
    results: [{
      run_id: randomUUID(), contest_id: 'cf-round', data_version: 1, contest_revision: hash,
      protocol_id: 'codex-pdf-pages-mcp', protocol_version: 2, protocol_sha256: hash,
      agent_id: 'legacy-v1', agent_revision: '4'.repeat(64), harness: { kind: 'codex', version: '0.170.0' },
      model: { requested: 'gpt-4.1', observed: ['gpt-4.1'] }, score: 500, max_score: 1500,
      submissions: [{ id: 's1', problem_id: 'A', elapsed_ms: 500_000, verdict: 'OK' }],
    }],
  };
  const v2 = {
    schema_version: 2,
    results: [{
      run_id: randomUUID(), contest_id: 'cf-round', data_version: 1, contest_revision: hash,
      protocol_id: 'codex-pdf-pages-mcp', protocol_version: 2, protocol_sha256: hash,
      agent_id: 'legacy-v2', agent_revision: '5'.repeat(64), harness: { kind: 'codex', version: '0.170.0' },
      model: { requested: 'gpt-4.1', observed: ['gpt-4.1'], vendor: 'openai' }, score: 500, max_score: 1500,
      submissions: [{ id: 's1', problem_id: 'A', elapsed_ms: 400_000, verdict: 'OK' }],
    }],
  };
  const merged = mergeResults([v1, v2, bundleV3]);
  assert.equal(merged.schema_version, 3);
  assert.equal(merged.results.length, 6);
});

test('archiveSessionDir copies nested session files with 0600 mode, redacts credentials, skips symlinks, and caps total size', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-session-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stage = join(dir, 'stage');
  const target = join(dir, 'target');
  const outside = join(dir, 'outside-secret.txt');
  const secretKey = 'super-secret-api-key-987654321';

  await writeFile(outside, 'HOST_ONLY_SECRET');
  await mkdir(join(stage, '2026', '04'), { recursive: true });
  // Write a file larger than one 64 KiB read chunk with the secret straddling the boundary
  const pad = 'x'.repeat(65_530);
  await writeFile(join(stage, '2026', '04', 'rollout.jsonl'), `${pad}${secretKey}\n{"ok":true}\n`);
  await symlink(outside, join(stage, 'escape.txt'));
  await symlink(dir, join(stage, 'escape-dir'));

  const files = await archiveSessionDir(stage, target, secretKey);
  assert.deepEqual(files, ['2026/04/rollout.jsonl']);
  const copiedPath = join(target, '2026', '04', 'rollout.jsonl');
  assert.equal((await stat(copiedPath)).mode & 0o777, 0o600);
  const content = await readFile(copiedPath, 'utf8');
  assert.ok(!content.includes(secretKey), 'Secret must be redacted across chunk boundary');
  assert.ok(content.includes('[REDACTED]'));
  assert.ok(content.includes('{"ok":true}'));
  await assert.rejects(stat(join(target, 'escape.txt')), { code: 'ENOENT' });
  await assert.rejects(stat(join(target, 'escape-dir')), { code: 'ENOENT' });

  // Byte cap enforcement
  const cappedTarget = join(dir, 'capped');
  const capped = await archiveSessionDir(stage, cappedTarget, secretKey, 128);
  assert.deepEqual(capped, ['2026/04/rollout.jsonl']);
  const cappedText = await readFile(join(cappedTarget, '2026', '04', 'rollout.jsonl'), 'utf8');
  assert.match(cappedText, /session archive truncated/);
  assert.ok(cappedText.length < 256);
});
