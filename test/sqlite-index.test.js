import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadAgent, loadContest, sha256 } from '../dist/config.js';
import { Connections } from '../dist/connections.js';
import { synthesizeTextContestPdf } from '../dist/pdf-synth.js';
import { specSchema } from '../dist/plan.js';
import { protocolDigest, protocolDigestForPreset } from '../dist/protocol.js';
import { toBatchSpec, WorkspaceIndex } from '../dist/sqlite-index.js';

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeContestFixture(base, contestId, dataVersion = 1, opts = {}) {
  const dir = join(base, 'contests', `${contestId}-v${dataVersion}`);
  await mkdir(dir, { recursive: true });
  await synthesizeTextContestPdf(
    [
      { id: 'A', title: 'Alpha', body: opts.bodyA ?? 'Find 1 + 1.' },
      { id: 'B', title: 'Beta', body: 'Find 2 + 2.' },
    ],
    join(dir, 'problems.pdf'),
    { title: `Contest ${contestId}`, overwrite: true },
  );
  const attachments = [];
  if (opts.withAttachment) {
    await writeFile(join(dir, 'helper.txt'), 'attachment data\n');
    attachments.push({ name: 'helper.txt', path: 'helper.txt' });
  }
  const judge =
    opts.judgeKind === 'codeforces'
      ? { kind: 'codeforces', contest_id: 1900, handle: 'bot', languages: { cpp20: 89 } }
      : { kind: 'local', answers: { path: 'judge.json' } };
  if (judge.kind === 'local') {
    await writeFile(
      join(dir, 'judge.json'),
      JSON.stringify({
        schema_version: 1,
        problems: [
          { id: 'A', max_points: 100, accepted_answers: [opts.answerA ?? '2'] },
          { id: 'B', max_points: 100, accepted_answers: ['4'] },
        ],
      }),
    );
  }
  const contestPath = join(dir, 'contest.json');
  await writeFile(
    contestPath,
    JSON.stringify(
      {
        schema_version: 2,
        contest_id: contestId,
        data_version: dataVersion,
        title: `Contest ${contestId.toUpperCase()}`,
        source: { name: 'Fixture' },
        materials: { entrypoint: { kind: 'pdf', path: 'problems.pdf' }, attachments },
        ...(judge.kind === 'codeforces' ? { problems: [{ id: 'A', max_points: 500 }, { id: 'B', max_points: 1000 }] } : {}),
        judge,
        rules: { time_limit_ms: 900_000, max_submissions: 50 },
      },
      null,
      2,
    ),
  );
  return contestPath;
}

async function writeAgentFixture(
  base,
  id,
  {
    name,
    vendor = 'openai',
    provider = 'p-main',
    speedTier = 'standard',
    harness = 'codex',
    model = 'gpt-5.3-codex',
    reasoningEffort = 'medium',
    nativeConfig,
  } = {},
) {
  const dir = join(base, 'agents');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${id}.json`);
  await writeFile(
    filePath,
    JSON.stringify(
      {
        kind: 'contestreplay.dev/agent',
        schema_version: 1,
        id,
        ...(name ? { name } : {}),
        vendor,
        model,
        speed_tier: speedTier,
        provider,
        harness: {
          kind: harness,
          version: harness === 'codex' ? '0.170.0' : '0.1.0',
          options: harness === 'codex' ? { reasoning_effort: reasoningEffort } : { temperature: 0 },
          ...(nativeConfig ? { native_config: nativeConfig } : {}),
        },
      },
      null,
      2,
    ),
  );
  return filePath;
}

async function writeRunFixture(
  root,
  {
    runId,
    agentId,
    agentName,
    agentRevision = 'a'.repeat(64),
    profileSha256,
    effectiveSha256,
    speedTier = 'standard',
    contestId,
    dataVersion,
    contestRevision,
    protocolSha256 = protocolDigestForPreset('short'),
    status,
    reason,
    score,
    maxScore,
    createdAt,
    includeTerminalEvent = true,
    eventsPaddingLines = 0,
  },
) {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  const agentDigests = {
    ...(profileSha256 ? { profile_sha256: profileSha256 } : {}),
    ...(effectiveSha256 ? { effective_sha256: effectiveSha256 } : {}),
  };
  await writeFile(
    join(dir, 'run.json'),
    JSON.stringify({
      schema_version: 2,
      run_id: runId,
      contest_id: contestId,
      data_version: dataVersion,
      ...(contestRevision ? { contest_revision: contestRevision } : {}),
      ...(protocolSha256 ? { protocol_sha256: protocolSha256 } : {}),
      agent_id: agentId,
      ...(agentName ? { agent_name: agentName } : {}),
      agent_revision: agentRevision,
      ...(Object.keys(agentDigests).length ? { agent_digests: agentDigests } : {}),
      model: { model: 'gpt-5.3-codex', ...(speedTier !== null ? { speed_tier: speedTier } : {}) },
      started_at: createdAt,
    }),
  );
  const events = [{ schema_version: 1, seq: 1, elapsed_ms: 0, type: 'run_started' }];
  for (let i = 0; i < eventsPaddingLines; i++) {
    events.push({
      schema_version: 1,
      seq: i + 2,
      elapsed_ms: i + 1,
      type: 'progress',
      detail: 'x'.repeat(200),
    });
  }
  if (includeTerminalEvent) {
    events.push({
      schema_version: 1,
      seq: events.length + 1,
      elapsed_ms: 12_000,
      type: 'run_ended',
      status,
      reason: reason ?? (status === 'completed' ? 'finish' : 'judge_error'),
      ...(score !== undefined ? { score } : {}),
      ...(maxScore !== undefined ? { max_score: maxScore } : {}),
    });
  }
  await writeFile(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

async function writeBatchFixture(root, batchId, jobs, createdAt) {
  const dir = join(root, '.batches');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${batchId}.json`),
    JSON.stringify({
      schema_version: 1,
      id: batchId,
      created_at: createdAt,
      plan: {
        schema_version: 2,
        protocol_sha256: protocolDigest,
        jobs: jobs.map(j => ({
          image: `sha256:${'2'.repeat(64)}`,
          harness: 'codex',
          agent_path: `/tmp/${j.agentId}.json`,
          agent_id: j.agentId,
          agent_revision: j.agentRevision ?? 'a'.repeat(64),
          ...(j.profileSha256 ? { profile_sha256: j.profileSha256 } : {}),
          ...(j.effectiveSha256 ? { effective_sha256: j.effectiveSha256 } : {}),
          ...(j.speedTier ? { speed_tier: j.speedTier } : {}),
          agent_sha256: '3'.repeat(64),
          contest_path: `/tmp/${j.contestId}.json`,
          contest_id: j.contestId,
          data_version: j.dataVersion,
          contest_sha256: j.contestSha256 ?? '5'.repeat(64),
        })),
      },
      jobs: jobs.map(j => ({
        status: j.status,
        ...(j.runId ? { run_id: j.runId } : {}),
        ...(j.reason ? { reason: j.reason } : {}),
      })),
    }),
  );
}

