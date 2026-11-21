import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  batchApplyAgents,
  batchImportContests,
  exportSchemas,
  generateAgentVariants,
} from '../dist/automation.js';
import { loadAgent, loadContest } from '../dist/config.js';
import { Connections } from '../dist/connections.js';
import { synthesizeTextContestPdf } from '../dist/pdf-synth.js';

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

test('exportSchemas exports valid JSON Schemas and capability metadata for all targets', () => {
  const all = exportSchemas('all');
  assert.equal(all.schema_version, 1);
  assert.equal(all.target, 'all');
  for (const key of ['agent', 'contest', 'batch', 'results']) {
    assert.ok(all.schemas[key], `missing schema ${key}`);
    assert.equal(typeof all.schemas[key], 'object');
    assert.ok(all.schemas[key].$schema || all.schemas[key].type || all.schemas[key].oneOf || all.schemas[key].anyOf);
  }
  assert.ok(Array.isArray(all.capabilities.harnesses) && all.capabilities.harnesses.length >= 2);
  assert.ok(all.capabilities.protocol_presets.short);
  assert.ok(all.capabilities.judge_backends.some(b => b.kind === 'codeforces'));
  assert.ok(all.capabilities.judge_backends.some(b => b.kind === 'qoj'));
  assert.ok(Array.isArray(all.capabilities.language_presets.codeforces));
  assert.deepEqual(all.capabilities.manifest_formats, ['toml', 'yaml', 'json']);
  assert.deepEqual(all.capabilities.speed_tiers, ['standard', 'fast', 'ultrafast']);

  const onlyAgent = exportSchemas('agent');
  assert.ok(onlyAgent.schemas.agent);
  assert.equal(onlyAgent.schemas.contest, undefined);
});

test('generateAgentVariants supports dry-run, apply, ifExists modes, provider capability checks, and 64-variant cap', async t => {
  const base = await makeTempDir(t, 'cr-var-base-');
  const connDir = await makeTempDir(t, 'cr-var-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'openai-fast',
    label: 'OpenAI Fast',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-var-secret-999999',
    supports_fast: true,
    supports_ultrafast: false,
  });

  const baseDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'gpt5',
    name: 'GPT-5 Codex',
    vendor: 'openai',
    model: 'gpt-5.3-codex',
    provider: 'openai-fast',
    harness: { kind: 'codex', version: '0.170.0', options: {} },
  };

  // Dry-run does not create any files
  const dry = await generateAgentVariants(
    {
      base_document: baseDoc,
      reasoning_efforts: ['low', 'high'],
      speed_tiers: ['standard', 'fast'],
      format: 'toml',
    },
    { base, store, dryRun: true, ifExists: 'error' },
  );
  assert.equal(dry.ok, true);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.total, 4);
  assert.equal(dry.created, 4);
  assert.equal(dry.variants.length, 4);
  assert.equal(await exists(join(base, 'agents')), false);

  // Real apply writes all 4 variants
  const applied = await generateAgentVariants(
    {
      base_document: baseDoc,
      reasoning_efforts: ['low', 'high'],
      speed_tiers: ['standard', 'fast'],
      format: 'toml',
    },
    { base, store, dryRun: false, ifExists: 'error' },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.created, 4);
  for (const v of applied.variants) {
    const loaded = await loadAgent(join(base, v.path), store);
    assert.equal(loaded.agent.agent_id, v.id);
    const rawText = await readFile(join(base, v.path), 'utf8');
    assert.ok(!rawText.includes('sk-var-secret-999999'));
  }

  // Re-run with ifExists: error fails with conflicts
  const conflict = await generateAgentVariants(
    {
      base_document: baseDoc,
      reasoning_efforts: ['low', 'high'],
      speed_tiers: ['standard', 'fast'],
      format: 'toml',
    },
    { base, store, dryRun: false, ifExists: 'error' },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.errors.length, 4);
  assert.equal(conflict.errors[0].code, 'conflict');

  // Re-run with ifExists: skip skips existing and creates new effort
  const skipped = await generateAgentVariants(
    {
      base_document: baseDoc,
      reasoning_efforts: ['low', 'medium'],
      speed_tiers: ['standard'],
      format: 'toml',
    },
    { base, store, dryRun: false, ifExists: 'skip' },
  );
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.created, 1);

  // Re-run with ifExists: overwrite overwrites cleanly
  const overwritten = await generateAgentVariants(
    {
      base_document: { ...baseDoc, name: 'GPT-5 Codex Updated' },
      reasoning_efforts: ['low'],
      speed_tiers: ['standard'],
      format: 'toml',
    },
    { base, store, dryRun: false, ifExists: 'overwrite' },
  );
  assert.equal(overwritten.ok, true);
  assert.equal(overwritten.overwritten, 1);
  const reloaded = await loadAgent(join(base, overwritten.variants[0].path), store);
  assert.equal(reloaded.agentName, 'GPT-5 Codex Updated (low · standard)');

  // Rejects unsupported provider speed tier (ultrafast = false)
  const badTier = await generateAgentVariants(
    {
      base_document: baseDoc,
      speed_tiers: ['ultrafast'],
      format: 'toml',
    },
    { base, store, dryRun: false, ifExists: 'overwrite' },
  );
  assert.equal(badTier.ok, false);
  assert.match(badTier.errors[0].message, /ultrafast/i);

  // Rejects >64 variants
  const tooMany = await generateAgentVariants(
    {
      base_document: baseDoc,
      reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      speed_tiers: ['standard', 'fast', 'ultrafast'],
      service_tiers: ['default', 'standard', 'fast', 'priority'],
    },
    { base, store, dryRun: true },
  );
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors[0].message, /64/);
});

