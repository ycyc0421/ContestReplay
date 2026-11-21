import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connections } from '../dist/connections.js';
import { synthesizeTextContestPdf } from '../dist/pdf-synth.js';
import { specSchema } from '../dist/plan.js';
import { toBatchSpec, WorkspaceIndex } from '../dist/sqlite-index.js';

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeContestFixture(base, contestId, dataVersion = 1) {
  const dir = join(base, 'contests', `${contestId}-v${dataVersion}`);
  await mkdir(dir, { recursive: true });
  await synthesizeTextContestPdf(
    [
      { id: 'A', title: 'Alpha', body: 'Find 1 + 1.' },
      { id: 'B', title: 'Beta', body: 'Find 2 + 2.' },
    ],
    join(dir, 'problems.pdf'),
    { title: `Contest ${contestId}` },
  );
  await writeFile(
    join(dir, 'judge.json'),
    JSON.stringify({
      schema_version: 1,
      problems: [
        { id: 'A', max_points: 100, accepted_answers: ['2'] },
        { id: 'B', max_points: 100, accepted_answers: ['4'] },
      ],
    }),
  );
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
        materials: { entrypoint: { kind: 'pdf', path: 'problems.pdf' } },
        judge: { kind: 'local', answers: { path: 'judge.json' } },
        rules: { time_limit_ms: 900_000, max_submissions: 50 },
      },
      null,
      2,
    ),
  );
  return contestPath;
}

async function writeAgentFixture(base, id, { name, vendor = 'openai', provider = 'p-main', speedTier = 'standard', harness = 'codex', model = 'gpt-5.3-codex' } = {}) {
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
          options: harness === 'codex' ? { reasoning_effort: 'medium' } : { temperature: 0 },
        },
      },
      null,
      2,
    ),
  );
  return filePath;
}

async function writeRunFixture(root, { runId, agentId, agentName, contestId, dataVersion, status, reason, score, maxScore, createdAt }) {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'run.json'),
    JSON.stringify({
      schema_version: 2,
      run_id: runId,
      contest_id: contestId,
      data_version: dataVersion,
      agent_id: agentId,
      ...(agentName ? { agent_name: agentName } : {}),
      agent_revision: 'a'.repeat(64),
      model: { model: 'gpt-5.3-codex', speed_tier: 'standard' },
      started_at: createdAt,
    }),
  );
  const events = [
    { schema_version: 1, seq: 1, elapsed_ms: 0, type: 'run_started' },
    {
      schema_version: 1,
      seq: 2,
      elapsed_ms: 12_000,
      type: 'run_ended',
      status,
      reason: reason ?? (status === 'completed' ? 'finish' : 'judge_error'),
      ...(score !== undefined ? { score } : {}),
      ...(maxScore !== undefined ? { max_score: maxScore } : {}),
    },
  ];
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
        protocol_sha256: '1'.repeat(64),
        jobs: jobs.map(j => ({
          image: `sha256:${'2'.repeat(64)}`,
          harness: 'codex',
          agent_path: `/tmp/${j.agentId}.json`,
          agent_id: j.agentId,
          agent_revision: 'a'.repeat(64),
          agent_sha256: '3'.repeat(64),
          profile_sha256: '4'.repeat(64),
          contest_path: `/tmp/${j.contestId}.json`,
          contest_id: j.contestId,
          data_version: j.dataVersion,
          contest_sha256: '5'.repeat(64),
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

  const a1Path = await writeAgentFixture(base, 'alpha', { name: 'Alpha Agent', vendor: 'openai', provider: 'p-main', speedTier: 'fast' });
  const a2Path = await writeAgentFixture(base, 'beta', { name: 'Beta Builtin', vendor: 'anthropic', provider: 'p-main', harness: 'builtin-responses', model: 'gpt-4.1-2025-04-14' });
  await writeAgentFixture(base, 'broken', { vendor: 'openai', provider: 'missing-provider' });
  await writeContestFixture(base, 'round-1', 1);
  await writeContestFixture(base, 'round-2', 1);

  // Symlink should be skipped safely during workspace walk.
  await symlink(a1Path, join(base, 'agents', 'symlink-agent.json'));

  const run1 = randomUUID();
  const run2 = randomUUID();
  const batch1 = randomUUID();
  await writeRunFixture(root, {
    runId: run1,
    agentId: 'alpha',
    agentName: 'Alpha Agent',
    contestId: 'round-1',
    dataVersion: 1,
    status: 'completed',
    score: 150,
    maxScore: 200,
    createdAt: '2026-01-01T10:00:00.000Z',
  });
  await writeRunFixture(root, {
    runId: run2,
    agentId: 'alpha',
    agentName: 'Alpha Agent',
    contestId: 'round-2',
    dataVersion: 1,
    status: 'void',
    reason: 'judge_error',
    createdAt: '2026-01-01T11:00:00.000Z',
  });
  await writeBatchFixture(
    root,
    batch1,
    [
      { agentId: 'alpha', contestId: 'round-1', dataVersion: 1, status: 'completed', runId: run1 },
      { agentId: 'alpha', contestId: 'round-2', dataVersion: 1, status: 'void', runId: run2, reason: 'judge_error' },
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

  const searched = index.listAgents({ search: 'beta', vendor: 'anthropic', harness: 'builtin-responses', limit: 1, offset: 0 });
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].id, 'beta');

  const pagedContests = index.listContests({ judgeKind: 'local', validOnly: true, limit: 1, offset: 1 });
  assert.equal(pagedContests.total, 2);
  assert.equal(pagedContests.items.length, 1);
  assert.equal(pagedContests.items[0].id, 'round-2');

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
  assert.equal(gaps1.cells.find(g => g.agent_id === 'alpha' && g.contest_id === 'round-2').reason, 'void_only');
  assert.equal(gaps1.cells.find(g => g.agent_id === 'beta' && g.contest_id === 'round-1').reason, 'unrun');

  const gapsNoVoid = index.findUncoveredCells({ minRepeats: 1, includeVoid: false });
  assert.equal(gapsNoVoid.total_gaps, 2);
  assert.ok(!gapsNoVoid.cells.some(g => g.reason === 'void_only'));

  const gapsRepeat2 = index.findUncoveredCells({ minRepeats: 2, includeVoid: true });
  assert.equal(gapsRepeat2.total_gaps, 4);
  const belowCell = gapsRepeat2.cells.find(g => g.agent_id === 'alpha' && g.contest_id === 'round-1');
  assert.equal(belowCell.reason, 'below_repeats');
  assert.equal(belowCell.missing_repeats, 1);

  // toBatchSpec produces valid Batch Spec v2
  const spec = toBatchSpec(gaps1);
  assert.equal(spec.schema_version, 2);
  assert.equal(spec.cells.length, 3);
  assert.doesNotThrow(() => specSchema.parse(spec));

  // Modify a1Path and delete a2Path -> incremental re-index + deletion pruning
  await new Promise(r => setTimeout(r, 20));
  await writeAgentFixture(base, 'alpha', { name: 'Alpha Renamed', vendor: 'openai', provider: 'p-main', speedTier: 'fast' });
  await rm(a2Path);
  const third = await index.sync({ base, root, store });
  assert.equal(third.agents_indexed, 1);
  assert.equal(third.agents_pruned, 1);
  const afterEdit = index.listAgents({ validOnly: true });
  assert.equal(afterEdit.total, 1);
  assert.equal(afterEdit.items[0].name, 'Alpha Renamed');
});
