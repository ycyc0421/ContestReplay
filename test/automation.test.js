import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  batchApplyAgents,
  batchImportContests,
  exportSchemas,
  findSecretKeyPaths,
  generateAgentVariants,
  isSecretKey,
} from '../dist/automation.js';
import { loadAgent, loadContest, sha256 } from '../dist/config.js';
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

test('exportSchemas uses input JSON Schema (defaults optional) and marks contest_manifest_supported', () => {
  const exported = exportSchemas('all');
  const contestRequired = exported.schemas.contest.required ?? [];
  // Defaulted contest fields (rules, materials.attachments) must NOT be marked required in input schemas.
  assert.ok(!contestRequired.includes('rules'), `unexpected required rules: ${JSON.stringify(contestRequired)}`);
  const materialsSchema = exported.schemas.contest.properties?.materials;
  const materialsRequired = materialsSchema?.required ?? [];
  assert.ok(!materialsRequired.includes('attachments'), `unexpected required attachments: ${JSON.stringify(materialsRequired)}`);

  const byKind = new Map(exported.capabilities.judge_backends.map(b => [b.kind, b]));
  assert.equal(byKind.get('local')?.contest_manifest_supported, true);
  assert.equal(byKind.get('codeforces')?.contest_manifest_supported, true);
  assert.equal(byKind.get('qoj')?.contest_manifest_supported, false);
  assert.equal(byKind.get('vjudge')?.contest_manifest_supported, false);
  assert.equal(byKind.get('hydro')?.contest_manifest_supported, false);
});

test('isSecretKey / findSecretKeyPaths allows LLM token metrics while blocking auth/credential keys', () => {
  for (const allowed of ['max_tokens', 'max_output_tokens', 'maxOutputTokens', 'input_tokens', 'output_tokens', 'prompt_tokens', 'total_tokens', 'tokens_limit']) {
    assert.equal(isSecretKey(allowed), false, `expected ${allowed} to be allowed`);
  }
  for (const blocked of ['authorization', 'bearer', 'bearerToken', 'privateKey', 'private_key', 'accessToken', 'access_token', 'access_key', 'api_key', 'apiKey', 'credential', 'credentials', 'cookie', 'password', 'secret', 'token']) {
    assert.equal(isSecretKey(blocked), true, `expected ${blocked} to be rejected`);
  }
  const hits = findSecretKeyPaths({
    max_output_tokens: 4096,
    nested: { input_tokens: 100, privateKey: 'nope', authorization: 'Bearer x', accessToken: 'tok' },
  });
  assert.deepEqual(
    hits.map(p => p.join('.')).sort(),
    ['nested.accessToken', 'nested.authorization', 'nested.privateKey'],
  );
});

