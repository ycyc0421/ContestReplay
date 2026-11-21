import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startStudio } from '../dist/studio.js';
import { Connections } from '../dist/connections.js';
import { loadContest, loadAgent, modelKey } from '../dist/config.js';
import { makePlan, verifyPlan } from '../dist/plan.js';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'cr-config-'));
  const root = join(base, 'runs');
  const store = new Connections(join(base, '.connections'));
  const image = async () => 'sha256:' + 'a'.repeat(64);
  const app = await startStudio(root, 0, { base, store, getImage: image });
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const request = async (path, payload, method = payload === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.url + path, { method, headers: { Origin: app.url, 'X-CR-Studio': '1',
      ...(payload !== undefined && !(payload instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      body: payload instanceof FormData ? payload : payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await response.text();
    return { status: response.status, value: JSON.parse(text), text };
  };
  return { base, root, store, app, request, image };
}

test('Studio discovers harness fields and saves equivalent JSON/YAML/TOML, preserving runtime revision', async t => {
  const { base, store, request, image, app } = await fixture(t);
  const caps = (await request('/api/capabilities')).value;
  assert.deepEqual(caps.manifest_formats, ['toml', 'yaml', 'json']);
  const adapter = caps.harnesses.find(x => x.id === 'codex');
  assert.ok(adapter.fields[0].options.some(x => x.value === 'max'));
  assert.deepEqual(adapter.environment.map(item => item.name), ['LANG', 'LC_ALL']);
  const localConnection = (command, id, secret, ...options) => {
    const group = command === 'rotate' ? 'provider' : 'connection';
    const result = spawnSync(process.execPath, ['dist/cli.js', group, command, id, '--secret-stdin', ...options], {
      input: secret, encoding: 'utf8', env: { ...process.env, CR_CONNECTIONS_DIR: store.root, CR_CREDENTIAL_STORAGE: 'file' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  };
  const create = (id, secret) => localConnection('add', id, secret, '--base-url', 'https://api.openai.com/v1');
  const token = 'fixture-never-echo';
  create('demo', token);
  assert.ok(!(await request('/api/connections')).text.includes(token));
  const blocked = await request('/api/connections', { secret: token, label: '' });
  assert.equal(blocked.status, 404);
  assert.ok(!blocked.text.includes(token));
  create('demo-copy', 'second-token');
  const doc = { kind: 'contestreplay.dev/agent', schema_version: 1, id: 'demo', vendor: 'openai', model: 'gpt-5.3-codex', connection: 'demo',
    harness: { kind: 'codex', version: adapter.version, options: { reasoning_effort: 'max' }, native_config: { format: 'toml', content: 'model_verbosity = "high"' } } };
  const preview = await request('/api/agents/preview', { document: doc });
  assert.equal(preview.status, 200, preview.text);
  assert.match(preview.value.content, /model_verbosity = "high"/);
  assert.ok(!preview.text.includes(token));
  const inspect = async (format, file, document = doc) => {
    const result = await request('/api/agents', { document, format, file });
    assert.equal(result.status, 201, result.text);
    assert.ok(!(await readFile(result.value.path, 'utf8')).includes(token));
    const loaded = await loadAgent(result.value.path, store);
    assert.equal(loaded.agentDigest, result.value.digests.source_sha256);
    assert.equal(loaded.effectiveDigest, result.value.digests.effective_sha256);
    return result.value;
  };
  const json = await inspect('json', 'agent.json');
  const yaml = await inspect('yaml', 'agent.yml');
  const toml = await inspect('toml', 'agent.toml', { ...doc, vendor: 'anthropic', connection: 'demo-copy' });
  assert.equal(await modelKey(await loadAgent(yaml.path, store), store), token);
  assert.notEqual(yaml.digests.source_sha256, json.digests.source_sha256);
  for (const item of [json, yaml, toml]) {
    assert.equal(item.revision, preview.value.revision);
    assert.equal(item.digests.profile_sha256, json.digests.profile_sha256);
  }
  const changed = await request('/api/agents/preview', { document: { ...doc, harness: { ...doc.harness, native_config: { format: 'toml', content: 'model_verbosity = "low"' } } } });
  assert.notEqual(changed.value.revision, json.revision);
  const language = await request('/api/agents/preview', { document: { ...doc, harness: { ...doc.harness, env: { LANG: 'C.UTF-8' } } } });
  assert.equal(language.status, 200, language.text);
  assert.notEqual(language.value.revision, json.revision);
  assert.deepEqual(language.value.env, { LANG: 'C.UTF-8' });
  const override = 'model_verbosity = "high"';
  await writeFile(join(base, 'native.toml'), override);
  const external = { ...doc, harness: { ...doc.harness, native_config: { format: 'toml', path: 'native.toml', sha256: createHash('sha256').update(override).digest('hex') } } };
  assert.equal((await inspect('yaml', 'external.yaml', external)).revision, json.revision);
  await writeFile(join(base, 'native.toml'), 'model_verbosity = "low"');
  await assert.rejects(loadAgent(join(base, 'external.yaml'), store), /SHA-256 mismatch/);
  const invalidEnv = await request('/api/agents/validate', { document: { ...doc, harness: { ...doc.harness, env: { PATH: '/tmp' } } } });
  assert.equal(invalidEnv.status, 400);
  assert.deepEqual(invalidEnv.value.issues[0].path, ['harness', 'env']);
  const rejected = await request('/api/agents/validate', { document: { ...doc, harness: { ...doc.harness, native_config: { format: 'toml', content: '[model_providers.cr]\nbase_url="https://example.org"' } } } });
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.value.issues[0].path, ['harness', 'native_config']);
  assert.equal((await request('/api/agents', { document: doc, format: 'yaml', file: 'wrong.json' })).status, 400);
  assert.equal((await request('/api/agents', { document: doc, format: 'json', file: '../outside.json' })).status, 400);
  assert.equal((await request('/api/agents', { document: doc, format: 'json', file: 'agent.json' })).status, 409);
  assert.equal((await request('/api/connections/demo', undefined, 'DELETE')).status, 409);
  assert.equal((await request('/api/connections/demo', { base_url: 'https://elsewhere.example/v1' }, 'PATCH')).status, 409);
  localConnection('rotate', 'demo', 'next-token');
  assert.equal(await modelKey(await loadAgent(yaml.path, store), store), 'next-token');
  create('unreferenced', 'temp-token');
  assert.equal((await request('/api/connections/unreferenced', undefined, 'DELETE')).status, 200);
  const plan = await makePlan({ schema_version: 1, agents: [yaml.path], contests: [resolve('examples/demo/contest.json')] }, base, image, store);
  assert.equal(plan.jobs[0].agent_revision, json.revision);
  await verifyPlan(plan, true, store);
  const cli = spawnSync(process.execPath, ['dist/cli.js', 'agent', 'validate', yaml.path], { encoding: 'utf8', env: { ...process.env, CR_CONNECTIONS_DIR: store.root } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).vendor, 'openai');
  const cliInit = (...args) => spawnSync(process.execPath, ['dist/cli.js', 'agent', 'init', ...args], {
    encoding: 'utf8', env: { ...process.env, CR_CONNECTIONS_DIR: store.root },
  });
  const path = join(base, 'from-cli.yaml');
  const flags = ['--id', 'from-cli', '--harness', 'codex', '--model', 'gpt-5.3-codex', '--reasoning-effort', 'max'];
  const created = cliInit(path, ...flags, '--connection', 'demo', '--vendor', 'anthropic');
  assert.equal(created.status, 0, created.stderr);
  const fromCli = await loadAgent(path, store);
  assert.equal(fromCli.vendor, 'anthropic');
  assert.equal(fromCli.connection, 'demo');
  assert.equal(fromCli.profile.reasoning_effort, 'max');
  assert.equal(cliInit(path, ...flags, '--connection', 'demo').status, 1);
  assert.equal(cliInit(join(base, 'mixed.yaml'), ...flags, '--connection', 'demo', '--key-env', 'OPENAI_API_KEY').status, 1);
  const oldPath = join(base, 'legacy.toml');
  assert.equal(cliInit(oldPath, ...flags).status, 0);
  assert.equal((await loadAgent(oldPath, store)).connection, undefined);
  assert.equal((await request('/api/connections/demo', { base_url: 'https://api.openai.com/v2' }, 'PATCH')).status, 200);
  await assert.rejects(verifyPlan(plan, false, store), /regenerate the plan/);
  const crossOrigin = await fetch(app.url + '/api/connections/demo', { method: 'DELETE', headers: { Origin: 'https://example.org', 'X-CR-Studio': '1' } });
  assert.equal(crossOrigin.status, 403);
});

test('Studio keeps uploaded files private, validates names and generates one consistent judge table', async t => {
  const { base, root, app, request } = await fixture(t);
  const pdf = await readFile('examples/demo/problems.pdf');
  const upload = (name, bytes, kind, id = 'demo') => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name); form.append('contest_id', id); form.append('kind', kind);
    return request('/api/contests/materials', form);
  };
  assert.equal((await upload('../bad.pdf', pdf, 'entrypoint')).status, 400);
  assert.equal((await upload('invalid.pdf', 'not a PDF', 'entrypoint')).status, 400);
  assert.equal((await upload('good.pdf', pdf, 'entrypoint', '../outside')).status, 400);
  const paper = await upload('round.pdf', pdf, 'entrypoint');
  assert.equal(paper.status, 201, paper.text);
  assert.equal((await upload('round.pdf', pdf, 'entrypoint')).status, 409);
  const attachmentBytes = Buffer.alloc(96 * 1024, 'a');
  const attachment = await upload('fixture.txt', attachmentBytes, 'attachment');
  assert.equal(attachment.status, 201, attachment.text);
  assert.equal((await fetch(app.url + '/' + paper.value.path)).status, 404);
  assert.equal((await stat(join(root, '.materials/demo/entrypoint/round.pdf'))).mode & 0o077, 0);
  await mkdir(join(base, 'local'));
  const doc = { kind: 'contestreplay.dev/contest', schema_version: 2, contest_id: 'demo', data_version: 2, title: 'Demo', source: { name: 'Fixture' },
    materials: { entrypoint: paper.value, attachments: [attachment.value] },
    judge: { kind: 'local', problems: [{ id: 'A', max_points: 2, accepted_answers: ['42'] }] }, rules: { time_limit_ms: 1234, max_submissions: 7 } };
  const saved = await request('/api/contests', { file: 'local/contest.json', document: doc });
  assert.equal(saved.status, 201, saved.text);
  const input = await loadContest(saved.value.path);
  assert.deepEqual(input.contest.problems, [{ id: 'A', max_points: 2 }]);
  assert.equal(input.judge.problems[0].accepted_answers[0], '42');
  assert.equal(input.contest.rules.time_limit_ms, 1234);
  assert.deepEqual(input.attachments[0].bytes, attachmentBytes);
  assert.equal((await upload('too-big.bin', Buffer.alloc(16_000_001), 'attachment')).status, 413);
  assert.ok(!(await readFile(saved.value.path, 'utf8')).includes('accepted_answers'));
  assert.equal((await request('/api/contests', { file: 'local/contest.json', document: doc })).status, 409);
  await mkdir(join(base, 'cf'));
  const cf = await request('/api/contests', { file: 'cf/contest.json', document: { ...doc,
    problems: [{ id: 'A', max_points: 1 }], judge: { kind: 'codeforces', contest_id: 4, handle: 'demo', languages: { cpp17: 54 } } } });
  assert.equal(cf.status, 201, cf.text);
  await assert.rejects(stat(join(base, 'cf/judge.json')), { code: 'ENOENT' });
  await symlink(tmpdir(), join(base, 'escape'));
  assert.equal((await request('/api/contests', { file: 'escape/contest.json', document: doc })).status, 400);
});
