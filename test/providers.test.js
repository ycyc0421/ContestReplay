import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStudio } from '../dist/studio.js';
import { Connections } from '../dist/connections.js';
import { makePlan, verifyJob, verifyPlan } from '../dist/plan.js';
import { loadAgent, modelKey } from '../dist/config.js';
import { credentialJson, redactCredentialStream } from '../dist/credential-redaction.js';

const secret = 'test-only-provider-key-initial';
const nextSecret = 'test-only-provider-key-rotated';
const endpoint = 'https://example.test/v1';
const image = async () => 'sha256:' + 'a'.repeat(64);
const publicKeys = ['id', 'label', 'protocol', 'base_url', 'credential_ref', 'approved_origin'];
function noSecrets(text) {
  for (const key of [secret, nextSecret]) assert.ok(!text.includes(key), 'Credential leaked');
}
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'cr-providers-'));
  const store = new Connections(join(base, '.providers'));
  const app = await startStudio(join(base, 'runs'), 0, { base, store, getImage: image });
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const request = async (path, method = 'GET', body, extra = {}) => {
    const response = await fetch(app.url + path, { method, headers: { Origin: app.url, 'Sec-Fetch-Site': 'same-origin', 'X-CR-Studio': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    noSecrets(text);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, value: JSON.parse(text) };
  };
  return { app, base, store, request };
}

test('Studio Provider REST supports write-only credential CRUD with public availability and legacy responses', async t => {
  // Exercise the file fallback predictably without touching the real desktop keyring.
  const previous = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  t.after(() => { if (previous === undefined) delete process.env.CR_CREDENTIAL_STORAGE; else process.env.CR_CREDENTIAL_STORAGE = previous; });
  const { request, store } = await fixture(t);
  const route = '/api/providers';
  const item = `${route}/demo`;
  const input = { id: 'demo', label: 'Provider Demo', protocol: 'responses', base_url: endpoint, secret };
  assert.deepEqual((await request(route)).value, { providers: [] });
  assert.equal((await request(route, 'POST', input, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await request(route, 'POST', input, { 'X-CR-Studio': '0' })).status, 403);
  assert.equal((await request(route, 'POST', { ...input, protocol: secret })).status, 400);
  assert.equal((await request(route, 'POST', { ...input, label: `public-${secret}` })).status, 400);
  assert.equal((await request('/api/connections', 'POST', input)).status, 404);
  const result = await request(route, 'POST', input);
  assert.equal(result.status, 201);
  const created = result.value;
  assert.deepEqual(Object.keys(created).sort(), [...publicKeys, 'backend', 'credential_available'].sort());
  assert.equal(created.approved_origin, 'https://example.test');
  assert.equal(created.backend, 'file');
  assert.equal(created.credential_available, true);
  const credential = join(store.root, 'credentials', created.credential_ref);
  assert.equal((await stat(credential)).mode & 0o777, 0o600);
  assert.equal(await readFile(credential, 'utf8'), secret);
  noSecrets(await readFile(join(store.root, 'connections', 'demo.json'), 'utf8'));
  assert.equal((await request(route, 'POST', { ...input, secret: nextSecret })).status, 409);
  assert.equal((await request(item, 'PATCH', { secret: nextSecret })).status, 400);
  assert.equal((await request(item, 'PATCH', { label: secret })).status, 400);
  assert.equal((await request(item, 'PATCH', { base_url: 'https://other.example/v2' })).status, 409);
  assert.equal((await request(item, 'PATCH', { base_url: 'https://example.test:444/v1' })).status, 409);
  assert.equal((await request(`${item}/rotate`, 'POST', { secret: nextSecret }, { 'X-CR-Studio': 'no' })).status, 403);
  assert.equal((await request(`${item}/rotate`, 'POST', { secret: nextSecret, label: 'unexpected' })).status, 400);
  assert.equal(await readFile(credential, 'utf8'), secret);
  const edited = await request(item, 'PATCH', { label: 'Edited', base_url: 'https://example.test/v2/' });
  assert.deepEqual(edited, { status: 200, value: { ...created, label: 'Edited', base_url: 'https://example.test/v2' } });
  const unavailable = async () => assert.equal((await request(route)).value.providers[0].credential_available, false);
  await chmod(credential, 0o644);
  await unavailable();
  await rm(credential);
  await unavailable();
  assert.equal((await request(`${item}/rotate`, 'POST', { secret: nextSecret })).status, 200);
  assert.equal(await readFile(credential, 'utf8'), nextSecret);
  assert.equal((await stat(credential)).mode & 0o777, 0o600);
  assert.deepEqual((await request(route)).value, { providers: [edited.value] });
  const legacy = await request('/api/connections/demo', 'PATCH', { label: 'Legacy' });
  assert.equal(legacy.status, 200);
  assert.deepEqual(Object.keys(legacy.value).sort(), publicKeys.sort());
  assert.deepEqual((await request('/api/connections')).value, { connections: [legacy.value] });
  assert.equal((await request(item, 'DELETE', undefined, { Origin: 'https://foreign.example' })).status, 403);
  assert.deepEqual(await request(item, 'DELETE'), { status: 200, value: { deleted: true } });
  await assert.rejects(stat(credential), { code: 'ENOENT' });
  assert.equal((await request(item, 'DELETE')).status, 404);
  assert.deepEqual((await request('/api/connections')).value, { connections: [] });
});

test('both Agent reference forms pin endpoints without pinning secret rotation; referenced Providers cannot be deleted', async t => {
  const { base, request, store } = await fixture(t);
  for (const id of ['demo', 'legacy']) assert.equal((await request('/api/providers', 'POST', { id, label: id,
    protocol: 'responses', base_url: endpoint, secret })).status, 201);
  const doc = { kind: 'contestreplay.dev/agent', schema_version: 1, id: 'provider-demo', model: 'gpt-5.3-codex', provider: 'demo',
    harness: { kind: 'codex', version: '0.170.0' } };
  const saved = await request('/api/agents', 'POST', { document: doc, format: 'json', file: 'agent.json' });
  assert.equal(saved.status, 201);
  noSecrets(await readFile(join(base, 'agent.json'), 'utf8'));
  const { provider: _provider, ...legacy } = doc;
  const other = { ...legacy, id: 'legacy-agent', connection: 'legacy' };
  // Also check manually written workspace manifests, without a registration marker.
  await writeFile(join(base, 'legacy.json'), JSON.stringify(other));
  for (const document of [doc, other]) {
    const preview = await request('/api/agents/preview', 'POST', { document });
    assert.equal(preview.status, 200);
    assert.match(preview.value.content, /http:\/\/127\.0\.0\.1:8745/);
  }
  const plan = await makePlan({ schema_version: 2, cells: [{ agent: 'agent.json', contest: resolve('examples/demo/contest.json') }] }, base, image, store);
  noSecrets(JSON.stringify(plan));
  assert.equal((await request('/api/providers/demo', 'DELETE')).status, 409);
  assert.equal((await request('/api/providers/legacy', 'DELETE')).status, 409);
  assert.equal((await request('/api/connections/demo', 'DELETE')).status, 409);
  assert.equal((await request('/api/providers/demo/rotate', 'POST', { secret: nextSecret })).status, 200);
  await verifyPlan(plan, true, store);
  assert.equal(await modelKey(await loadAgent(join(base, 'agent.json'), store), store), nextSecret);
  assert.equal((await request('/api/providers/demo', 'PATCH', { base_url: endpoint + '/different' })).status, 200);
  await assert.rejects(verifyJob(plan, plan.jobs[0], store), /regenerate the plan/);
  await assert.rejects(store.key('demo', { api: 'responses', base_url: endpoint }), /endpoint changed/);
  assert.equal((await request('/api/catalog/agents')).value.agents.length, 2);
});

test('credential redaction keeps JSON valid and handles split diagnostic writes', () => {
  const key = 'some-test-key-"escaped"';
  const result = credentialJson({ value: `Bearer ${key}` }, key);
  assert.deepEqual(JSON.parse(result), { value: 'Bearer [REDACTED]' });
  const chunks = [];
  const redactor = redactCredentialStream(key, bytes => chunks.push(bytes));
  redactor.push(Buffer.from('prefix ' + key.slice(0, 8)));
  redactor.push(Buffer.from(key.slice(8) + ' suffix'));
  redactor.end();
  assert.equal(Buffer.concat(chunks).toString(), 'prefix [REDACTED] suffix');
});