test('WorkspaceIndex syncs agents, contests, batches, runs incrementally and prunes deleted files', async t => {
  const base = await makeTempDir(t, 'cr-idx-base-');
  const root = await makeTempDir(t, 'cr-idx-root-');
  const connDir = await makeTempDir(t, 'cr-idx-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'p-main',
    label: 'Main Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-test-index-123456',
    supports_fast: true,
  });

  const a1Path = await writeAgentFixture(base, 'alpha', {
    name: 'Alpha Agent',
    vendor: 'openai',
    provider: 'p-main',
    speedTier: 'fast',
  });
  const a2Path = await writeAgentFixture(base, 'beta', {
    name: 'Beta Builtin',
    vendor: 'anthropic',
    provider: 'p-main',
    harness: 'builtin-responses',
    model: 'gpt-4.1-2025-04-14',
  });
  await writeAgentFixture(base, 'broken', { vendor: 'openai', provider: 'missing-provider' });
  const c1Path = await writeContestFixture(base, 'round-1', 1);
  const c2Path = await writeContestFixture(base, 'round-2', 1);

  const loadedAlpha = await loadAgent(a1Path, store);
  const loadedC1 = await loadContest(c1Path);
  const loadedC2 = await loadContest(c2Path);

  // Symlink should be skipped safely during workspace walk.
  await symlink(a1Path, join(base, 'agents', 'symlink-agent.json'));

  const run1 = randomUUID();
  const run2 = randomUUID();
  const batch1 = randomUUID();
  await writeRunFixture(root, {
    runId: run1,
    agentId: 'alpha',
    agentName: 'Alpha Agent',
    profileSha256: loadedAlpha.profileDigest,
    effectiveSha256: loadedAlpha.effectiveDigest,
    speedTier: 'fast',
    contestId: 'round-1',
    dataVersion: 1,
    contestRevision: loadedC1.contestRevision,
    status: 'completed',
    score: 150,
    maxScore: 200,
    createdAt: '2026-01-01T10:00:00.000Z',
  });
  await writeRunFixture(root, {
    runId: run2,
    agentId: 'alpha',
    agentName: 'Alpha Agent',
    profileSha256: loadedAlpha.profileDigest,
    effectiveSha256: loadedAlpha.effectiveDigest,
    speedTier: 'fast',
    contestId: 'round-2',
    dataVersion: 1,
    contestRevision: loadedC2.contestRevision,
    status: 'void',
    reason: 'judge_error',
    createdAt: '2026-01-01T11:00:00.000Z',
  });
  await writeBatchFixture(
    root,
    batch1,
    [
      {
        agentId: 'alpha',
        profileSha256: loadedAlpha.profileDigest,
        effectiveSha256: loadedAlpha.effectiveDigest,
        speedTier: 'fast',
        contestId: 'round-1',
        dataVersion: 1,
        contestSha256: loadedC1.contestDigest,
        status: 'completed',
        runId: run1,
      },
      {
        agentId: 'alpha',
        profileSha256: loadedAlpha.profileDigest,
        effectiveSha256: loadedAlpha.effectiveDigest,
        speedTier: 'fast',
        contestId: 'round-2',
        dataVersion: 1,
        contestSha256: loadedC2.contestDigest,
        status: 'void',
        runId: run2,
        reason: 'judge_error',
      },
    ],
    '2026-01-01T09:59:00.000Z',
  );

  const index = new WorkspaceIndex(root);
  t.after(() => index.close());

  const first = await index.sync({ base, root, store });
  assert.equal(first.agents_indexed, 3);
  assert.equal(first.contests_indexed, 2);
  assert.equal(first.batches_indexed, 1);
  assert.equal(first.runs_indexed, 2);

  // Check 0o600 file permissions on .index.sqlite
  const dbStat = await stat(index.dbPath);
  assert.equal(dbStat.mode & 0o077, 0);

  // Second sync without changes reuses cached rows without re-parsing!
  const second = await index.sync({ base, root, store });
  assert.equal(second.agents_indexed, 0);
  assert.equal(second.agents_reused, 3);
  assert.equal(second.contests_indexed, 0);
  assert.equal(second.contests_reused, 2);
  assert.equal(second.batches_indexed, 0);
  assert.equal(second.batches_reused, 1);
  assert.equal(second.runs_indexed, 0);
  assert.equal(second.runs_reused, 2);

  // Filtered & paginated queries
  const allValidAgents = index.listAgents({ validOnly: true });
  assert.equal(allValidAgents.total, 2);
  assert.deepEqual(allValidAgents.items.map(a => a.id), ['alpha', 'beta']);
  assert.equal(allValidAgents.items[0].agent_revision, loadedAlpha.profileDigest);

  const searched = index.listAgents({ search: 'beta', vendor: 'anthropic', harness: 'builtin-responses', limit: 1, offset: 0 });
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].id, 'beta');

  const pagedContests = index.listContests({ judgeKind: 'local', validOnly: true, limit: 1, offset: 1 });
  assert.equal(pagedContests.total, 2);
  assert.equal(pagedContests.items.length, 1);
  assert.equal(pagedContests.items[0].id, 'round-2');
  assert.equal(pagedContests.items[0].contest_revision, loadedC2.contestRevision);

  // Coverage & uncovered gaps (minRepeats: 1 vs 2, includeVoid: true vs false)
  const coverage = index.queryCoverage();
  assert.equal(coverage.length, 4); // 2 valid agents x 2 valid contests
  const alphaR1 = coverage.find(c => c.agent_id === 'alpha' && c.contest_id === 'round-1');
  assert.equal(alphaR1.completed_count, 1);
  assert.equal(alphaR1.best_score, 150);
  assert.equal(alphaR1.max_score, 200);
  assert.equal(alphaR1.latest_status, 'completed');
  assert.equal(alphaR1.latest_run_id, run1);

  const alphaR2 = coverage.find(c => c.agent_id === 'alpha' && c.contest_id === 'round-2');
  assert.equal(alphaR2.completed_count, 0);
  assert.equal(alphaR2.void_count, 1);
  assert.equal(alphaR2.latest_status, 'void');

  const gaps1 = index.findUncoveredCells({ minRepeats: 1, includeVoid: true });
  assert.equal(gaps1.total_gaps, 3);
  assert.equal(gaps1.waves_required, 1);
  assert.equal(gaps1.truncated, false);
  assert.equal(gaps1.cells.find(g => g.agent_id === 'alpha' && g.contest_id === 'round-2').reason, 'void_only');
  assert.equal(gaps1.cells.find(g => g.agent_id === 'beta' && g.contest_id === 'round-1').reason, 'unrun');

  const gapsNoVoid = index.findUncoveredCells({ minRepeats: 1, includeVoid: false });
  assert.equal(gapsNoVoid.total_gaps, 2);
  assert.ok(!gapsNoVoid.cells.some(g => g.reason === 'void_only'));

  const gapsRepeat2 = index.findUncoveredCells({ minRepeats: 2, includeVoid: true });
  assert.equal(gapsRepeat2.total_gaps, 4);
  assert.equal(gapsRepeat2.waves_required, 2);
  const belowCell = gapsRepeat2.cells.find(g => g.agent_id === 'alpha' && g.contest_id === 'round-1');
  assert.equal(belowCell.reason, 'below_repeats');
  assert.equal(belowCell.missing_repeats, 1);

  // Truncation flag when maxCells < total_gaps
  const truncatedGaps = index.findUncoveredCells({ minRepeats: 1, maxCells: 2 });
  assert.equal(truncatedGaps.total_gaps, 3);
  assert.equal(truncatedGaps.cells.length, 2);
  assert.equal(truncatedGaps.truncated, true);

  // toBatchSpec produces valid Batch Spec v2
  const spec = toBatchSpec(gaps1);
  assert.equal(spec.schema_version, 2);
  assert.equal(spec.cells.length, 3);
  assert.doesNotThrow(() => specSchema.parse(spec));

  // Modify a1Path display name only (keeps agent_revision!) and delete a2Path
  await new Promise(r => setTimeout(r, 20));
  await writeAgentFixture(base, 'alpha', {
    name: 'Alpha Renamed',
    vendor: 'openai',
    provider: 'p-main',
    speedTier: 'fast',
  });
  await rm(a2Path);
  const third = await index.sync({ base, root, store });
  assert.equal(third.agents_indexed, 1);
  assert.equal(third.agents_pruned, 1);
  const afterEdit = index.listAgents({ validOnly: true });
  assert.equal(afterEdit.total, 1);
  assert.equal(afterEdit.items[0].name, 'Alpha Renamed');
  // Display name change does NOT invalidate existing completed run coverage!
  const covAfterRename = index.queryCoverage({ agentIds: ['alpha'], contestIds: ['round-1'] });
  assert.equal(covAfterRename[0].completed_count, 1);
});

