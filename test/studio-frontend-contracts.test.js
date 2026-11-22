import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connections } from '../dist/connections.js';
import { OjAccounts } from '../dist/judges/index.js';
import { synthesizeTextContestPdf } from '../dist/pdf-synth.js';
import { startStudio } from '../dist/studio.js';
import {
  agentItemResponseSchema,
  contestItemResponseSchema,
  preflightReportSchema,
} from '../dist/studio-contract.js';

const FAKE_IMAGE = 'sha256:' + 'c'.repeat(64);
const getImage = async () => FAKE_IMAGE;

function makeRequester(baseUrl) {
  return async (path, opts = {}) => {
    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
    const headers = { ...(opts.headers ?? {}) };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['Origin'] = baseUrl;
      headers['X-CR-Studio'] = '1';
    }
    let body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, text, value };
  };
}

test('Studio frontend contracts against real backend: preflight, remote contests, revision preservation, external native_config, variants', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-studio-fe-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'workspace');
  const root = join(dir, 'runs');
  await mkdir(join(base, 'agents'), { recursive: true });
  await mkdir(join(base, 'contests'), { recursive: true });
  await mkdir(root, { recursive: true });

  const store = new Connections(join(dir, 'connections'));
  const ojAccounts = new OjAccounts(join(dir, 'oj-accounts'));
  await store.create({
    id: 'demo-prov',
    label: 'Demo Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-test-fixture-not-real-000001',
  });
  await ojAccounts.create({
    id: 'cf-acc',
    label: 'CF Account',
    platform: 'codeforces',
    handle: 'cf_demo_bot',
    transport: 'cookie',
    secret: 'JSESSIONID=fixture-cf-cookie',
  });

  const pdfPath = join(base, 'contests', 'problems.pdf');
  await synthesizeTextContestPdf([{ id: 'A', title: 'Alpha', body: 'Output 42.' }], pdfPath);
  const pdfBytes = await readFile(pdfPath);
  const pdfSha = createHash('sha256').update(pdfBytes).digest('hex');

  const overrideText = 'model_verbosity = "low"\n';
  const overrideSha = createHash('sha256').update(overrideText).digest('hex');
  await writeFile(join(base, 'agents', 'override.toml'), overrideText, 'utf8');

  const studio = await startStudio(root, 0, {
    base,
    store,
    ojAccounts,
    getImage,
    previewContest: async (platform, contestId) => ({
      platform,
      contest_ref: String(contestId),
      title: `Preview ${contestId}`,
      status: 'finished',
      problems: [{ remote_id: 'A', title: 'Alpha', max_points: 500 }],
      suggested_languages: [],
    }),
  });
  t.after(() => studio.close());
  const req = makeRequester(studio.url);

  // 1. Agent with external { path, sha256, format } native_config survives name-only PUT unchanged
  const agentDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'agent-ext',
    name: 'Agent Ext',
    vendor: 'openai',
    provider: 'demo-prov',
    model: 'gpt-5.3-codex',
    harness: {
      kind: 'codex',
      version: '0.170.0',
      options: { reasoning_effort: 'medium' },
      native_config: { format: 'toml', path: 'override.toml', sha256: overrideSha },
    },
  };
  const createdAgent = await req('/api/agents', { body: { document: agentDoc } });
  assert.equal(createdAgent.status, 201, createdAgent.text);
  const loadedAgent = await req(`/api/agents/item?path=${encodeURIComponent('agents/agent-ext.toml')}`);
  assert.equal(loadedAgent.status, 200, loadedAgent.text);
  const parsedAgent = agentItemResponseSchema.parse(loadedAgent.value);
  const originalEffective = parsedAgent.digests?.effective_sha256;

  // Name-only PUT preserving original native_config object
  const updatedAgent = await req('/api/agents/item', {
    method: 'PUT',
    body: {
      path: parsedAgent.path,
      format: parsedAgent.format,
      document: { ...parsedAgent.document, name: 'Agent Ext Renamed' },
    },
  });
  assert.equal(updatedAgent.status, 200, updatedAgent.text);
  assert.equal(updatedAgent.value.digests.effective_sha256, originalEffective);
  assert.deepEqual(updatedAgent.value.manifest.harness.native_config, {
    format: 'toml',
    path: 'override.toml',
    sha256: overrideSha,
  });

  // 1b. Agent effective-config preview succeeds with file: parsedAgent.path for external native_config
  const previewedAgent = await req('/api/agents/preview', {
    body: { file: parsedAgent.path, document: updatedAgent.value.manifest },
  });
  assert.equal(previewedAgent.status, 200, previewedAgent.text);
  assert.match(previewedAgent.value.content, /model_verbosity\s*=\s*"low"/);

  // 2. Variant matrix default non-colliding selection succeeds on dry-run AND real write
  const dryVariants = await req('/api/agents/variants', {
    body: {
      base_document: updatedAgent.value.manifest,
      reasoning_efforts: ['high'],
      speed_tiers: ['standard'],
      dry_run: true,
    },
  });
  assert.equal(dryVariants.status, 200, dryVariants.text);
  assert.equal(dryVariants.value.variants[0].id, 'agent-ext-high');
  const createdVariants = await req('/api/agents/variants', {
    body: {
      base_document: updatedAgent.value.manifest,
      reasoning_efforts: ['high'],
      speed_tiers: ['standard'],
      dry_run: false,
    },
  });
  assert.equal(createdVariants.status, 201, createdVariants.text);
  assert.equal(createdVariants.value.variants[0].id, 'agent-ext-high');

  // 3. Remote Contests for QOJ, VJudge, Hydro, and Codeforces with explicit problems + languages all save cleanly
  const remotePayloads = [
    {
      file: 'contests/qoj-demo.json',
      contest_id: 'qoj-demo',
      judge: { kind: 'qoj', contest_id: '1234', languages: { cpp17: 'C++17' }, problem_map: { A: '1001' } },
    },
    {
      file: 'contests/vjudge-demo.json',
      contest_id: 'vjudge-demo',
      judge: { kind: 'vjudge', contest_id: '600001', languages: { cpp17: '54' }, problem_map: { A: 'CodeForces-1A' } },
    },
    {
      file: 'contests/hydro-demo.json',
      contest_id: 'hydro-demo',
      judge: {
        kind: 'hydro',
        base_url: 'https://hydro.example.com',
        domain: 'system',
        contest_id: 'c1',
        languages: { cpp17: 'cc.cc17o2' },
        problem_map: { A: 'P1000' },
      },
    },
    {
      file: 'contests/cf-demo.json',
      contest_id: 'cf-demo',
      judge: {
        kind: 'codeforces',
        contest_id: 1999,
        account_id: 'cf-acc',
        languages: { cpp17: '54' },
        problem_map: { A: 'A' },
        points_known: true,
      },
    },
  ];
  for (const spec of remotePayloads) {
    const res = await req('/api/contests', {
      body: {
        file: spec.file,
        document: {
          kind: 'contestreplay.dev/contest',
          schema_version: 2,
          contest_id: spec.contest_id,
          data_version: 1,
          title: `Title ${spec.contest_id}`,
          source: { name: 'Demo' },
          materials: { entrypoint: { kind: 'pdf', path: 'problems.pdf', sha256: pdfSha, redistribution: 'restricted' } },
          rules: { time_limit_ms: 90_000, max_submissions: 100 },
          problems: [{ id: 'A', max_points: 500 }],
          judge: spec.judge,
        },
      },
    });
    assert.equal(res.status, 201, `${spec.contest_id}: ${res.text}`);
  }

  // Title-only edit on Codeforces remote contest preserves explicit problems, time_limit_ms, and contest_revision
  const cfLoaded = contestItemResponseSchema.parse(
    (await req(`/api/contests/item?path=${encodeURIComponent('contests/cf-demo.json')}&include_judge=1`)).value,
  );
  const cfUpdated = await req('/api/contests/item', {
    method: 'PUT',
    body: {
      path: cfLoaded.path,
      document: { ...cfLoaded.document, title: 'Renamed CF Contest' },
    },
  });
  assert.equal(cfUpdated.status, 200, cfUpdated.text);
  const cfReloaded = contestItemResponseSchema.parse(
    (await req(`/api/contests/item?path=${encodeURIComponent('contests/cf-demo.json')}&include_judge=1`)).value,
  );
  assert.equal(cfReloaded.contest_revision, cfLoaded.contest_revision);
  assert.deepEqual(cfReloaded.document.problems, [{ id: 'A', max_points: 500 }]);
  assert.equal(cfReloaded.document.rules.time_limit_ms, 90_000);

  // 4. Local Contest with non-minute time_limit_ms (10,000 ms & 90,000 ms): title-only edit keeps contest_revision unchanged
  const localCreated = await req('/api/contests', {
    body: {
      file: 'contests/local-submin.json',
      document: {
        kind: 'contestreplay.dev/contest',
        schema_version: 2,
        contest_id: 'local-submin',
        data_version: 1,
        title: 'Local Sub-Minute',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: 'problems.pdf', sha256: pdfSha, redistribution: 'restricted' } },
        rules: { time_limit_ms: 10_000, max_submissions: 50 },
        problems: [{ id: 'A', max_points: 10 }],
        judge: { kind: 'local', problems: [{ id: 'A', max_points: 10, accepted_answers: ['42'] }] },
      },
    },
  });
  assert.equal(localCreated.status, 201, localCreated.text);
  const localLoaded = contestItemResponseSchema.parse(
    (await req(`/api/contests/item?path=${encodeURIComponent('contests/local-submin.json')}&include_judge=1`)).value,
  );
  const localUpdated = await req('/api/contests/item', {
    method: 'PUT',
    body: {
      path: localLoaded.path,
      document: { ...localLoaded.document, title: 'Local Sub-Minute Renamed' },
    },
  });
  assert.equal(localUpdated.status, 200, localUpdated.text);
  const localReloaded = contestItemResponseSchema.parse(
    (await req(`/api/contests/item?path=${encodeURIComponent('contests/local-submin.json')}&include_judge=1`)).value,
  );
  assert.equal(localReloaded.contest_revision, localLoaded.contest_revision);
  assert.equal(localReloaded.document.rules.time_limit_ms, 10_000);
  assert.equal(localReloaded.document.materials.entrypoint.sha256, pdfSha);

  // 4b. Pre-existing hand-authored manifest referencing answers.json preserves exact binding without generating a new .judge.<hash>.json file
  const handAnswers = JSON.stringify({ schema_version: 1, problems: [{ id: 'A', max_points: 10, accepted_answers: ['42'] }] }, null, 2) + '\n';
  const handAnswersSha = createHash('sha256').update(handAnswers).digest('hex');
  await writeFile(join(base, 'contests', 'answers.json'), handAnswers, 'utf8');
  await writeFile(join(base, 'contests', 'hand-demo.json'), JSON.stringify({
    schema_version: 2,
    contest_id: 'hand-demo',
    data_version: 1,
    title: 'Hand Authored',
    source: { name: 'Local' },
    materials: { entrypoint: { kind: 'pdf', path: 'problems.pdf', sha256: pdfSha, redistribution: 'restricted' } },
    problems: [{ id: 'A', max_points: 10 }],
    rules: { time_limit_ms: 90_000, max_submissions: 50 },
    judge: { kind: 'local', answers: { path: 'answers.json', sha256: handAnswersSha, redistribution: 'restricted' } },
  }, null, 2) + '\n', 'utf8');
  const handLoaded = contestItemResponseSchema.parse(
    (await req(`/api/contests/item?path=${encodeURIComponent('contests/hand-demo.json')}&include_judge=1`)).value,
  );
  const handUpdated = await req('/api/contests/item', {
    method: 'PUT',
    body: {
      path: handLoaded.path,
      document: { ...handLoaded.document, title: 'Hand Authored Renamed' },
    },
  });
  assert.equal(handUpdated.status, 200, handUpdated.text);
  const handReloaded = contestItemResponseSchema.parse(
    (await req(`/api/contests/item?path=${encodeURIComponent('contests/hand-demo.json')}&include_judge=1`)).value,
  );
  assert.equal(handReloaded.contest_revision, handLoaded.contest_revision);
  assert.equal(handReloaded.document.judge.answers.path, 'answers.json');
  const contestFiles = await readdir(join(base, 'contests'));
  assert.ok(!contestFiles.some(name => name.startsWith('hand-demo.judge.')), `Unexpected generated judge copy: ${contestFiles.join(', ')}`);

  // 4c. Remote Contest preview resolves manifest-relative pdf_path (contests/problems.pdf) and saved relative managed upload path
  const remotePreviewRel = await req('/api/contests/preview', {
    body: {
      platform: 'codeforces',
      contest_id: 1999,
      manifest_path: 'contests/cf-demo.json',
      manifest_contest_id: 'cf-demo',
      pdf_path: 'problems.pdf',
    },
  });
  assert.equal(remotePreviewRel.status, 200, remotePreviewRel.text);
  assert.equal(remotePreviewRel.value.pdf_info.path, 'contests/problems.pdf');
  assert.ok(remotePreviewRel.value.pdf_info.page_count >= 1);

  const managedDir = join(root, '.materials', 'cf-demo', 'entrypoint');
  await mkdir(managedDir, { recursive: true });
  await writeFile(join(managedDir, 'uploaded.pdf'), pdfBytes);
  const remotePreviewManagedRel = await req('/api/contests/preview', {
    body: {
      platform: 'codeforces',
      contest_id: 1999,
      manifest_path: 'contests/cf-demo.json',
      manifest_contest_id: 'cf-demo',
      pdf_path: '../../runs/.materials/cf-demo/entrypoint/uploaded.pdf',
    },
  });
  assert.equal(remotePreviewManagedRel.status, 200, remotePreviewManagedRel.text);
  assert.equal(remotePreviewManagedRel.value.pdf_info.path, 'managed/cf-demo/entrypoint/uploaded.pdf');

  // 5. Preflight accepts exact frontend payload { cells } (no schema_version)
  const preflight = await req('/api/preflight', {
    body: { cells: [{ agent: 'agents/agent-ext.toml', contest: 'contests/local-submin.json' }] },
  });
  assert.equal(preflight.status, 200, preflight.text);
  const report = preflightReportSchema.parse(preflight.value);
  assert.equal(report.ok, true);
});