test('auto_problem_map rewrites problems on dryRun: false and passes loadContest end-to-end', async t => {
  const base = await makeTempDir(t, 'cr-automap-base-');
  const root = await makeTempDir(t, 'cr-automap-root-');
  const pdfDir = join(base, 'pdfs');
  await mkdir(pdfDir, { recursive: true });
  await synthesizeTextContestPdf(
    [
      { id: '1', title: 'Task One', body: 'Solve task one.' },
      { id: '2', title: 'Task Two', body: 'Solve task two.' },
    ],
    join(pdfDir, 'cf-num.pdf'),
    { title: 'Numeric PDF' },
  );

  const applied = await batchImportContests(
    [
      {
        auto_problem_map: true,
        document: {
          schema_version: 2,
          contest_id: 'cf-mapped-live',
          data_version: 1,
          title: 'CF Auto Map Live',
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
    { root, base, dryRun: false, ifExists: 'error' },
  );
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  assert.equal(applied.created, 1);

  const loaded = await loadContest(join(base, applied.items[0].path));
  assert.deepEqual(loaded.contest.problems, [
    { id: '1', max_points: 500 },
    { id: '2', max_points: 1000 },
  ]);
  assert.deepEqual(loaded.contest.judge.problem_map, { '1': 'A', '2': 'B' });
});

test('batchImportContests dryRun catches CF empty languages, entrypoint sha256 mismatch, local judge mismatch, attachment escape/judge exposure, and hides secret judge parse text', async t => {
  const base = await makeTempDir(t, 'cr-dry-contest-base-');
  const root = await makeTempDir(t, 'cr-dry-contest-root-');
  const outsideDir = await makeTempDir(t, 'cr-dry-contest-out-');
  await writeFile(join(outsideDir, 'outside.txt'), 'secret outside');

  await mkdir(join(base, 'contests'), { recursive: true });
  await synthesizeTextContestPdf(
    [{ id: 'A', title: 'Alpha', body: 'Solve A.' }],
    join(base, 'contests', 'base.pdf'),
    { title: 'Base PDF' },
  );
  await writeFile(join(base, 'contests', 'secret.judge.json'), JSON.stringify({
    schema_version: 1,
    problems: [{ id: 'A', max_points: 100, accepted_answers: ['42'] }],
  }));

  // 1. Empty CF languages caught in dryRun: true
  const emptyLangs = await batchImportContests(
    [{
      document: {
        schema_version: 2,
        contest_id: 'cf-empty-lang',
        data_version: 1,
        title: 'CF Empty',
        source: { name: 'CF' },
        materials: { entrypoint: { kind: 'pdf', path: 'base.pdf' } },
        problems: [{ id: 'A', max_points: 500 }],
        judge: { kind: 'codeforces', contest_id: 100, handle: 'bot', languages: {} },
      },
    }],
    { root, base, dryRun: true },
  );
  assert.equal(emptyLangs.ok, false);
  assert.match(emptyLangs.errors[0].message, /language/i);

  // 2. Entrypoint sha256 mismatch caught in dryRun: true
  const badSha = await batchImportContests(
    [{
      document: {
        schema_version: 2,
        contest_id: 'sha-bad',
        data_version: 1,
        title: 'Bad SHA',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: 'base.pdf', sha256: '0'.repeat(64) } },
        judge: { kind: 'local', answers: { path: 'secret.judge.json' } },
      },
    }],
    { root, base, dryRun: true },
  );
  assert.equal(badSha.ok, false);
  assert.match(badSha.errors[0].message, /SHA-256 mismatch/i);

  // 3. Local judge max_points / ID mismatch caught in dryRun: true
  const badPoints = await batchImportContests(
    [{
      document: {
        schema_version: 2,
        contest_id: 'pts-bad',
        data_version: 1,
        title: 'Bad Points',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: 'base.pdf' } },
        problems: [{ id: 'A', max_points: 999 }],
        judge: { kind: 'local', answers: { path: 'secret.judge.json' } },
      },
    }],
    { root, base, dryRun: true },
  );
  assert.equal(badPoints.ok, false);
  assert.match(badPoints.errors[0].message, /do not match local answers/i);

  // 4. Attachment escape outside base rejected in dryRun: true
  const attEscape = await batchImportContests(
    [{
      document: {
        schema_version: 2,
        contest_id: 'att-esc',
        data_version: 1,
        title: 'Att Escape',
        source: { name: 'Local' },
        materials: {
          entrypoint: { kind: 'pdf', path: 'base.pdf' },
          attachments: [{ name: 'out.txt', path: join(outsideDir, 'outside.txt') }],
        },
        judge: { kind: 'local', answers: { path: 'secret.judge.json' } },
      },
    }],
    { root, base, dryRun: true },
  );
  assert.equal(attEscape.ok, false);
  assert.equal(attEscape.errors[0].code, 'path_error');

  // 5. Exposing *.judge.json as attachment rejected in dryRun: true
  const attJudge = await batchImportContests(
    [{
      document: {
        schema_version: 2,
        contest_id: 'att-judge',
        data_version: 1,
        title: 'Att Judge',
        source: { name: 'Local' },
        materials: {
          entrypoint: { kind: 'pdf', path: 'base.pdf' },
          attachments: [{ name: 'leak.json', path: 'secret.judge.json' }],
        },
        judge: { kind: 'local', answers: { path: 'secret.judge.json' } },
      },
    }],
    { root, base, dryRun: true },
  );
  assert.equal(attJudge.ok, false);
  assert.match(attJudge.errors[0].message, /Judge answer file cannot be exposed/i);

  // 6. Malformed private judge.json parse error MUST NOT echo secret file content!
  const SECRET_TOKEN = 'SUPER_SECRET_ANSWER_DO_NOT_ECHO_98765';
  await writeFile(join(base, 'contests', 'broken.judge.json'), `{ invalid json ${SECRET_TOKEN} `);
  const badJudgeJson = await batchImportContests(
    [{
      document: {
        schema_version: 2,
        contest_id: 'broken-judge',
        data_version: 1,
        title: 'Broken Judge',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: 'base.pdf' } },
        judge: { kind: 'local', answers: { path: 'broken.judge.json' } },
      },
    }],
    { root, base, dryRun: true },
  );
  assert.equal(badJudgeJson.ok, false);
  assert.ok(!JSON.stringify(badJudgeJson).includes(SECRET_TOKEN), 'Leaked private judge content in error!');
  assert.match(badJudgeJson.errors[0].message, /not valid JSON/i);
});