test('WorkspaceIndex enforces revision-aware coverage, distinguishes active running runs, skips incompatible cells, and returns null batch_spec on 0 gaps', async t => {
  const base = await makeTempDir(t, 'cr-idx-rev-base-');
  const root = await makeTempDir(t, 'cr-idx-rev-root-');
  const connDir = await makeTempDir(t, 'cr-idx-rev-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'p-main',
    label: 'Main Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-test-rev-123456',
    supports_fast: true,
  });

  const aPath = await writeAgentFixture(base, 'alpha', {
    provider: 'p-main',
    speedTier: 'standard',
    reasoningEffort: 'medium',
  });
  await writeAgentFixture(base, 'builtin-one', {
    provider: 'p-main',
    harness: 'builtin-responses',
    model: 'gpt-4.1-2025-04-14',
  });
  const c1Path = await writeContestFixture(base, 'local-r1', 1);
  await writeContestFixture(base, 'cf-r2', 1, { judgeKind: 'codeforces' });

  const loadedAlpha = await loadAgent(aPath, store);
  const loadedC1 = await loadContest(c1Path);

  // Write a completed run matching alpha@medium + local-r1
  const runDone = randomUUID();
  await writeRunFixture(root, {
    runId: runDone,
    agentId: 'alpha',
    profileSha256: loadedAlpha.profileDigest,
    effectiveSha256: loadedAlpha.effectiveDigest,
    speedTier: 'standard',
    contestId: 'local-r1',
    dataVersion: 1,
    contestRevision: loadedC1.contestRevision,
    status: 'completed',
    score: 200,
    maxScore: 200,
    createdAt: '2026-01-01T10:00:00.000Z',
  });

  const index = new WorkspaceIndex(root);
  t.after(() => index.close());
  await index.sync({ base, root, store });

  // Alpha x local-r1 is covered -> 0 gaps for that filtered pair -> toBatchSpec returns null!
  const coveredGaps = index.findUncoveredCells({ agentIds: ['alpha'], contestIds: ['local-r1'] });
  assert.equal(coveredGaps.total_gaps, 0);
  assert.equal(coveredGaps.waves_required, 0);
  assert.equal(toBatchSpec(coveredGaps), null);

  // Builtin-responses x cf-r2 is incompatible -> excluded from runnable gaps!
  const compatGaps = index.findUncoveredCells({ agentIds: ['builtin-one'], contestIds: ['cf-r2'] });
  assert.equal(compatGaps.total_gaps, 0);
  assert.equal(compatGaps.incompatible_skipped, 1);
  assert.equal(toBatchSpec(compatGaps), null);

  // Now change alpha's reasoning_effort from medium -> high (same agent_id!)
  await new Promise(r => setTimeout(r, 20));
  await writeAgentFixture(base, 'alpha', {
    provider: 'p-main',
    speedTier: 'standard',
    reasoningEffort: 'high',
  });
  await index.sync({ base, root, store });

  // Current revision is NOT covered, while historical counts remain visible!
  const covAfterDrift = index.queryCoverage({ agentIds: ['alpha'], contestIds: ['local-r1'] });
  assert.equal(covAfterDrift.length, 1);
  assert.equal(covAfterDrift[0].completed_count, 0);
  assert.equal(covAfterDrift[0].total_runs, 0);
  assert.equal(covAfterDrift[0].historical_completed_count, 1);
  assert.equal(covAfterDrift[0].historical_total_runs, 1);
  const gapsAfterDrift = index.findUncoveredCells({ agentIds: ['alpha'], contestIds: ['local-r1'] });
  assert.equal(gapsAfterDrift.total_gaps, 1);
  assert.equal(gapsAfterDrift.cells[0].reason, 'unrun');

  // Add 1 void run + 1 active running run for alpha@high x local-r1 -> MUST be 'running', NEVER 'void_only'!
  const loadedAlphaHigh = await loadAgent(aPath, store);
  await writeRunFixture(root, {
    runId: randomUUID(),
    agentId: 'alpha',
    profileSha256: loadedAlphaHigh.profileDigest,
    effectiveSha256: loadedAlphaHigh.effectiveDigest,
    speedTier: 'standard',
    contestId: 'local-r1',
    dataVersion: 1,
    contestRevision: loadedC1.contestRevision,
    status: 'void',
    createdAt: '2026-01-02T10:00:00.000Z',
  });
  await writeRunFixture(root, {
    runId: randomUUID(),
    agentId: 'alpha',
    profileSha256: loadedAlphaHigh.profileDigest,
    effectiveSha256: loadedAlphaHigh.effectiveDigest,
    speedTier: 'standard',
    contestId: 'local-r1',
    dataVersion: 1,
    contestRevision: loadedC1.contestRevision,
    status: 'running',
    includeTerminalEvent: false,
    createdAt: '2026-01-02T11:00:00.000Z',
  });
  await index.sync({ base, root, store });

  const runningGaps = index.findUncoveredCells({ agentIds: ['alpha'], contestIds: ['local-r1'] });
  assert.equal(runningGaps.total_gaps, 1);
  assert.equal(runningGaps.cells[0].reason, 'running');
  assert.equal(runningGaps.cells[0].running_count, 1);
});