test('batchApplyAgents enforces all-or-nothing pre-validation, strict secret boundary, and path confinement', async t => {
  const base = await makeTempDir(t, 'cr-batch-agent-');
  const connDir = await makeTempDir(t, 'cr-batch-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'p1',
    label: 'Provider One',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-never-write-this',
  });

  const validDoc = (id) => ({
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id,
    model: 'gpt-5.3-codex',
    provider: 'p1',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'high' } },
  });

  // All-or-nothing: 1 valid + 1 invalid -> ZERO files written
  const mixedFail = await batchApplyAgents(
    [
      { document: validDoc('good-one') },
      { document: { ...validDoc('bad-one'), provider: 'does-not-exist' } },
    ],
    { base, store, dryRun: false, ifExists: 'error' },
  );
  assert.equal(mixedFail.ok, false);
  assert.equal(mixedFail.created, 0);
  assert.equal(await exists(join(base, 'agents', 'good-one.toml')), false);

  // Rejects embedded secret keys anywhere in the item
  const withSecret = await batchApplyAgents(
    [
      { document: { ...validDoc('secret-holder'), api_key: 'sk-leaked' } },
    ],
    { base, store, dryRun: false },
  );
  assert.equal(withSecret.ok, false);
  assert.equal(withSecret.errors[0].code, 'secret_rejected');
  assert.equal(await exists(join(base, 'agents', 'secret-holder.toml')), false);

  // Rejects path traversal and symlinks
  const traversal = await batchApplyAgents(
    [{ file: '../escape.toml', document: validDoc('esc') }],
    { base, store, dryRun: false },
  );
  assert.equal(traversal.ok, false);
  assert.equal(traversal.errors[0].code, 'path_error');

  await mkdir(join(base, 'agents'), { recursive: true });
  await symlink(tmpdir(), join(base, 'agents', 'linkdir'));
  const symEscape = await batchApplyAgents(
    [{ file: 'agents/linkdir/sym.toml', document: validDoc('sym') }],
    { base, store, dryRun: false },
  );
  assert.equal(symEscape.ok, false);
  assert.equal(symEscape.errors[0].code, 'path_error');

  // Clean apply succeeds with managed default path agents/<id>.<format>
  const applied = await batchApplyAgents(
    [
      { format: 'yaml', document: validDoc('agent-a') },
      { format: 'json', document: validDoc('agent-b') },
    ],
    { base, store, dryRun: false, ifExists: 'error' },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.created, 2);
  assert.equal(applied.items[0].path, 'agents/agent-a.yaml');
  assert.equal(applied.items[1].path, 'agents/agent-b.json');
  assert.equal((await loadAgent(join(base, 'agents/agent-a.yaml'), store)).agent.agent_id, 'agent-a');
});