test('symlinked workspace base works for both batchApplyAgents and batchImportContests, while escaping native_config.path is rejected', async t => {
  const realBase = await makeTempDir(t, 'cr-symbase-real-');
  const linkHolder = await makeTempDir(t, 'cr-symbase-link-');
  const outsideDir = await makeTempDir(t, 'cr-symbase-out-');
  const root = await makeTempDir(t, 'cr-symbase-root-');
  const connDir = await makeTempDir(t, 'cr-symbase-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'p-sym',
    label: 'Sym Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-sym-secret-1234',
  });

  const symBase = join(linkHolder, 'ws-link');
  await symlink(realBase, symBase);
  const outsideNativeText = 'model_verbosity = "high"\n';
  await writeFile(join(outsideDir, 'outside.toml'), outsideNativeText);

  // Escaping native_config.path rejected even in dryRun: true (relative traversal outside base)
  const relEscapeNative = relative(join(realBase, 'agents'), join(outsideDir, 'outside.toml'));
  const nativeEscape = await batchApplyAgents(
    [{
      format: 'toml',
      document: {
        kind: 'contestreplay.dev/agent',
        schema_version: 1,
        id: 'esc-native',
        model: 'gpt-5.3-codex',
        provider: 'p-sym',
        harness: {
          kind: 'codex',
          version: '0.170.0',
          options: {},
          native_config: { format: 'toml', path: relEscapeNative, sha256: sha256(outsideNativeText) },
        },
      },
    }],
    { base: symBase, store, dryRun: true },
  );
  assert.equal(nativeEscape.ok, false);
  assert.equal(nativeEscape.errors[0].code, 'path_error');

  // Valid agent apply under symlinked base succeeds
  const agentOk = await batchApplyAgents(
    [{
      file: join(symBase, 'agents', 'sym-agent.toml'),
      format: 'toml',
      document: {
        kind: 'contestreplay.dev/agent',
        schema_version: 1,
        id: 'sym-agent',
        model: 'gpt-5.3-codex',
        provider: 'p-sym',
        harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium' } },
      },
    }],
    { base: symBase, store, dryRun: false, ifExists: 'error' },
  );
  assert.equal(agentOk.ok, true, JSON.stringify(agentOk.errors));
  assert.equal(agentOk.created, 1);
  assert.equal(await exists(join(realBase, 'agents', 'sym-agent.toml')), true);

  // Valid contest import under symlinked base succeeds
  const contestOk = await batchImportContests(
    [{
      file: join(symBase, 'contests', 'sym-round.json'),
      document: {
        schema_version: 2,
        contest_id: 'sym-round',
        data_version: 1,
        title: 'Symlink Base Round',
        source: { name: 'Sym' },
        judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
      },
      synth_problems: [{ id: 'A', title: 'One', body: 'Print 1.' }],
    }],
    { root, base: symBase, dryRun: false, ifExists: 'error' },
  );
  assert.equal(contestOk.ok, true, JSON.stringify(contestOk.errors));
  assert.equal(contestOk.created, 1);
  assert.equal(await exists(join(realBase, 'contests', 'sym-round.json')), true);
});