test('WorkspaceIndex rejects symlinked root/sidecars, recovers from corrupt sqlite, invalidates on dependency edits, prunes corrupt runs, and tails large events.jsonl', async t => {
  const base = await makeTempDir(t, 'cr-idx-hard-base-');
  const realRoot = await makeTempDir(t, 'cr-idx-hard-root-');
  const symParent = await makeTempDir(t, 'cr-idx-hard-sym-');
  const connDir = await makeTempDir(t, 'cr-idx-hard-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'p-main',
    label: 'Main Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-test-hard-123456',
    supports_fast: true,
  });

  // 1. Reject symlinked workspace root
  const symRoot = join(symParent, 'root-link');
  await symlink(realRoot, symRoot);
  assert.throws(() => new WorkspaceIndex(symRoot), /symlinked|non-directory/i);

  // 2. Reject symlinked .index.sqlite and sidecars (-wal, -shm, -journal)
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const dir = await makeTempDir(t, 'cr-idx-symfile-');
    await symlink('/etc/hosts', join(dir, `.index.sqlite${suffix}`));
    assert.throws(() => new WorkspaceIndex(dir), /non-regular SQLite index path/i);
  }

  // 3. Corrupt .index.sqlite triggers automatic unlink + clean rebuild with 0o600 permissions
  const corruptRoot = await makeTempDir(t, 'cr-idx-corrupt-');
  await writeFile(join(corruptRoot, '.index.sqlite'), 'THIS IS NOT A VALID SQLITE DATABASE FILE');
  const recovered = new WorkspaceIndex(corruptRoot);
  t.after(() => recovered.close());
  const st = await stat(recovered.dbPath);
  assert.equal(st.mode & 0o077, 0);

  // 4. Dependency-aware invalidation (native_config, provider capabilities, contest judge.json)
  await mkdir(join(base, 'agents'), { recursive: true });
  const nativePath = join(base, 'agents', 'native.toml');
  const nativeContent1 = 'model_verbosity = "low"\n';
  await writeFile(nativePath, nativeContent1);
  const agentPath = await writeAgentFixture(base, 'dep-agent', {
    provider: 'p-main',
    speedTier: 'fast',
    nativeConfig: { format: 'toml', path: 'native.toml', sha256: sha256(nativeContent1) },
  });
  const contestPath = await writeContestFixture(base, 'dep-contest', 1, { answerA: '2' });

  await recovered.sync({ base, root: corruptRoot, store });
  const beforeAgent = recovered.listAgents().items[0];
  const beforeContest = recovered.listContests().items[0];
  assert.equal(beforeAgent.valid, true);
  assert.equal(beforeContest.valid, true);

  // Edit judge.json WITHOUT touching contest.json -> must invalidate contest cache and update contest_revision!
  await new Promise(r => setTimeout(r, 20));
  await writeFile(
    join(base, 'contests', 'dep-contest-v1', 'judge.json'),
    JSON.stringify({
      schema_version: 1,
      problems: [
        { id: 'A', max_points: 100, accepted_answers: ['999'] },
        { id: 'B', max_points: 100, accepted_answers: ['4'] },
      ],
    }),
  );
  // Edit native.toml WITHOUT touching agent json -> sha256 mismatch makes agent invalid!
  await writeFile(nativePath, 'model_verbosity = "high"\n');
  const afterDepEdit = await recovered.sync({ base, root: corruptRoot, store });
  assert.equal(afterDepEdit.contests_indexed, 1);
  assert.equal(afterDepEdit.agents_indexed, 1);
  assert.notEqual(recovered.listContests().items[0].contest_revision, beforeContest.contest_revision);
  assert.equal(recovered.listAgents().items[0].valid, false);

  // Restore native.toml, then patch provider supports_fast -> false (invalidates agent via provider meta hash!)
  await new Promise(r => setTimeout(r, 20));
  await writeFile(nativePath, nativeContent1);
  await recovered.sync({ base, root: corruptRoot, store });
  assert.equal(recovered.listAgents().items[0].valid, true);

  await store.patch('p-main', { supports_fast: false });
  const afterProvPatch = await recovered.sync({ base, root: corruptRoot, store });
  assert.equal(afterProvPatch.agents_indexed, 1);
  assert.equal(recovered.listAgents().items[0].valid, false);

  // Re-enable supports_fast for large events.jsonl + corrupt run pruning tests
  await store.patch('p-main', { supports_fast: true });
  await recovered.sync({ base, root: corruptRoot, store });
  const loadedDepAgent = await loadAgent(agentPath, store);
  const loadedDepContest = await loadContest(contestPath);

  // 5. Large events.jsonl (> 512 KiB) scanned cleanly via 256 KiB tail read!
  const bigRunId = randomUUID();
  await writeRunFixture(corruptRoot, {
    runId: bigRunId,
    agentId: 'dep-agent',
    profileSha256: loadedDepAgent.profileDigest,
    effectiveSha256: loadedDepAgent.effectiveDigest,
    speedTier: 'fast',
    contestId: 'dep-contest',
    dataVersion: 1,
    contestRevision: loadedDepContest.contestRevision,
    status: 'completed',
    score: 180,
    maxScore: 200,
    createdAt: '2026-01-03T10:00:00.000Z',
    eventsPaddingLines: 2500, // > 600 KiB
  });
  const evStat = await stat(join(corruptRoot, bigRunId, 'events.jsonl'));
  assert.ok(evStat.size > 512 * 1024, `expected >512KiB events.jsonl, got ${evStat.size}`);
  await recovered.sync({ base, root: corruptRoot, store });
  const covBig = recovered.queryCoverage({ agentIds: ['dep-agent'], contestIds: ['dep-contest'] });
  assert.equal(covBig[0].completed_count, 1);
  assert.equal(covBig[0].best_score, 180);

  // 6. Corrupting run.json later prunes the previously completed run instead of keeping it falsely completed!
  await new Promise(r => setTimeout(r, 20));
  await writeFile(join(corruptRoot, bigRunId, 'run.json'), '{not valid json');
  const afterCorruptRun = await recovered.sync({ base, root: corruptRoot, store });
  assert.equal(afterCorruptRun.runs_pruned, 1);
  const covAfterPrune = recovered.queryCoverage({ agentIds: ['dep-agent'], contestIds: ['dep-contest'] });
  assert.equal(covAfterPrune[0].completed_count, 0);
  assert.equal(covAfterPrune[0].total_runs, 0);
});