test('batchImportContests supports synthesized PDFs, managed paths, problem_map inference, and secret rejection', async t => {
  const base = await makeTempDir(t, 'cr-batch-contest-base-');
  const root = await makeTempDir(t, 'cr-batch-contest-root-');

  // Reject embedded OJ cookie/password
  const withCookie = await batchImportContests(
    [
      {
        document: {
          schema_version: 2,
          contest_id: 'cf-bad',
          data_version: 1,
          title: 'Bad CF',
          source: { name: 'CF' },
          judge: { kind: 'codeforces', contest_id: 1, handle: 'h', cookie: 'JSESSIONID=123', languages: { cpp17: 54 } },
        },
      },
    ],
    { root, base, dryRun: false },
  );
  assert.equal(withCookie.ok, false);
  assert.equal(withCookie.errors[0].code, 'secret_rejected');

  // Synthesize PDF + local judge table into managed contests/<id>.json
  const synthItem = {
    document: {
      schema_version: 2,
      contest_id: 'synth-round',
      data_version: 1,
      title: 'Synthesized Round',
      source: { name: 'Local Synth' },
      judge: {
        kind: 'local',
        problems: [
          { id: 'A', max_points: 100, accepted_answers: ['42'] },
          { id: 'B', max_points: 200, accepted_answers: ['99'] },
        ],
      },
    },
    synth_problems: [
      { id: 'A', title: 'Answer Everything', body: 'Print 42.', samples: [{ input: '0', output: '42' }] },
      { id: 'B', title: 'Almost Hundred', body: 'Print 99.' },
    ],
  };

  // Dry-run writes nothing
  const dry = await batchImportContests([synthItem], { root, base, dryRun: true, ifExists: 'error' });
  assert.equal(dry.ok, true);
  assert.equal(dry.created, 1);
  assert.equal(await exists(join(base, 'contests', 'synth-round.json')), false);

  // Real import writes contest JSON, synthesized PDF, and separate private judge table
  const applied = await batchImportContests([synthItem], { root, base, dryRun: false, ifExists: 'error' });
  assert.equal(applied.ok, true);
  assert.equal(applied.created, 1);
  assert.equal(applied.items[0].path, 'contests/synth-round.json');
  assert.equal(applied.items[0].pdf_path, 'contests/synth-round.pdf');
  assert.equal(applied.items[0].judge_path, 'contests/synth-round.judge.json');
  assert.ok(applied.items[0].revision);

  const loaded = await loadContest(join(base, 'contests/synth-round.json'));
  assert.equal(loaded.contest.contest_id, 'synth-round');
  assert.equal(loaded.judge.problems.length, 2);
  assert.equal(loaded.judge.problems[0].accepted_answers[0], '42');
  // Public contest manifest must never contain accepted_answers
  const rawContest = await readFile(join(base, 'contests/synth-round.json'), 'utf8');
  assert.ok(!rawContest.includes('accepted_answers'));

  // Test existing PDF inspection + auto problem_map inference (PDF 1/2 -> CF A/B)
  const pdfDir = join(base, 'pdfs');
  await mkdir(pdfDir, { recursive: true });
  await synthesizeTextContestPdf(
    [
      { id: '1', title: 'First Task', body: 'Compute sum.' },
      { id: '2', title: 'Second Task', body: 'Compute product.' },
    ],
    join(pdfDir, 'cf-num.pdf'),
    { title: 'Numeric PDF' },
  );
  const cfImport = await batchImportContests(
    [
      {
        document: {
          schema_version: 2,
          contest_id: 'cf-inferred',
          data_version: 1,
          title: 'CF Auto Map',
          source: { name: 'Codeforces' },
          materials: { entrypoint: { kind: 'pdf', path: '../pdfs/cf-num.pdf' } },
          problems: [
            { id: 'A', max_points: 500 },
            { id: 'B', max_points: 1000 },
          ],
          judge: {
            kind: 'codeforces',
            contest_id: 1999,
            handle: 'demo_bot',
            languages: { cpp20: 89 },
          },
        },
      },
    ],
    { root, base, dryRun: true, ifExists: 'error' },
  );
  assert.equal(cfImport.ok, true);
  assert.deepEqual(cfImport.items[0].pdf_info.problem_ids, ['1', '2']);
  assert.deepEqual(cfImport.items[0].inferred_problem_map.confirmed_map, { '1': 'A', '2': 'B' });
});