test('overwrite identity checks, pre-existing auxiliary files, intra-batch collisions, and variant template/out_dir guards', async t => {
  const base = await makeTempDir(t, 'cr-guard-base-');
  const root = await makeTempDir(t, 'cr-guard-root-');
  const connDir = await makeTempDir(t, 'cr-guard-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'p-guard',
    label: 'Guard Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-guard-secret-1234',
  });

  const agentDoc = (id) => ({
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id,
    model: 'gpt-5.3-codex',
    provider: 'p-guard',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium' } },
  });

  // 1. Refuses to overwrite package.json, run.json, or *.judge.json even under ifExists: 'overwrite', preserving exact bytes!
  const pkgBytes = '{"name":"preserve-me"}\n';
  const runBytes = '{"schema_version":2,"run_id":"keep-me"}\n';
  const judgeBytes = '{"schema_version":1,"problems":[{"id":"A","max_points":100,"accepted_answers":["1"]}]}\n';
  await writeFile(join(base, 'package.json'), pkgBytes);
  await writeFile(join(base, 'run.json'), runBytes);
  await mkdir(join(base, 'contests'), { recursive: true });
  await writeFile(join(base, 'contests', 'keep.judge.json'), judgeBytes);

  const overwritePkg = await batchApplyAgents(
    [{ file: 'package.json', format: 'json', document: agentDoc('pkg-agent') }],
    { base, store, dryRun: false, ifExists: 'overwrite' },
  );
  assert.equal(overwritePkg.ok, false);
  assert.equal(await readFile(join(base, 'package.json'), 'utf8'), pkgBytes);

  const overwriteRun = await batchImportContests(
    [{
      file: 'run.json',
      document: {
        schema_version: 2,
        contest_id: 'run-overwrite',
        data_version: 1,
        title: 'No',
        source: { name: 'X' },
        judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
      },
      synth_problems: [{ id: 'A', title: 'A', body: 'A' }],
    }],
    { root, base, dryRun: false, ifExists: 'overwrite' },
  );
  assert.equal(overwriteRun.ok, false);
  assert.equal(await readFile(join(base, 'run.json'), 'utf8'), runBytes);

  const overwriteJudge = await batchImportContests(
    [{
      file: 'contests/keep.judge.json',
      document: {
        schema_version: 2,
        contest_id: 'judge-overwrite',
        data_version: 1,
        title: 'No',
        source: { name: 'X' },
        judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
      },
      synth_problems: [{ id: 'A', title: 'A', body: 'A' }],
    }],
    { root, base, dryRun: false, ifExists: 'overwrite' },
  );
  assert.equal(overwriteJudge.ok, false);
  assert.equal(await readFile(join(base, 'contests', 'keep.judge.json'), 'utf8'), judgeBytes);

  // Batch with 1 valid overwrite + 1 invalid overwrite preserves pre-existing valid agent bytes untouched!
  const firstGood = await batchApplyAgents(
    [{ file: 'agents/good.json', format: 'json', document: agentDoc('good') }],
    { base, store, dryRun: false, ifExists: 'error' },
  );
  assert.equal(firstGood.ok, true);
  const origGoodBytes = await readFile(join(base, 'agents', 'good.json'), 'utf8');
  const mixedOverwriteFail = await batchApplyAgents(
    [
      { file: 'agents/good.json', format: 'json', document: { ...agentDoc('good'), name: 'Changed' } },
      { file: 'package.json', format: 'json', document: agentDoc('pkg-bad') },
    ],
    { base, store, dryRun: false, ifExists: 'overwrite' },
  );
  assert.equal(mixedOverwriteFail.ok, false);
  assert.equal(await readFile(join(base, 'agents', 'good.json'), 'utf8'), origGoodBytes);

  // 2. Pre-existing auxiliary file (contests/orphan.judge.json exists, contests/orphan.json does NOT)
  const orphanJudgeBytes = '{"schema_version":1,"problems":[{"id":"A","max_points":100,"accepted_answers":["old"]}]}\n';
  await writeFile(join(base, 'contests', 'orphan.judge.json'), orphanJudgeBytes);
  const orphanItem = {
    file: 'contests/orphan.json',
    document: {
      schema_version: 2,
      contest_id: 'orphan',
      data_version: 1,
      title: 'Orphan Aux',
      source: { name: 'Test' },
      judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['new'] }] },
    },
    synth_problems: [{ id: 'A', title: 'A', body: 'Solve A.' }],
  };
  const auxErr = await batchImportContests([orphanItem], { root, base, dryRun: false, ifExists: 'error' });
  assert.equal(auxErr.ok, false);
  assert.equal(auxErr.errors[0].code, 'conflict');

  const auxSkip = await batchImportContests([orphanItem], { root, base, dryRun: false, ifExists: 'skip' });
  assert.equal(auxSkip.ok, true, JSON.stringify(auxSkip.errors));
  assert.equal(auxSkip.skipped, 1);
  assert.equal(auxSkip.created, 0);
  assert.equal(await exists(join(base, 'contests', 'orphan.json')), false);
  assert.equal(await readFile(join(base, 'contests', 'orphan.judge.json'), 'utf8'), orphanJudgeBytes);

  // 3. Intra-batch auxiliary collision (item 0 writes foo.judge.json, item 1 writes/references foo.judge.json)
  const intraCollision = await batchImportContests(
    [
      {
        file: 'contests/foo.json',
        document: {
          schema_version: 2,
          contest_id: 'foo-1',
          data_version: 1,
          title: 'Foo 1',
          source: { name: 'Test' },
          judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
        },
        synth_problems: [{ id: 'A', title: 'A', body: 'A' }],
      },
      {
        file: 'contests/foo.judge.json',
        document: {
          schema_version: 2,
          contest_id: 'foo-2',
          data_version: 1,
          title: 'Foo 2',
          source: { name: 'Test' },
          judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['2'] }] },
        },
        synth_problems: [{ id: 'A', title: 'A', body: 'A' }],
      },
    ],
    { root, base, dryRun: false, ifExists: 'error' },
  );
  assert.equal(intraCollision.ok, false);
  assert.equal(await exists(join(base, 'contests', 'foo.json')), false);

  // 4. Variant builder rejects unknown {bogus} placeholder and absolute out_dir: "/"
  const badPlaceholder = await generateAgentVariants(
    {
      base_document: agentDoc('var-base'),
      reasoning_efforts: ['low'],
      id_template: '{id}-{bogus}',
    },
    { base, store, dryRun: true },
  );
  assert.equal(badPlaceholder.ok, false);
  assert.match(badPlaceholder.errors[0].message, /\{bogus\}/);

  const badOutDir = await generateAgentVariants(
    {
      base_document: agentDoc('var-base'),
      reasoning_efforts: ['low'],
      out_dir: '/',
    },
    { base, store, dryRun: true },
  );
  assert.equal(badOutDir.ok, false);
  assert.equal(badOutDir.errors[0].code, 'path_error');
});