test('WorkspaceIndex confines custom root & transitive deps, enforces strict effective/contest/protocol revision checks, and preserves duplicate-ID distinct revisions', async t => {
  const base = await makeTempDir(t, 'cr-idx-strict-base-');
  const outsideDir = await makeTempDir(t, 'cr-idx-strict-out-');
  const connDir = await makeTempDir(t, 'cr-idx-strict-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'p-strict',
    label: 'Strict Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-strict-secret-1234',
    supports_fast: true,
  });

  // 1. Custom root INSIDE base with loose 0o755 permissions -> tightened to 0o700 and NOT walked by syncConfigs!
  const customRoot = join(base, 'custom-workspace');
  await mkdir(customRoot, { recursive: true, mode: 0o755 });
  await chmod(customRoot, 0o755);
  await mkdir(join(customRoot, 'nested'), { recursive: true });
  await writeFile(
    join(customRoot, 'nested', 'fake-agent.json'),
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'should-not-be-walked',
      model: 'gpt-5.3-codex',
      provider: 'p-strict',
      harness: { kind: 'codex', version: '0.170.0', options: {} },
    }),
  );

  // 2. Agent with escaping native_config.path & Contest with symlinked attachment -> NEVER followed, recorded valid=false with safe fixed issue!
  const outsideNative = 'model_verbosity = "high"\n';
  await writeFile(join(outsideDir, 'outside-native.toml'), outsideNative);
  await writeFile(join(outsideDir, 'outside-att.txt'), 'secret outside');

  await mkdir(join(base, 'agents'), { recursive: true });
  await writeFile(
    join(base, 'agents', 'esc-agent.json'),
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'esc-agent',
      model: 'gpt-5.3-codex',
      provider: 'p-strict',
      harness: {
        kind: 'codex',
        version: '0.170.0',
        options: {},
        native_config: {
          format: 'toml',
          path: relative(join(base, 'agents'), join(outsideDir, 'outside-native.toml')),
          sha256: sha256(outsideNative),
        },
      },
    }),
  );

  const symContestDir = join(base, 'contests', 'sym-att');
  await mkdir(symContestDir, { recursive: true });
  await synthesizeTextContestPdf(
    [{ id: 'A', title: 'Alpha', body: 'Solve A.' }],
    join(symContestDir, 'problems.pdf'),
    { title: 'Sym Att' },
  );
  await writeFile(
    join(symContestDir, 'judge.json'),
    JSON.stringify({ schema_version: 1, problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] }),
  );
  await symlink(join(outsideDir, 'outside-att.txt'), join(symContestDir, 'link-att.txt'));
  await writeFile(
    join(symContestDir, 'contest.json'),
    JSON.stringify({
      schema_version: 2,
      contest_id: 'sym-att',
      data_version: 1,
      title: 'Sym Att Contest',
      source: { name: 'Fixture' },
      materials: {
        entrypoint: { kind: 'pdf', path: 'problems.pdf' },
        attachments: [{ name: 'att.txt', path: 'link-att.txt' }],
      },
      judge: { kind: 'local', answers: { path: 'judge.json' } },
    }),
  );

  // 3. Two valid agent manifests with the SAME id ("dup-id") and DIFFERENT revisions (medium vs high)
  const dupV1Path = join(base, 'agents', 'dup-v1.json');
  const dupV2Path = join(base, 'agents', 'dup-v2.json');
  await writeFile(
    dupV1Path,
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'dup-id',
      model: 'gpt-5.3-codex',
      speed_tier: 'fast',
      provider: 'p-strict',
      harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium' } },
    }),
  );
  await writeFile(
    dupV2Path,
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'dup-id',
      model: 'gpt-5.3-codex',
      speed_tier: 'fast',
      provider: 'p-strict',
      harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'high' } },
    }),
  );

  const validContestPath = await writeContestFixture(base, 'strict-r1', 1);
  const loadedV1 = await loadAgent(dupV1Path, store);
  const loadedContest = await loadContest(validContestPath);

  // 4. Write runs that fail strict revision checks:
  // (a) matching profile_sha256, DIFFERENT effective_sha256
  await writeRunFixture(customRoot, {
    runId: randomUUID(),
    agentId: 'dup-id',
    profileSha256: loadedV1.profileDigest,
    effectiveSha256: 'f'.repeat(64),
    speedTier: 'fast',
    contestId: 'strict-r1',
    dataVersion: 1,
    contestRevision: loadedContest.contestRevision,
    protocolSha256: protocolDigestForPreset('short'),
    status: 'completed',
    score: 100,
    maxScore: 200,
    createdAt: '2026-01-01T10:00:00.000Z',
  });
  // (b) matching profile+effective, MISSING contest_revision (and no contest_sha256)
  await writeRunFixture(customRoot, {
    runId: randomUUID(),
    agentId: 'dup-id',
    profileSha256: loadedV1.profileDigest,
    effectiveSha256: loadedV1.effectiveDigest,
    speedTier: 'fast',
    contestId: 'strict-r1',
    dataVersion: 1,
    contestRevision: undefined,
    protocolSha256: protocolDigestForPreset('short'),
    status: 'completed',
    score: 100,
    maxScore: 200,
    createdAt: '2026-01-01T11:00:00.000Z',
  });
  // (c) matching profile+effective+contest, MISSING protocol_sha256
  await writeRunFixture(customRoot, {
    runId: randomUUID(),
    agentId: 'dup-id',
    profileSha256: loadedV1.profileDigest,
    effectiveSha256: loadedV1.effectiveDigest,
    speedTier: 'fast',
    contestId: 'strict-r1',
    dataVersion: 1,
    contestRevision: loadedContest.contestRevision,
    protocolSha256: null,
    status: 'completed',
    score: 100,
    maxScore: 200,
    createdAt: '2026-01-01T12:00:00.000Z',
  });
  // (d) matching profile+effective+contest+protocol, NULL speed_tier against 'fast' agent
  await writeRunFixture(customRoot, {
    runId: randomUUID(),
    agentId: 'dup-id',
    profileSha256: loadedV1.profileDigest,
    effectiveSha256: loadedV1.effectiveDigest,
    speedTier: null,
    contestId: 'strict-r1',
    dataVersion: 1,
    contestRevision: loadedContest.contestRevision,
    protocolSha256: protocolDigestForPreset('short'),
    status: 'completed',
    score: 100,
    maxScore: 200,
    createdAt: '2026-01-01T13:00:00.000Z',
  });

  const index = new WorkspaceIndex(customRoot);
  t.after(() => index.close());
  // Parent directory tightened to 0o700
  const rootStat = await stat(customRoot);
  assert.equal(rootStat.mode & 0o077, 0);

  await index.sync({ base, root: customRoot, store });

  // Custom root inside base was NOT walked!
  const allAgents = index.listAgents();
  assert.ok(!allAgents.items.some(a => a.id === 'should-not-be-walked'));

  // Escaping agent and symlinked-attachment contest both recorded invalid without leaking host paths!
  const escAgent = allAgents.items.find(a => a.id === 'esc-agent');
  assert.ok(escAgent);
  assert.equal(escAgent.valid, false);
  assert.equal(escAgent.issues.length, 1);
  assert.match(escAgent.issues[0], /inside workspace base|symlink/i);
  assert.ok(!escAgent.issues[0].includes(outsideDir));

  const symContest = index.listContests().items.find(c => c.id === 'sym-att');
  assert.ok(symContest);
  assert.equal(symContest.valid, false);
  assert.equal(symContest.issues.length, 1);
  assert.match(symContest.issues[0], /symlink|inside workspace base/i);

  // Both duplicate-ID valid agent manifests with DISTINCT revisions are preserved in queryCoverage & findUncoveredCells!
  const cov = index.queryCoverage({ agentIds: ['dup-id'], contestIds: ['strict-r1'] });
  assert.equal(cov.length, 2);
  assert.deepEqual(cov.map(c => c.agent_path).sort(), ['agents/dup-v1.json', 'agents/dup-v2.json']);

  // NONE of the 4 strict-mismatch runs credited as current completion; all 4 counted in historical totals!
  for (const cell of cov) {
    assert.equal(cell.completed_count, 0);
    assert.equal(cell.total_runs, 0);
    assert.equal(cell.historical_completed_count, 4);
    assert.equal(cell.historical_total_runs, 4);
  }
  const gaps = index.findUncoveredCells({ agentIds: ['dup-id'], contestIds: ['strict-r1'] });
  assert.equal(gaps.total_gaps, 2);
  assert.deepEqual(gaps.cells.map(g => g.agent).sort(), ['agents/dup-v1.json', 'agents/dup-v2.json']);

  // Duplicate paths with the IDENTICAL planner revision (even when service_tier: fast vs priority
  // have different profile_sha256 but map to the exact same effective Codex config & planner revision!)
  // collapse to 1 cell so toBatchSpec never emits duplicate revisions rejected by makePlan!
  await writeFile(
    join(base, 'agents', 'dup-v1.zz-copy.json'),
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'dup-id',
      model: 'gpt-5.3-codex',
      speed_tier: 'fast',
      provider: 'p-strict',
      harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium', service_tier: 'fast' } },
    }),
  );
  await writeFile(
    join(base, 'agents', 'dup-v1.zz-priority.json'),
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'dup-id',
      model: 'gpt-5.3-codex',
      speed_tier: 'fast',
      provider: 'p-strict',
      harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium', service_tier: 'priority' } },
    }),
  );

  // Run with matching hashes EXCEPT speed_tier === null MUST NOT be credited as current (no default to 'standard')!
  const nullTierRunId = randomUUID();
  const nullTierDir = join(customRoot, nullTierRunId);
  await mkdir(nullTierDir, { recursive: true });
  await writeFile(
    join(nullTierDir, 'run.json'),
    JSON.stringify({
      schema_version: 2,
      run_id: nullTierRunId,
      contest_id: 'strict-r1',
      data_version: 1,
      contest_revision: loadedContest.contestRevision,
      protocol_sha256: protocolDigest,
      agent_id: 'dup-id',
      agent_revision: loadedV1.profileDigest,
      agent_digests: { profile_sha256: loadedV1.profileDigest, effective_sha256: loadedV1.effectiveDigest },
      model: { model: 'gpt-5.3-codex' },
      started_at: '2026-01-01T14:00:00.000Z',
    }),
  );
  await writeFile(
    join(nullTierDir, 'events.jsonl'),
    [
      JSON.stringify({ schema_version: 1, seq: 1, elapsed_ms: 0, type: 'run_started' }),
      JSON.stringify({ schema_version: 1, seq: 2, elapsed_ms: 100, type: 'run_ended', status: 'completed', score: 200, max_score: 200 }),
    ].join('\n') + '\n',
  );

  // Credential dir placed inside base MUST be skipped during syncConfigs!
  const credInBase = join(base, 'cred-store');
  await mkdir(credInBase, { recursive: true, mode: 0o700 });
  await writeFile(
    join(credInBase, 'secret-agent.json'),
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'cred-store-leak',
      vendor: 'openai',
      model: 'gpt-5.3-codex',
      provider: 'p-strict',
      harness: { kind: 'codex', version: '0.170.0', options: {} },
    }),
  );

  await index.sync({ base, root: customRoot, store, credentialDirs: [credInBase] });
  assert.ok(!index.listAgents().items.some(a => a.id === 'cred-store-leak'));

  const covAfter = index.queryCoverage({ agentIds: ['dup-id'], contestIds: ['strict-r1'] });
  // 3 cells: dup-v1.json (no service_tier), dup-v1.zz-copy.json (collapsed with dup-v1.zz-priority.json!), and dup-v2.json!
  assert.equal(covAfter.length, 3);
  assert.deepEqual(covAfter.map(c => c.agent_path).sort(), [
    'agents/dup-v1.json',
    'agents/dup-v1.zz-copy.json',
    'agents/dup-v2.json',
  ]);
  // Null speed_tier run NOT credited as current!
  const v1Cell = covAfter.find(c => c.agent_path === 'agents/dup-v1.json');
  assert.ok(v1Cell);
  assert.equal(v1Cell.completed_count, 0);
  assert.equal(v1Cell.historical_completed_count, 5);

  // Completed run executed via collapsed equivalent profile (dup-v1.zz-priority.json) MUST be credited
  // to the collapsed planner-revision cell (dup-v1.zz-copy.json) with 1 completion and 0 gaps!
  const loadedPriority = await loadAgent(join(base, 'agents', 'dup-v1.zz-priority.json'), store);
  const priorityRunId = randomUUID();
  await writeRunFixture(customRoot, {
    runId: priorityRunId,
    agentId: 'dup-id',
    agentRevision: loadedPriority.profileDigest,
    profileSha256: loadedPriority.profileDigest,
    effectiveSha256: loadedPriority.effectiveDigest,
    speedTier: 'fast',
    contestId: 'strict-r1',
    dataVersion: 1,
    contestRevision: loadedContest.contestRevision,
    protocolSha256: protocolDigest,
    status: 'completed',
    score: 200,
    maxScore: 200,
    createdAt: '2026-01-01T15:00:00.000Z',
  });
  await index.sync({ base, root: customRoot, store, credentialDirs: [credInBase] });
  const covWithEquiv = index.queryCoverage({ agentIds: ['dup-id'], contestIds: ['strict-r1'] });
  const equivCell = covWithEquiv.find(c => c.agent_path === 'agents/dup-v1.zz-copy.json');
  assert.ok(equivCell);
  assert.equal(equivCell.completed_count, 1);
  // Check isolated fast+priority group yields batch_spec: null (0 gaps)
  const fastOnlyBase = await makeTempDir(t, 'cr-idx-equiv-base-');
  const fastOnlyRoot = join(fastOnlyBase, 'runs');
  await mkdir(join(fastOnlyBase, 'agents'), { recursive: true });
  await mkdir(fastOnlyRoot, { recursive: true, mode: 0o700 });
  const fastContestPath = await writeContestFixture(fastOnlyBase, 'equiv-r1', 1);
  const loadedFastContest = await loadContest(fastContestPath);
  const fastPath = join(fastOnlyBase, 'agents', 'fast.json');
  const prioPath = join(fastOnlyBase, 'agents', 'priority.json');
  await writeFile(
    fastPath,
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'same-tier-agent',
      model: 'gpt-5.3-codex',
      speed_tier: 'fast',
      provider: 'p-strict',
      harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium', service_tier: 'fast' } },
    }),
  );
  await writeFile(
    prioPath,
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'same-tier-agent',
      model: 'gpt-5.3-codex',
      speed_tier: 'fast',
      provider: 'p-strict',
      harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium', service_tier: 'priority' } },
    }),
  );
  const loadedPrioOnly = await loadAgent(prioPath, store);
  await writeRunFixture(fastOnlyRoot, {
    runId: randomUUID(),
    agentId: 'same-tier-agent',
    agentRevision: loadedPrioOnly.profileDigest,
    profileSha256: loadedPrioOnly.profileDigest,
    effectiveSha256: loadedPrioOnly.effectiveDigest,
    speedTier: 'fast',
    contestId: 'equiv-r1',
    dataVersion: 1,
    contestRevision: loadedFastContest.contestRevision,
    protocolSha256: protocolDigest,
    status: 'completed',
    score: 200,
    maxScore: 200,
    createdAt: '2026-01-01T16:00:00.000Z',
  });
  const equivIndex = new WorkspaceIndex(fastOnlyRoot);
  t.after(() => equivIndex.close());
  await equivIndex.sync({ base: fastOnlyBase, root: fastOnlyRoot, store });
  const equivCov = equivIndex.queryCoverage();
  assert.equal(equivCov.length, 1);
  assert.equal(equivCov[0].agent_path, 'agents/fast.json');
  assert.equal(equivCov[0].completed_count, 1);
  const equivGaps = equivIndex.findUncoveredCells();
  assert.equal(equivGaps.total_gaps, 0);
  assert.equal(toBatchSpec(equivGaps), null);
});
