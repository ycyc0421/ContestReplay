import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStudio } from '../dist/studio.js';
import { Connections } from '../dist/connections.js';
import { loadAgent } from '../dist/config.js';
import { makePlan } from '../dist/plan.js';

test('Provider-owned Agents appear in catalog and sparse cells produce only selected jobs', async t => {
  const base = await mkdtemp(join(tmpdir(), 'cr-catalog-'));
  await mkdir(join(base, 'demo'), { recursive: true });
  for (const file of ['contest.json', 'problems.pdf', 'judge.json']) await cp(resolve('examples/demo', file), join(base, 'demo', file));
  const store = new Connections(join(base, '.connections'));
  const previous = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  const image = async () => 'sha256:' + 'a'.repeat(64);
  const app = await startStudio(join(base, 'runs'), 0, { base, store, getImage: image });
  t.after(async () => {
    if (previous === undefined) delete process.env.CR_CREDENTIAL_STORAGE; else process.env.CR_CREDENTIAL_STORAGE = previous;
    await app.close(); await rm(base, { recursive: true, force: true });
  });
  await store.create({ id: 'demo', label: 'Demo', protocol: 'responses', base_url: 'https://api.openai.com/v1', secret: 'fixture-only' });
  const post = async (path, payload) => {
    const response = await fetch(app.url + path, { method: 'POST', headers: { Origin: app.url, 'X-CR-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, value: await response.json() };
  };
  const document = (id, model) => ({ kind: 'contestreplay.dev/agent', schema_version: 1, id, vendor: 'openai', model, provider: 'demo',
    harness: { kind: 'codex', version: '0.170.0', options: {} } });
  const first = await post('/api/agents', { document: document('managed-agent', 'gpt-5.3-codex') });
  assert.equal(first.status, 201, JSON.stringify(first.value));
  assert.match(first.value.path, /agents\/managed-agent\.toml$/);
  assert.equal((await loadAgent(first.value.path, store)).connection, 'demo');
  const second = await post('/api/agents', { document: document('second-agent', 'gpt-5.3-codex-mini') });
  assert.equal(second.status, 201, JSON.stringify(second.value));
  const catalog = await (await fetch(app.url + '/api/catalog/agents')).json();
  assert.deepEqual(catalog.agents.map(item => item.id).sort(), ['managed-agent', 'second-agent']);
  assert.ok(catalog.agents.every(item => item.valid && item.provider_available && item.provider === 'demo'));
  const contests = await (await fetch(app.url + '/api/catalog/contests')).json();
  const contest = contests.contests.find(item => item.id === 'cr-demo-final');
  assert.ok(contest?.valid);
  const matrix = await post('/api/matrix', { agents: [first.value.path, second.value.path], contests: [contest.path] });
  assert.equal(matrix.status, 200, JSON.stringify(matrix.value));
  assert.equal(matrix.value.cells.length, 2);
  const plan = await makePlan({ schema_version: 2, cells: [{ agent: second.value.path, contest: contest.path }] }, base, image, store);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].agent_id, 'second-agent');
  assert.equal(plan.jobs[0].contest_path, resolve(base, contest.path));
});