test('forbidden public filenames, content-based judge attachment rejection, size limits parity, symlinked-base path rewriting, and hash-verified rollback', async t => {
  const realBase = await makeTempDir(t, 'cr-polish-real-');
  const linkHolder = await makeTempDir(t, 'cr-polish-link-');
  const root = await makeTempDir(t, 'cr-polish-root-');
  const connDir = await makeTempDir(t, 'cr-polish-conn-');
  await chmod(connDir, 0o700);
  const store = new Connections(connDir);
  await store.create({
    id: 'p-polish',
    label: 'Polish Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-polish-secret-1234',
  });

  const symBase = join(linkHolder, 'ws-link');
  await symlink(realBase, symBase);

  const agentDoc = (id) => ({
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id,
    model: 'gpt-5.3-codex',
    provider: 'p-polish',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium' } },
  });

  // 1. Forbidden public filenames rejected on CREATE (non-existent targets) for BOTH agents and contests!
  for (const forbidden of ['agents/judge.json', 'agents/foo.judge.json', 'agents/package.json', 'agents/run.json']) {
    const res = await batchApplyAgents(
      [{ file: forbidden, format: 'json', document: agentDoc('forbid-a') }],
      { base: realBase, root, store, dryRun: false, ifExists: 'error' },
    );
    assert.equal(res.ok, false, `expected ${forbidden} to be rejected for agent create`);
    assert.equal(await exists(join(realBase, forbidden)), false);
  }

  for (const forbidden of ['contests/judge.json', 'contests/foo.judge.json', 'contests/package.json', 'contests/run.json']) {
    const res = await batchImportContests(
      [{
        file: forbidden,
        document: {
          schema_version: 2,
          contest_id: 'forbid-c',
          data_version: 1,
          title: 'Forbidden',
          source: { name: 'Test' },
          judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
        },
        synth_problems: [{ id: 'A', title: 'A', body: 'Solve A.' }],
      }],
      { root, base: realBase, dryRun: false, ifExists: 'error' },
    );
    assert.equal(res.ok, false, `expected ${forbidden} to be rejected for contest create`);
    assert.equal(await exists(join(realBase, forbidden)), false);
  }

  // 2. judge.json, package.json, run.json, AND arbitrary-extension JSON judge answer file rejected as attachments!
  await mkdir(join(realBase, 'contests'), { recursive: true });
  await synthesizeTextContestPdf(
    [{ id: 'A', title: 'Alpha', body: 'Solve A.' }],
    join(realBase, 'contests', 'base.pdf'),
    { title: 'Base PDF' },
  );
  const validJudgeJson = JSON.stringify({
    schema_version: 1,
    problems: [{ id: 'A', max_points: 100, accepted_answers: ['secret-42'] }],
  });
  await writeFile(join(realBase, 'contests', 'answers.judge.json'), validJudgeJson);
  await writeFile(join(realBase, 'contests', 'judge.json'), validJudgeJson);
  await writeFile(join(realBase, 'contests', 'package.json'), '{"name":"pkg"}');
  await writeFile(join(realBase, 'contests', 'run.json'), '{"run_id":"r1"}');
  await writeFile(join(realBase, 'contests', 'disguised-answers.txt'), validJudgeJson);

  for (const attFile of ['judge.json', 'package.json', 'run.json', 'disguised-answers.txt']) {
    const res = await batchImportContests(
      [{
        file: 'contests/att-check.json',
        document: {
          schema_version: 2,
          contest_id: 'att-check',
          data_version: 1,
          title: 'Att Check',
          source: { name: 'Test' },
          materials: {
            entrypoint: { kind: 'pdf', path: 'base.pdf' },
            attachments: [{ name: 'leaked.dat', path: attFile }],
          },
          judge: { kind: 'local', answers: { path: 'answers.judge.json' } },
        },
      }],
      { root, base: realBase, dryRun: true },
    );
    assert.equal(res.ok, false, `expected attachment ${attFile} to be rejected`);
  }

  // 3. > 4,000,000-byte judge table rejected identically in BOTH dryRun: true and dryRun: false with ZERO files written
  const hugeAnswers = Array.from({ length: 1200 }, () => 'x'.repeat(3500));
  const hugeJudgeItem = {
    file: 'contests/huge-judge.json',
    document: {
      schema_version: 2,
      contest_id: 'huge-judge',
      data_version: 1,
      title: 'Huge Judge',
      source: { name: 'Test' },
      judge: {
        kind: 'local',
        problems: [{ id: 'A', max_points: 100, accepted_answers: hugeAnswers }],
      },
    },
    synth_problems: [{ id: 'A', title: 'A', body: 'A' }],
  };
  const hugeJudgeDry = await batchImportContests([hugeJudgeItem], { root, base: realBase, dryRun: true });
  const hugeJudgeLive = await batchImportContests([hugeJudgeItem], { root, base: realBase, dryRun: false });
  assert.equal(hugeJudgeDry.ok, false);
  assert.equal(hugeJudgeLive.ok, false);
  assert.match(hugeJudgeDry.errors[0].message, /4000000/);
  assert.match(hugeJudgeLive.errors[0].message, /4000000/);
  assert.equal(await exists(join(realBase, 'contests', 'huge-judge.json')), false);
  assert.equal(await exists(join(realBase, 'contests', 'huge-judge.pdf')), false);
  assert.equal(await exists(join(realBase, 'contests', 'huge-judge.judge.json')), false);

  // 4. > 1,000,000-byte contest manifest rejected identically in BOTH dryRun: true and dryRun: false with ZERO files written
  const hugeTitle = 'T'.repeat(1_000_500);
  const hugeManifestItem = {
    file: 'contests/huge-manifest.json',
    document: {
      schema_version: 2,
      contest_id: 'huge-manifest',
      data_version: 1,
      title: hugeTitle,
      source: { name: 'Test' },
      judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
    },
    synth_problems: [{ id: 'A', title: 'A', body: 'A' }],
  };
  const hugeManDry = await batchImportContests([hugeManifestItem], { root, base: realBase, dryRun: true });
  const hugeManLive = await batchImportContests([hugeManifestItem], { root, base: realBase, dryRun: false });
  assert.equal(hugeManDry.ok, false);
  assert.equal(hugeManLive.ok, false);
  assert.match(hugeManDry.errors[0].message, /1000000/);
  assert.match(hugeManLive.errors[0].message, /1000000/);
  assert.equal(await exists(join(realBase, 'contests', 'huge-manifest.json')), false);
  assert.equal(await exists(join(realBase, 'contests', 'huge-manifest.pdf')), false);
  assert.equal(await exists(join(realBase, 'contests', 'huge-manifest.judge.json')), false);

  // 5. Absolute transitive paths under symlinked base are rewritten to relative paths before saving!
  await mkdir(join(realBase, 'agents'), { recursive: true });
  await mkdir(join(realBase, 'shared'), { recursive: true });
  const nativeText = 'model_verbosity = "high"\n';
  await writeFile(join(realBase, 'shared', 'override.toml'), nativeText);
  await writeFile(join(realBase, 'shared', 'helper.txt'), 'helper content\n');

  const absAgentRes = await batchApplyAgents(
    [{
      file: join(symBase, 'agents', 'rel-agent.json'),
      format: 'json',
      document: {
        ...agentDoc('rel-agent'),
        harness: {
          kind: 'codex',
          version: '0.170.0',
          options: { reasoning_effort: 'high' },
          native_config: {
            format: 'toml',
            path: join(symBase, 'shared', 'override.toml'),
            sha256: sha256(nativeText),
          },
        },
      },
    }],
    { base: symBase, root, store, dryRun: false, ifExists: 'error' },
  );
  assert.equal(absAgentRes.ok, true, JSON.stringify(absAgentRes.errors));
  const savedAgentJson = JSON.parse(await readFile(join(realBase, 'agents', 'rel-agent.json'), 'utf8'));
  assert.equal(savedAgentJson.harness.native_config.path, '../shared/override.toml');
  const reloadedAgent = await loadAgent(join(realBase, 'agents', 'rel-agent.json'), store);
  assert.equal(reloadedAgent.agent.agent_id, 'rel-agent');

  const absContestRes = await batchImportContests(
    [{
      file: join(symBase, 'contests', 'rel-contest.json'),
      document: {
        schema_version: 2,
        contest_id: 'rel-contest',
        data_version: 1,
        title: 'Rebased Paths Contest',
        source: { name: 'Test' },
        materials: {
          entrypoint: { kind: 'pdf', path: join(symBase, 'contests', 'base.pdf') },
          attachments: [{ name: 'helper.txt', path: join(symBase, 'shared', 'helper.txt') }],
        },
        judge: { kind: 'local', answers: { path: join(symBase, 'contests', 'answers.judge.json') } },
      },
    }],
    { root, base: symBase, dryRun: false, ifExists: 'error' },
  );
  assert.equal(absContestRes.ok, true, JSON.stringify(absContestRes.errors));
  const savedContestJson = JSON.parse(await readFile(join(realBase, 'contests', 'rel-contest.json'), 'utf8'));
  assert.equal(savedContestJson.materials.entrypoint.path, 'base.pdf');
  assert.equal(savedContestJson.materials.attachments[0].path, '../shared/helper.txt');
  assert.equal(savedContestJson.judge.answers.path, 'answers.judge.json');
  const reloadedContest = await loadContest(join(realBase, 'contests', 'rel-contest.json'));
  assert.equal(reloadedContest.contest.contest_id, 'rel-contest');

  // 6. Rollback verifies sha256 and NEVER clobbers an externally modified file, reporting rollback issues explicitly!
  const externalContent = '# CONCURRENT WRITER CONTENT\n';
  let registerCount = 0;
  const racingStore = Object.create(store);
  racingStore.register = async (providerId, filePath, writeFn) => {
    registerCount++;
    if (registerCount === 1) {
      await store.register(providerId, filePath, writeFn);
      // Simulate concurrent external writer modifying item 0 after this batch wrote it!
      await writeFile(filePath, externalContent, { mode: 0o600 });
      return;
    }
    throw new Error('simulated publish failure on item 2');
  };

  await assert.rejects(
    () =>
      batchApplyAgents(
        [
          { file: 'agents/race-1.toml', format: 'toml', document: agentDoc('race-1') },
          { file: 'agents/race-2.toml', format: 'toml', document: agentDoc('race-2') },
        ],
        { base: realBase, root, store: racingStore, dryRun: false, ifExists: 'error' },
      ),
    err => {
      assert.match(err.message, /simulated publish failure on item 2/);
      assert.match(err.message, /rollback issues.*modified concurrently/i);
      return true;
    },
  );
  // Externally modified file MUST NOT be deleted or overwritten by rollback!
  assert.equal(await readFile(join(realBase, 'agents', 'race-1.toml'), 'utf8'), externalContent);
  assert.equal(await exists(join(realBase, 'agents', 'race-2.toml')), false);
});
