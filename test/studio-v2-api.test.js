import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connections } from '../dist/connections.js';
import { OjAccounts } from '../dist/judges/index.js';
import { synthesizeTextContestPdf } from '../dist/pdf-synth.js';
import { makePlan, verifyPlan } from '../dist/plan.js';
import { loadStudioContest, readWorkspaceFileNoFollow } from '../dist/contest-author.js';
import { loadStudioAgent } from '../dist/studio-config-api.js';
import { PushDispatcher, PushTargets } from '../dist/push.js';
import { createSseWriter, startStudio } from '../dist/studio.js';
import {
  agentItemResponseSchema,
  contestItemResponseSchema,
  contestPreviewResponseSchema,
  coverageResponseSchema,
  ojAccountsResponseSchema,
  rankedResultsResponseSchema,
  runStatusEventSchema,
} from '../dist/studio-contract.js';

const FAKE_IMAGE = 'sha256:' + 'b'.repeat(64);
const getImage = async () => FAKE_IMAGE;

function makeRequester(baseUrl) {
  return async (path, opts = {}) => {
    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
    const headers = { ...(opts.headers ?? {}) };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (!opts.omitOrigin) headers['Origin'] = baseUrl;
      if (!opts.omitStudioHeader) headers['X-CR-Studio'] = '1';
    }
    let body;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, headers: response.headers, text, value };
  };
}

test('Studio v2 API: capabilities, OJ accounts CRUD + delete guard, push targets CRUD + test + deliveries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-studio-v2-a-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'workspace');
  const root = join(dir, 'runs');
  await mkdir(base, { recursive: true });
  await mkdir(root, { recursive: true });

  const store = new Connections(join(dir, 'connections'));
  const ojAccounts = new OjAccounts(join(dir, 'oj-accounts'));
  const pushTargets = new PushTargets(join(dir, 'push-targets'));
  const pushDispatcher = new PushDispatcher(pushTargets, { sleep: async () => {} });

  // Local webhook receiver for /api/push-targets/:id/test
  const pings = [];
  const webhookServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      pings.push({
        event: req.headers['x-cr-event'],
        signature: req.headers['x-cr-signature-256'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200).end('pong');
    });
  });
  await new Promise(r => webhookServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => webhookServer.close(() => r())));
  const webhookPort = webhookServer.address().port;

  const studio = await startStudio(root, 0, { base, store, ojAccounts, pushTargets, pushDispatcher, getImage });
  t.after(() => studio.close());
  const req = makeRequester(studio.url);

  // 1. Capabilities exposes all 5 judge backends + language presets + protocol presets + new features
  const caps = await req('/api/capabilities');
  assert.equal(caps.status, 200);
  const kinds = caps.value.judge_backends.map(b => b.kind);
  assert.deepEqual(kinds, ['local', 'codeforces', 'qoj', 'vjudge', 'hydro']);
  assert.ok(caps.value.judge_backends.find(b => b.kind === 'qoj').language_presets.length > 0);
  assert.deepEqual(caps.value.protocol_presets.map(p => p.id), ['short', 'cf-2h', 'icpc-5h']);
  assert.equal(caps.value.features.oj_accounts, true);
  assert.equal(caps.value.features.push_targets, true);
  assert.equal(caps.value.features.live_progress, true);
  assert.equal(caps.value.features.replay, true);
  assert.equal(caps.value.features.preflight_doctor, true);
  assert.equal(caps.value.features.variant_builder, true);
  assert.equal(caps.value.features.parallel_batches, true);

  // 2. OJ Accounts CRUD: write-only secrets never echoed, CSRF guard enforced, delete guard blocks referenced account
  const unauthOj = await req('/api/oj-accounts', {
    method: 'POST',
    omitStudioHeader: true,
    body: { id: 'cf-1', label: 'CF', platform: 'codeforces', handle: 'bot', transport: 'cookie', secret: 'JSESSIONID=secret-abc-123' },
  });
  assert.equal(unauthOj.status, 403);

  const secretCookie = 'JSESSIONID=super-secret-cookie-value-999';
  const createdOj = await req('/api/oj-accounts', {
    body: { id: 'cf-1', label: 'CF Bot 1', platform: 'codeforces', handle: 'cf_bot_1', pool: 'cf-main', transport: 'cookie', secret: secretCookie },
  });
  assert.equal(createdOj.status, 201, createdOj.text);
  assert.equal(createdOj.value.ready, true);
  assert.ok(!createdOj.text.includes(secretCookie), 'Secret must NEVER be echoed');

  const listedOj = await req('/api/oj-accounts');
  assert.equal(listedOj.status, 200);
  assert.equal(listedOj.value.accounts.length, 1);
  assert.ok(!listedOj.text.includes(secretCookie));

  const patchedOj = await req('/api/oj-accounts/cf-1', { method: 'PATCH', body: { label: 'CF Bot Updated' } });
  assert.equal(patchedOj.status, 200);
  assert.equal(patchedOj.value.label, 'CF Bot Updated');

  const rotatedCookie = 'JSESSIONID=rotated-secret-cookie-value-888';
  const rotatedOj = await req('/api/oj-accounts/cf-1/rotate', { body: { secret: rotatedCookie } });
  assert.equal(rotatedOj.status, 200);
  assert.ok(!rotatedOj.text.includes(rotatedCookie));

  // Create a workspace contest referencing account_id: 'cf-1' -> delete must return 409!
  const pdfPath = join(base, 'paper.pdf');
  await synthesizeTextContestPdf([{ id: 'A', title: 'Alpha', body: 'Solve A.' }], pdfPath);
  const savedCf = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'cf-ref-guard',
        data_version: 1,
        title: 'CF Ref Guard',
        source: { name: 'CF' },
        materials: { entrypoint: { kind: 'pdf', path: pdfPath } },
        problems: [{ id: 'A', max_points: 500 }],
        judge: { kind: 'codeforces', contest_id: 1900, gym: false, account_id: 'cf-1', languages: { cpp20: '89' } },
      },
    },
  });
  assert.equal(savedCf.status, 201, savedCf.text);
  assert.ok(savedCf.value.path.endsWith('contests/cf-ref-guard.json'));

  const blockedDelete = await req('/api/oj-accounts/cf-1', { method: 'DELETE' });
  assert.equal(blockedDelete.status, 409, 'Referenced OJ account must not be deleted');

  // Remove contest -> now OJ account delete succeeds
  const delContest = await req('/api/contests/item?path=contests/cf-ref-guard.json', { method: 'DELETE' });
  assert.equal(delContest.status, 200);
  const delOj = await req('/api/oj-accounts/cf-1', { method: 'DELETE' });
  assert.equal(delOj.status, 200);
  assert.equal(delOj.value.deleted, true);

  // 3. Push Targets CRUD + rotate + test ping + deliveries
  const pushSecret = 'hmac-secret-token-value-12345';
  const createdPush = await req('/api/push-targets', {
    body: {
      id: 'webhook-1',
      label: 'Local Receiver',
      url: `http://127.0.0.1:${webhookPort}/hook`,
      events: ['run.completed', 'batch.completed'],
      auth_mode: 'hmac-sha256',
      secret: pushSecret,
    },
  });
  assert.equal(createdPush.status, 201, createdPush.text);
  assert.ok(!createdPush.text.includes(pushSecret), 'Push secret must never be echoed');

  const patchedPush = await req('/api/push-targets/webhook-1', { method: 'PATCH', body: { label: 'Local Receiver v2' } });
  assert.equal(patchedPush.status, 200);
  assert.equal(patchedPush.value.label, 'Local Receiver v2');

  const rotatedPushSecret = 'hmac-rotated-secret-value-67890';
  const rotatedPush = await req('/api/push-targets/webhook-1/rotate', { body: { secret: rotatedPushSecret } });
  assert.equal(rotatedPush.status, 200);
  assert.ok(!rotatedPush.text.includes(rotatedPushSecret));

  const pingRes = await req('/api/push-targets/webhook-1/test', { method: 'POST', body: {} });
  assert.equal(pingRes.status, 200, pingRes.text);
  assert.equal(pingRes.value.status, 'delivered');
  assert.equal(pings.length, 1);
  assert.equal(pings[0].event, 'ping');
  assert.ok(pings[0].signature?.startsWith('sha256='));

  const deliveries = await req('/api/push-deliveries?limit=10&target_id=webhook-1');
  assert.equal(deliveries.status, 200);
  assert.equal(deliveries.value.deliveries.length, 1);
  assert.equal(deliveries.value.deliveries[0].event, 'ping');

  const delPush = await req('/api/push-targets/webhook-1', { method: 'DELETE' });
  assert.equal(delPush.status, 200);
  assert.equal((await req('/api/push-targets')).value.targets.length, 0);
});

test('Studio v2 API: Agent/Contest CRUD, clone, variants, materials cleanup, contest preview + problem_map, and Preflight Doctor', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-studio-v2-b-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'workspace');
  const root = join(dir, 'runs');
  await mkdir(base, { recursive: true });
  await mkdir(root, { recursive: true });

  const store = new Connections(join(dir, 'connections'));
  const ojAccounts = new OjAccounts(join(dir, 'oj-accounts'));

  await store.create({
    id: 'openai-dev',
    label: 'OpenAI Dev',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-studio-v2-secret-key',
  });
  await ojAccounts.create({
    id: 'qoj-main',
    label: 'QOJ Main',
    platform: 'qoj',
    handle: 'qoj_user',
    pool: 'qoj-default',
    transport: 'cookie',
    secret: 'UOJSESSID=qoj-cookie-secret',
  });

  const mockPreviewContest = async (platform, contestId) => ({
    platform,
    contest_ref: String(contestId),
    title: 'Mock QOJ Round 42',
    status: 'finished',
    problems: [
      { remote_id: 'A', title: 'Alpha', max_points: 100 },
      { remote_id: 'B', title: 'Beta', max_points: 100 },
    ],
    suggested_languages: [{ id: 'cpp20', label: 'C++20', remote_id: 'C++20', family: 'cpp' }],
  });

  const studio = await startStudio(root, 0, {
    base,
    store,
    ojAccounts,
    getImage,
    previewContest: mockPreviewContest,
  });
  t.after(() => studio.close());
  const req = makeRequester(studio.url);

  // 1. Agent create -> GET item -> PUT item -> clone -> variant matrix (dry_run + save) -> DELETE item
  const baseAgentDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'gpt-base',
    name: 'GPT Base',
    vendor: 'openai',
    model: 'gpt-5.4',
    provider: 'openai-dev',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium' } },
  };
  const savedAgent = await req('/api/agents', { body: { document: baseAgentDoc } });
  assert.equal(savedAgent.status, 201, savedAgent.text);

  const gotAgent = await req('/api/agents/item?path=agents/gpt-base.toml');
  assert.equal(gotAgent.status, 200);
  assert.equal(gotAgent.value.id, 'gpt-base');
  assert.equal(gotAgent.value.valid, true);
  assert.ok(!gotAgent.text.includes('sk-studio-v2-secret-key'));

  const updatedAgent = await req('/api/agents/item', {
    method: 'PUT',
    body: { path: 'agents/gpt-base.toml', document: { ...baseAgentDoc, name: 'GPT Base Edited' } },
  });
  assert.equal(updatedAgent.status, 200, updatedAgent.text);
  assert.equal((await req('/api/agents/item?path=agents/gpt-base.toml')).value.name, 'GPT Base Edited');

  const clonedAgent = await req('/api/agents/clone', {
    body: {
      source_path: 'agents/gpt-base.toml',
      id: 'gpt-high',
      name: 'GPT High',
      overrides: { speed_tier: 'fast', harness: { options: { reasoning_effort: 'high' } } },
    },
  });
  assert.equal(clonedAgent.status, 201, clonedAgent.text);
  assert.equal(clonedAgent.value.manifest.harness.options.reasoning_effort, 'high');
  assert.equal(clonedAgent.value.manifest.speed_tier, 'fast');

  // Variant matrix builder: dry_run preview then real batch save
  const dryVariants = await req('/api/agents/variants', {
    body: {
      base_document: { ...baseAgentDoc, id: 'sweep' },
      reasoning_efforts: ['low', 'high'],
      speed_tiers: ['standard', 'fast'],
      service_tiers: ['standard'],
      dry_run: true,
    },
  });
  assert.equal(dryVariants.status, 200, dryVariants.text);
  assert.equal(dryVariants.value.dry_run, true);
  assert.equal(dryVariants.value.variants.length, 4);

  const savedVariants = await req('/api/agents/variants', {
    body: {
      base_document: { ...baseAgentDoc, id: 'sweep' },
      reasoning_efforts: ['low', 'high'],
      speed_tiers: ['standard', 'fast'],
      dry_run: false,
    },
  });
  assert.equal(savedVariants.status, 201, savedVariants.text);
  assert.equal(savedVariants.value.variants.length, 4);
  for (const v of savedVariants.value.variants) {
    await stat(v.path);
  }

  // Symlink escape on GET / DELETE must be rejected
  await symlink(resolve('package.json'), join(base, 'escape.json'));
  assert.equal((await req('/api/agents/item?path=escape.json')).status, 400);
  assert.equal((await req('/api/agents/item?path=../package.json')).status, 400);
  assert.equal((await req('/api/agents/item?path=escape.json', { method: 'DELETE' })).status, 400);

  // Delete cloned agent cleanly
  assert.equal((await req('/api/agents/item?path=agents/gpt-high.toml', { method: 'DELETE' })).status, 200);

  // 2. Upload materials -> preview contest with PDF auto problem_map -> managed Contest save -> GET/PUT -> orphan cleanup
  const synthPdf = join(dir, 'round.pdf');
  await synthesizeTextContestPdf(
    [
      { id: '1', title: 'Alpha', body: 'First problem.' },
      { id: '2', title: 'Beta', body: 'Second problem.' },
    ],
    synthPdf,
  );
  const pdfBytes = await readFile(synthPdf);

  const uploadMat = async (contestId, filename, bytes, kind) => {
    const form = new FormData();
    form.append('contest_id', contestId);
    form.append('kind', kind);
    form.append('file', new Blob([bytes]), filename);
    const res = await fetch(`${studio.url}/api/contests/materials`, {
      method: 'POST',
      headers: { Origin: studio.url, 'X-CR-Studio': '1' },
      body: form,
    });
    return { status: res.status, value: await res.json() };
  };

  const matMain = await uploadMat('qoj-r42', 'round.pdf', pdfBytes, 'entrypoint');
  assert.equal(matMain.status, 201);
  const matOrphan = await uploadMat('orphan-round', 'unused.pdf', pdfBytes, 'entrypoint');
  assert.equal(matOrphan.status, 201);
  const matManualDel = await uploadMat('manual-del', 'temp.pdf', pdfBytes, 'entrypoint');
  assert.equal(matManualDel.status, 201);

  // Preview contest with uploaded PDF -> infers numeric_to_alpha problem_map (1->A, 2->B)
  const previewRes = await req('/api/contests/preview', {
    body: {
      platform: 'qoj',
      contest_id: 42,
      account_id: 'qoj-main',
      pdf_path: matMain.value.path,
    },
  });
  assert.equal(previewRes.status, 200, previewRes.text);
  assert.equal(previewRes.value.preview.title, 'Mock QOJ Round 42');
  assert.deepEqual(previewRes.value.problem_map_suggestion.problem_map, { '1': 'A', '2': 'B' });
  assert.ok(previewRes.value.language_presets.length > 0);

  // Managed save (no file field) -> saves to contests/qoj-r42.json
  const savedQoj = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'qoj-r42',
        data_version: 1,
        title: 'QOJ Round 42',
        source: { name: 'QOJ' },
        materials: { entrypoint: matMain.value },
        problems: [{ id: '1', max_points: 100 }, { id: '2', max_points: 100 }],
        judge: {
          kind: 'qoj',
          contest_id: 42,
          account_id: 'qoj-main',
          languages: { cpp20: 'C++20' },
          problem_map: { '1': 'A', '2': 'B' },
        },
      },
    },
  });
  assert.equal(savedQoj.status, 201, savedQoj.text);
  assert.ok(savedQoj.value.path.endsWith('contests/qoj-r42.json'));

  // Managed local contest save + GET item visibility gating + PUT update
  const matLocal = await uploadMat('local-r1', 'local.pdf', pdfBytes, 'entrypoint');
  const savedLocal = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'local-r1',
        data_version: 1,
        title: 'Local Round 1',
        source: { name: 'Local' },
        materials: { entrypoint: matLocal.value },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] },
      },
    },
  });
  assert.equal(savedLocal.status, 201, savedLocal.text);

  // Plain GET without X-CR-Studio / include_judge omits local accepted answers
  const plainGet = await req('/api/contests/item?path=contests/local-r1.json');
  assert.equal(plainGet.status, 200);
  assert.equal(plainGet.value.judge, undefined);

  // Studio GET with include_judge=1 returns judge answers for local editing
  const editGet = await req('/api/contests/item?path=contests/local-r1.json&include_judge=1');
  assert.equal(editGet.status, 200);
  assert.equal(editGet.value.judge.problems[0].accepted_answers[0], '42');

  // PUT updates local contest atomically
  const putLocal = await req('/api/contests/item', {
    method: 'PUT',
    body: {
      path: 'contests/local-r1.json',
      document: {
        schema_version: 2,
        contest_id: 'local-r1',
        data_version: 2,
        title: 'Local Round 1 Revised',
        source: { name: 'Local' },
        materials: { entrypoint: matLocal.value },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['99'] }] },
      },
    },
  });
  assert.equal(putLocal.status, 200, putLocal.text);
  assert.equal((await req('/api/contests/item?path=contests/local-r1.json&include_judge=1')).value.judge.problems[0].accepted_answers[0], '99');

  // Delete single material + cleanup orphans
  const delSingle = await req('/api/contests/materials', {
    method: 'DELETE',
    body: { path: matManualDel.value.path },
  });
  assert.equal(delSingle.status, 200, delSingle.text);
  assert.deepEqual(delSingle.value.deleted, [matManualDel.value.path]);

  const cleanOrphans = await req('/api/contests/materials', {
    method: 'DELETE',
    body: { cleanup_orphans: true },
  });
  assert.equal(cleanOrphans.status, 200, cleanOrphans.text);
  assert.deepEqual(cleanOrphans.value.deleted, [matOrphan.value.path]);

  // 3. Preflight Doctor: passes for valid Codex + QOJ cell
  const preflightOk = await req('/api/preflight', {
    body: { cells: [{ agent: 'agents/gpt-base.toml', contest: 'contests/qoj-r42.json' }] },
  });
  assert.equal(preflightOk.status, 200, preflightOk.text);
  assert.equal(preflightOk.value.ok, true);
  assert.equal(preflightOk.value.images[0].ok, true);
  assert.equal(preflightOk.value.agents[0].credential_ok, true);
  assert.equal(preflightOk.value.contests[0].oj_ready, true);
  assert.equal(preflightOk.value.contests[0].pdf.ok, true);
  assert.equal(preflightOk.value.compatibility[0].compatible, true);

  // Preflight Doctor detects builtin-responses incompatibility with QOJ contest
  const builtinDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'builtin-1',
    model: 'gpt-4.1-2025-04-14',
    provider: 'openai-dev',
    harness: { kind: 'builtin-responses', version: '0.1.0', options: { temperature: 0 } },
  };
  assert.equal((await req('/api/agents', { body: { document: builtinDoc } })).status, 201);
  const preflightBad = await req('/api/preflight', {
    body: { cells: [{ agent: 'agents/builtin-1.toml', contest: 'contests/qoj-r42.json' }] },
  });
  assert.equal(preflightBad.status, 200);
  assert.equal(preflightBad.value.ok, false);
  assert.equal(preflightBad.value.compatibility[0].compatible, false);
});

test('Studio v2 API: live progress, SSE stream, sliced logs, replay, ghost race, coverage, and Policy C ranked results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-studio-v2-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'workspace');
  const root = join(dir, 'runs');
  await mkdir(base, { recursive: true });
  await mkdir(root, { recursive: true });

  const store = new Connections(join(dir, 'connections'));
  await store.create({
    id: 'openai-live',
    label: 'OpenAI Live',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-live-secret-token',
  });

  // Create two variants of the same model (Policy C grouping) + a contest
  const makeAgent = async (id, effort) => {
    const file = join(base, `${id}.toml`);
    await writeFile(
      file,
      [
        'kind = "contestreplay.dev/agent"',
        'schema_version = 1',
        `id = "${id}"`,
        `name = "${id} display"`,
        'vendor = "openai"',
        'model = "gpt-5.4"',
        'provider = "openai-live"',
        '',
        '[harness]',
        'kind = "codex"',
        'version = "0.170.0"',
        '',
        '[harness.options]',
        `reasoning_effort = "${effort}"`,
        '',
      ].join('\n'),
    );
    return file;
  };
  const agentLow = await makeAgent('gpt-low', 'low');
  const agentHigh = await makeAgent('gpt-high', 'high');
  // Studio admission deliberately requires contest manifests and artifacts inside its workspace.
  const contestFile = join(base, 'contest.json');
  for (const name of ['contest.json', 'judge.json', 'problems.pdf']) {
    await writeFile(join(base, name), await readFile(resolve('examples/demo', name)));
  }

  // Gate run completion so we can inspect live_summary, /progress, and SSE /events mid-run!
  let releaseRuns;
  const runGate = new Promise(r => { releaseRuns = r; });
  const runDirs = new Map();
  let startedCount = 0;
  let allStarted;
  const bothStarted = new Promise(r => { allStarted = r; });

  const studio = await startStudio(root, 0, {
    base,
    store,
    getImage,
    ssePollMs: 60,
    queue: {
      preflight: async () => {},
      execute: async (_plan, job, opts) => {
        const runDir = join(opts.out, opts.runId);
        await mkdir(join(runDir, 'session'), { recursive: true, mode: 0o700 });
        const contestRevision = 'c'.repeat(64);
        const protocolSha = 'd'.repeat(64);
        await writeFile(
          join(runDir, 'run.json'),
          JSON.stringify({
            schema_version: 1,
            run_id: opts.runId,
            created_at: new Date().toISOString(),
            contest_id: job.contest_id,
            contest_title: 'Demo Contest',
            data_version: job.data_version,
            contest_revision: contestRevision,
            input_sha256: { contest: contestRevision },
            problems: [{ id: '1', max_points: 1 }, { id: '2', max_points: 2 }],
            protocol_id: 'codex-pdf-pages-mcp',
            protocol_version: 2,
            protocol_sha256: protocolSha,
            scoring_mode: 'last_ac',
            rules: { time_limit_ms: 900_000, max_submissions: 50, scoring_mode: 'last_ac' },
            agent_id: job.agent_id,
            agent_name: job.agent_name,
            agent_revision: job.agent_revision,
            harness: { kind: job.harness, version: '0.170.0' },
            model: {
              model: 'gpt-5.4',
              vendor: 'openai',
              reasoning_effort: job.agent_id === 'gpt-high' ? 'high' : 'low',
              speed_tier: 'standard',
            },
          }),
        );
        await writeFile(join(runDir, 'agent.stdout.log'), 'hello world stdout');
        await writeFile(join(runDir, 'agent.stderr.log'), 'warn stderr');
        await writeFile(join(runDir, 'session', 'trace.jsonl'), JSON.stringify({ role: 'assistant', text: 'Solving problem 1' }) + '\n');
        await writeFile(
          join(runDir, 'events.jsonl'),
          [
            JSON.stringify({ schema_version: 1, seq: 1, elapsed_ms: 0, type: 'run_started', started_at: new Date().toISOString() }),
            JSON.stringify({ schema_version: 1, seq: 2, elapsed_ms: 1000, type: 'submission_received', submission_id: 's1', problem_id: '1', language: 'cpp20', source: 'int main(){return 0;}' }),
            JSON.stringify({ schema_version: 1, seq: 3, elapsed_ms: 1500, type: 'submission_judged', submission_id: 's1', problem_id: '1', verdict: 'accepted', score: 1, max_points: 1 }),
          ].join('\n') + '\n',
        );
        runDirs.set(job.agent_id, { runId: opts.runId, runDir });
        if (++startedCount === 2) allStarted();

        await runGate;

        const isHigh = job.agent_id === 'gpt-high';
        if (isHigh) {
          await appendFile(
            join(runDir, 'events.jsonl'),
            [
              JSON.stringify({ schema_version: 1, seq: 4, elapsed_ms: 2000, type: 'submission_received', submission_id: 's2', problem_id: '2', language: 'cpp20', source: 'int main(){return 2;}' }),
              JSON.stringify({ schema_version: 1, seq: 5, elapsed_ms: 2500, type: 'submission_judged', submission_id: 's2', problem_id: '2', verdict: 'accepted', score: 2, max_points: 2 }),
              JSON.stringify({ schema_version: 1, seq: 6, elapsed_ms: 3000, type: 'run_ended', status: 'completed', reason: 'finish', score: 3, max_score: 3 }),
            ].join('\n') + '\n',
          );
        } else {
          await appendFile(
            join(runDir, 'events.jsonl'),
            JSON.stringify({ schema_version: 1, seq: 4, elapsed_ms: 3500, type: 'run_ended', status: 'completed', reason: 'finish', score: 1, max_score: 3 }) + '\n',
          );
        }
        return { runId: opts.runId, directory: runDir, status: 'completed', reason: 'finish' };
      },
    },
  });
  t.after(() => studio.close());
  const req = makeRequester(studio.url);

  // Plan & launch batch with concurrency: 2
  const planRes = await req('/api/plan', {
    body: {
      schema_version: 2,
      cells: [
        { agent: agentLow, contest: contestFile },
        { agent: agentHigh, contest: contestFile },
      ],
    },
  });
  assert.equal(planRes.status, 200, planRes.text);
  const startRes = await req('/api/batches', { body: { token: planRes.value.token, concurrency: 2 } });
  assert.equal(startRes.status, 202, startRes.text);

  await bothStarted;
  const highRunId = runDirs.get('gpt-high').runId;
  const lowRunId = runDirs.get('gpt-low').runId;

  // 1. GET /api/batches exposes live_summary on running jobs + concurrency
  const liveBatches = await req('/api/batches');
  assert.equal(liveBatches.status, 200);
  assert.equal(liveBatches.value.batches[0].concurrency, 2);
  const runningHigh = liveBatches.value.batches[0].jobs.find(j => j.run_id === highRunId);
  assert.equal(runningHigh.status, 'running');
  assert.equal(runningHigh.live_summary.active, true);
  assert.equal(runningHigh.live_summary.solved_count, 1);

  // 2. GET /api/runs/:runId/progress
  const liveProgress = await req(`/api/runs/${highRunId}/progress`);
  assert.equal(liveProgress.status, 200);
  assert.equal(liveProgress.value.status, 'running');
  assert.equal(liveProgress.value.solved_count, 1);

  // 3. GET /api/runs/:runId/logs: both backward-compatible full logs AND incremental sliced logs
  const fullLogs = await req(`/api/runs/${highRunId}/logs`);
  assert.equal(fullLogs.status, 200);
  assert.equal(fullLogs.value.stdout, 'hello world stdout');
  assert.equal(fullLogs.value.stderr, 'warn stderr');

  const slice1 = await req(`/api/runs/${highRunId}/logs?stream=stdout&offset=0&limit=5`);
  assert.equal(slice1.status, 200);
  assert.equal(slice1.value.chunk, 'hello');
  assert.equal(slice1.value.next_offset, 5);
  assert.equal(slice1.value.has_more, true);

  const slice2 = await req(`/api/runs/${highRunId}/logs?stream=stdout&offset=5&limit=64`);
  assert.equal(slice2.status, 200);
  assert.equal(slice2.value.chunk, ' world stdout');
  assert.equal(slice2.value.has_more, false);

  // 4. GET /api/runs/:runId/events: real SSE stream receives live progress, then terminal progress and closes cleanly
  const sseResponse = await fetch(`${studio.url}/api/runs/${highRunId}/events`);
  assert.equal(sseResponse.status, 200);
  assert.ok(sseResponse.headers.get('content-type')?.includes('text/event-stream'));

  const sseEvents = [];
  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let released = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    let sepIdx;
    while ((sepIdx = sseBuffer.indexOf('\n\n')) !== -1) {
      const frame = sseBuffer.slice(0, sepIdx);
      sseBuffer = sseBuffer.slice(sepIdx + 2);
      const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
      if (dataLine) {
        const parsed = JSON.parse(dataLine.slice(6));
        sseEvents.push(parsed);
        if (!released && parsed.status === 'running') {
          released = true;
          releaseRuns();
        }
      }
    }
  }
  assert.ok(sseEvents.length >= 2, 'SSE should emit initial running snapshot and terminal completed snapshot');
  assert.equal(sseEvents[0].status, 'running');
  assert.equal(sseEvents.at(-1).status, 'completed');
  assert.equal(sseEvents.at(-1).score, 3);

  // Wait until studio batch worker finishes persisting terminal batch state
  for (let i = 0; i < 40; i++) {
    const state = await req('/api/batches');
    if (!state.value.busy) break;
    await new Promise(r => setTimeout(r, 30));
  }

  // 5. GET /api/runs/:runId/replay
  const replay = await req(`/api/runs/${highRunId}/replay?include_sources=1&include_session=1`);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.value.status, 'completed');
  assert.ok(replay.value.frames.some(f => f.kind === 'submission_received' && f.source?.includes('return 2')));
  assert.ok(replay.value.session_summaries?.length === 1);

  // 6. POST /api/runs/race (Ghost Race)
  const race = await req('/api/runs/race', {
    body: { run_ids: [highRunId, lowRunId], scoring_mode: 'last_ac', sample_step_ms: 1000 },
  });
  assert.equal(race.status, 200, race.text);
  assert.equal(race.value.participants.length, 2);
  assert.ok(race.value.samples.length > 0);
  const finalStandings = race.value.samples.at(-1).standings;
  assert.equal(finalStandings[0].run_id, highRunId);
  assert.equal(finalStandings[0].rank, 1);
  assert.equal(finalStandings[1].run_id, lowRunId);
  assert.equal(finalStandings[1].rank, 2);

  // 7. GET /api/coverage
  const coverage = await req('/api/coverage');
  assert.equal(coverage.status, 200, coverage.text);
  assert.equal(coverage.value.cells.length, 2);
  const highCov = coverage.value.cells.find(c => c.agent_id === 'gpt-high');
  assert.equal(highCov.completed_count, 1);
  assert.equal(highCov.best_score, 3);
  assert.equal(highCov.max_score, 3);

  // 8. GET /api/results/ranked (revision vs Policy C model grouping)
  const rankedByRevision = await req('/api/results/ranked?group_by=revision&scoring=last_ac');
  assert.equal(rankedByRevision.status, 200, rankedByRevision.text);
  assert.equal(rankedByRevision.value.groups.length, 1);
  assert.equal(rankedByRevision.value.groups[0].length, 2);
  assert.equal(rankedByRevision.value.groups[0][0].result.agent_id, 'gpt-high');

  const rankedByModel = await req('/api/results/ranked?group_by=model&scoring=last_ac');
  assert.equal(rankedByModel.status, 200, rankedByModel.text);
  assert.equal(rankedByModel.value.group_by, 'model');
  assert.equal(rankedByModel.value.groups.length, 1);
  assert.equal(rankedByModel.value.groups[0].length, 1, 'Policy C groups both gpt-5.4 variants into 1 model row');
  assert.equal(rankedByModel.value.groups[0][0].result.agent_id, 'gpt-high', 'Primary row must be the highest-scoring variant');
  assert.equal(rankedByModel.value.groups[0][0].variants.length, 2, 'Variants array retains both reasoning_effort variants');
  assert.deepEqual(rankedByModel.value.omitted_runs, []);
  rankedResultsResponseSchema.parse(rankedByModel.value);
});

test('Studio v2 security & CRUD regressions: document identity, root exclusion, relative paths, provider ref cleanup, artifact confinement, immutable answers, materials safety, variant dir confinement, preview redaction, OJ guards, empty preflight', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-studio-v2-sec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'workspace');
  // Deliberately nest custom run root INSIDE base to verify custom root exclusion!
  const root = join(base, 'custom-runs');
  await mkdir(join(base, 'agents'), { recursive: true });
  await mkdir(join(base, 'contests'), { recursive: true });
  await mkdir(join(root, 'agents'), { recursive: true });
  await mkdir(join(root, 'contests'), { recursive: true });

  const store = new Connections(join(dir, 'connections'));
  const ojAccounts = new OjAccounts(join(dir, 'oj-accounts'));

  await store.create({
    id: 'prov-a',
    label: 'Provider A',
    protocol: 'responses',
    base_url: 'https://api.example.com/v1',
    secret: 'sk-provider-a-secret-1234',
  });
  await store.create({
    id: 'prov-b',
    label: 'Provider B',
    protocol: 'responses',
    base_url: 'https://api.example.com/v1',
    secret: 'sk-provider-b-secret-5678',
  });

  // Preview mock that reflects cookie secrets in fields AND throws secret on contest_id === 999
  let previewMode = 'reflect';
  const mockPreviewContest = async (platform, contestId, opts) => {
    const reflected = opts?.cookie ?? 'no-cookie';
    if (previewMode === 'throw') {
      throw new Error(`Upstream 403 rejecting cookie=${reflected}`);
    }
    return {
      platform,
      contest_ref: `${platform}:${contestId}`,
      title: `Round ${contestId} (${reflected})`,
      status: 'finished',
      problems: [{ remote_id: 'A', title: `Secret ${reflected}`, max_points: 100 }],
      suggested_languages: [],
    };
  };

  const studio = await startStudio(root, 0, {
    base,
    store,
    ojAccounts,
    getImage,
    previewContest: mockPreviewContest,
  });
  t.after(() => studio.close());
  const req = makeRequester(studio.url);

  // 1. Document identity & custom root exclusion on GET/PUT/DELETE /api/{agents,contests}/item
  await writeFile(join(base, 'package.json'), JSON.stringify({ name: 'not-a-manifest', version: '1.0.0' }));
  await writeFile(join(base, 'secret.judge.json'), JSON.stringify({ schema_version: 1, problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] }));
  await writeFile(join(base, 'run.json'), JSON.stringify({ run_id: randomUUID(), contest_id: 'x', agent_id: 'a' }));

  const validAgentDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'agent-a',
    name: 'Agent A',
    model: 'gpt-5.4',
    provider: 'prov-a',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium' } },
  };
  await writeFile(join(root, 'agents', 'inside-root.json'), JSON.stringify(validAgentDoc));
  const pdfInBase = join(base, 'paper.pdf');
  await synthesizeTextContestPdf([{ id: '1', title: 'One', body: 'Solve 1.' }], pdfInBase);
  await writeFile(
    join(root, 'contests', 'inside-root.json'),
    JSON.stringify({
      schema_version: 2,
      contest_id: 'inside-root',
      data_version: 1,
      title: 'Inside Root',
      source: { name: 'Local' },
      materials: { entrypoint: { kind: 'pdf', path: pdfInBase } },
      problems: [{ id: '1', max_points: 1 }],
      judge: { kind: 'local', answers: { path: join(base, 'secret.judge.json') } },
    }),
  );

  for (const badPath of ['package.json', 'secret.judge.json', 'run.json', 'custom-runs/agents/inside-root.json']) {
    assert.equal((await req(`/api/agents/item?path=${encodeURIComponent(badPath)}`)).status, 400, `GET agent must reject ${badPath}`);
    assert.equal(
      (await req('/api/agents/item', { method: 'PUT', body: { path: badPath, document: validAgentDoc } })).status,
      400,
      `PUT agent must reject ${badPath}`,
    );
    assert.equal((await req(`/api/agents/item?path=${encodeURIComponent(badPath)}`, { method: 'DELETE' })).status, 400, `DELETE agent must reject ${badPath}`);
  }
  for (const badPath of ['package.json', 'secret.judge.json', 'run.json', 'custom-runs/contests/inside-root.json']) {
    assert.equal((await req(`/api/contests/item?path=${encodeURIComponent(badPath)}`)).status, 400, `GET contest must reject ${badPath}`);
    assert.equal((await req(`/api/contests/item?path=${encodeURIComponent(badPath)}`, { method: 'DELETE' })).status, 400, `DELETE contest must reject ${badPath}`);
  }

  // 2. PUT /api/agents/item returns workspace-relative path & retires old provider refs; DELETE unregisters refs
  const createdA = await req('/api/agents', { body: { document: validAgentDoc } });
  assert.equal(createdA.status, 201, createdA.text);

  // Provider A is referenced -> cannot delete
  assert.equal((await req('/api/providers/prov-a', { method: 'DELETE' })).status, 409);

  // Switch agent from prov-a -> prov-b via PUT /api/agents/item
  const putA = await req('/api/agents/item', {
    method: 'PUT',
    body: { path: 'agents/agent-a.toml', document: { ...validAgentDoc, provider: 'prov-b' } },
  });
  assert.equal(putA.status, 200, putA.text);
  assert.equal(putA.value.path, 'agents/agent-a.toml', 'PUT /api/agents/item must return workspace-relative path');
  assert.ok(!putA.value.path.startsWith('/'), 'PUT /api/agents/item path must not be absolute');

  // Now prov-a can be deleted while prov-b is protected
  assert.equal((await req('/api/providers/prov-a', { method: 'DELETE' })).status, 200);
  assert.equal((await req('/api/providers/prov-b', { method: 'DELETE' })).status, 409);

  // Verify GET item validates against studio-contract schema
  const getA = await req('/api/agents/item?path=agents/agent-a.toml');
  assert.equal(getA.status, 200);
  agentItemResponseSchema.parse(getA.value);

  // Delete agent -> prov-b ref is unregistered -> prov-b can now be deleted
  assert.equal((await req('/api/agents/item?path=agents/agent-a.toml', { method: 'DELETE' })).status, 200);
  assert.equal((await req('/api/providers/prov-b', { method: 'DELETE' })).status, 200);

  // 3. Variant directory confinement BEFORE mkdir (never creates out-of-workspace/hidden/root/symlink dirs)
  await store.create({
    id: 'prov-v',
    label: 'Provider V',
    protocol: 'responses',
    base_url: 'https://api.example.com/v1',
    secret: 'sk-provider-v-secret-9999',
  });
  const variantBaseDoc = { ...validAgentDoc, id: 'varbase', provider: 'prov-v' };
  const outsideDir = join(dir, 'escaped-variants');
  const hiddenDir = join(base, '.hidden-variants');
  const insideRootDir = join(root, 'sub-variants');
  await symlink(dir, join(base, 'sym-variants'));

  for (const [badDir, checkPath] of [
    ['../escaped-variants', outsideDir],
    ['.hidden-variants', hiddenDir],
    ['custom-runs/sub-variants', insideRootDir],
    ['sym-variants/nested', join(dir, 'nested')],
  ]) {
    const res = await req('/api/agents/variants', {
      body: { base_document: variantBaseDoc, reasoning_efforts: ['low'], directory: badDir, dry_run: false },
    });
    assert.equal(res.status, 400, `Variant directory ${badDir} must be rejected`);
    await assert.rejects(stat(checkPath), /ENOENT/, `Directory ${badDir} must NOT be created before validation`);
  }

  // 4. Contest artifact confinement (external symlinked attachment & *.judge.json attachment rejected) + atomic immutable local PUT
  const outsideSecret = join(dir, 'host-secret.txt');
  await writeFile(outsideSecret, 'TOP_SECRET_HOST_FILE');
  await symlink(outsideSecret, join(base, 'link-att.txt'));

  const badSymContest = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'bad-att-sym',
        data_version: 1,
        title: 'Bad Sym',
        source: { name: 'Local' },
        materials: {
          entrypoint: { kind: 'pdf', path: pdfInBase },
          attachments: [{ name: 'leak.txt', path: join(base, 'link-att.txt') }],
        },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] },
      },
    },
  });
  assert.equal(badSymContest.status, 400, 'External symlink attachment must be rejected');

  const badJudgeAttContest = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'bad-att-judge',
        data_version: 1,
        title: 'Bad Judge Att',
        source: { name: 'Local' },
        materials: {
          entrypoint: { kind: 'pdf', path: pdfInBase },
          attachments: [{ name: 'answers.json', path: join(base, 'secret.judge.json') }],
        },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] },
      },
    },
  });
  assert.equal(badJudgeAttContest.status, 400, '*.judge.json attachment must be rejected');

  // Create valid local contest -> failed PUT preserves old manifest & answers -> valid PUT publishes new immutable answer file
  const goodLocal = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'atomic-local',
        data_version: 1,
        title: 'Atomic Local v1',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: pdfInBase } },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] },
      },
    },
  });
  assert.equal(goodLocal.status, 201, goodLocal.text);
  const v1ContestGet = await req('/api/contests/item?path=contests/atomic-local.json&include_judge=1');
  assert.equal(v1ContestGet.status, 200);
  contestItemResponseSchema.parse(v1ContestGet.value);
  const v1JudgeRel = v1ContestGet.value.document.judge.answers.path;
  const v1JudgeFull = join(base, 'contests', v1JudgeRel);

  // Failing PUT (invalid PDF path) must leave old manifest and answers untouched
  const failedPut = await req('/api/contests/item', {
    method: 'PUT',
    body: {
      path: 'contests/atomic-local.json',
      document: {
        schema_version: 2,
        contest_id: 'atomic-local',
        data_version: 2,
        title: 'Broken v2',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: join(base, 'missing.pdf') } },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['99'] }] },
      },
    },
  });
  assert.equal(failedPut.status, 404);
  const stillV1 = await req('/api/contests/item?path=contests/atomic-local.json&include_judge=1');
  assert.equal(stillV1.value.document.title, 'Atomic Local v1');
  assert.equal(stillV1.value.judge.problems[0].accepted_answers[0], '42');

  // Valid PUT creates a NEW immutable judge file and preserves the old v1 judge file on disk
  const goodPut = await req('/api/contests/item', {
    method: 'PUT',
    body: {
      path: 'contests/atomic-local.json',
      document: {
        schema_version: 2,
        contest_id: 'atomic-local',
        data_version: 2,
        title: 'Atomic Local v2',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: pdfInBase } },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['99'] }] },
      },
    },
  });
  assert.equal(goodPut.status, 200, goodPut.text);
  assert.equal(goodPut.value.path, 'contests/atomic-local.json', 'PUT /api/contests/item must return relative path');
  assert.ok(!goodPut.value.path.startsWith('/'));
  const v2ContestGet = await req('/api/contests/item?path=contests/atomic-local.json&include_judge=1');
  assert.notEqual(v2ContestGet.value.document.judge.answers.path, v1JudgeRel, 'Updated answers must use a new immutable filename');
  const oldJudgeDisk = JSON.parse(await readFile(v1JudgeFull, 'utf8'));
  assert.equal(oldJudgeDisk.problems[0].accepted_answers[0], '42', 'Old immutable answer file must remain intact');

  // 5. Materials direct delete & orphan cleanup safety (v1 + v2 refs, scan failure aborts with 0 deletions, symlinked .materials rejected)
  const pdfBytes = await readFile(pdfInBase);
  const uploadMat = async (contestId, filename, bytes, kind) => {
    const form = new FormData();
    form.append('contest_id', contestId);
    form.append('kind', kind);
    form.append('file', new Blob([bytes]), filename);
    const res = await fetch(`${studio.url}/api/contests/materials`, {
      method: 'POST',
      headers: { Origin: studio.url, 'X-CR-Studio': '1' },
      body: form,
    });
    return { status: res.status, value: await res.json() };
  };
  const matV1 = await uploadMat('mat-v1', 'v1.pdf', pdfBytes, 'entrypoint');
  const matV2Ep = await uploadMat('mat-v2', 'v2.pdf', pdfBytes, 'entrypoint');
  const matV2Att = await uploadMat('mat-v2', 'notes.txt', Buffer.from('attachment data'), 'attachment');
  const matOrphan = await uploadMat('mat-orphan', 'orphan.pdf', pdfBytes, 'entrypoint');
  assert.equal(matV1.status, 201);
  assert.equal(matV2Ep.status, 201);
  assert.equal(matV2Att.status, 201);
  assert.equal(matOrphan.status, 201);

  // Create v1 manifest referencing matV1 via statement.path
  await writeFile(
    join(base, 'contests', 'legacy-v1.json'),
    JSON.stringify({
      schema_version: 1,
      contest_id: 'mat-v1',
      data_version: 1,
      title: 'Legacy v1',
      statement: { path: matV1.value.path },
      problems: [{ id: '1', max_points: 1 }],
      judge: { kind: 'local', answers: { path: '../secret.judge.json' } },
    }),
  );
  // Create v2 manifest referencing matV2Ep + matV2Att
  const savedV2Mat = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'mat-v2',
        data_version: 1,
        title: 'Managed v2',
        source: { name: 'Local' },
        materials: {
          entrypoint: matV2Ep.value,
          attachments: [{ name: 'notes.txt', path: matV2Att.value.path }],
        },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] },
      },
    },
  });
  assert.equal(savedV2Mat.status, 201, savedV2Mat.text);

  // Direct delete must refuse ALL referenced materials (v1 entrypoint, v2 entrypoint, v2 attachment) with 409
  for (const ref of [matV1.value.path, matV2Ep.value.path, matV2Att.value.path]) {
    const blocked = await req('/api/contests/materials', { method: 'DELETE', body: { path: ref } });
    assert.equal(blocked.status, 409, `Direct delete must refuse referenced material ${ref}`);
  }

  // Corrupt JSON in workspace -> orphan cleanup MUST abort (409) with 0 deletions!
  const corruptJsonPath = join(base, 'contests', 'corrupt.json');
  await writeFile(corruptJsonPath, '{broken json');
  const abortedCleanup = await req('/api/contests/materials', { method: 'DELETE', body: { cleanup_orphans: true } });
  assert.equal(abortedCleanup.status, 409, 'Orphan cleanup must abort on JSON scan failure');
  await stat(join(root, '.materials', 'mat-orphan', 'entrypoint', matOrphan.value.path.split('/').at(-1)));
  await rm(corruptJsonPath);

  // Now orphan cleanup succeeds, deletes ONLY matOrphan, keeps v1/v2 materials intact
  const okCleanup = await req('/api/contests/materials', { method: 'DELETE', body: { cleanup_orphans: true } });
  assert.equal(okCleanup.status, 200, okCleanup.text);
  assert.deepEqual(okCleanup.value.deleted, [matOrphan.value.path]);

  // 6. OJ Account delete guard across pool, handle, and active/queued batch jobs + preview secret redaction
  const secretCookie = 'SID=super-secret-token-xyz-77777; csrf=another-secret-88888';
  await req('/api/oj-accounts', {
    body: { id: 'qoj-p1', label: 'QOJ Pool 1', platform: 'qoj', handle: 'qoj_h1', pool: 'shared', transport: 'cookie', secret: secretCookie },
  });
  await req('/api/oj-accounts', {
    body: { id: 'qoj-p2', label: 'QOJ Pool 2', platform: 'qoj', handle: 'qoj_h2', pool: 'shared', transport: 'cookie', secret: 'SID=pool2-secret-value-11111' },
  });
  await req('/api/oj-accounts', {
    body: { id: 'cf-h1', label: 'CF Handle', platform: 'codeforces', handle: 'cf_special_handle', pool: 'default', transport: 'cookie', secret: 'JSESSIONID=cf-handle-secret-22222' },
  });
  ojAccountsResponseSchema.parse((await req('/api/oj-accounts')).value);

  // Preview secret reflection redaction (both response fields AND thrown error messages!)
  previewMode = 'reflect';
  const prevOk = await req('/api/contests/preview', {
    body: { platform: 'qoj', contest_id: 42, account_id: 'qoj-p1' },
  });
  assert.equal(prevOk.status, 200, prevOk.text);
  assert.ok(!prevOk.text.includes('super-secret-token-xyz-77777'), 'Preview response must redact cookie secret');
  assert.ok(!prevOk.text.includes('another-secret-88888'), 'Preview response must redact cookie components');
  assert.ok(prevOk.value.preview.title.includes('[REDACTED]'));
  contestPreviewResponseSchema.parse(prevOk.value);

  previewMode = 'throw';
  const prevErr = await req('/api/contests/preview', {
    body: { platform: 'qoj', contest_id: 999, account_id: 'qoj-p1' },
  });
  assert.equal(prevErr.status, 400);
  assert.ok(!prevErr.text.includes('super-secret-token-xyz-77777'), 'Preview error must never leak cookie secret');
  assert.ok(!prevErr.text.includes('another-secret-88888'), 'Preview error must never leak cookie components');
  assert.equal(prevErr.value.error, 'Contest preview failed; verify the contest reference and OJ account credentials');

  // Contest referencing pool: 'shared' -> deleting 1st succeeds (2nd remains), deleting 2nd (last) returns 409!
  const poolContest = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'qoj-pool-ref',
        data_version: 1,
        title: 'QOJ Pool Ref',
        source: { name: 'QOJ' },
        materials: { entrypoint: { kind: 'pdf', path: pdfInBase } },
        problems: [{ id: 'A', max_points: 100 }],
        judge: { kind: 'qoj', contest_id: 42, pool: 'shared', languages: { cpp20: 'C++20' } },
      },
    },
  });
  assert.equal(poolContest.status, 201, poolContest.text);
  assert.equal((await req('/api/oj-accounts/qoj-p1', { method: 'DELETE' })).status, 200, 'Deleting 1 of 2 ready pool accounts is allowed');
  assert.equal((await req('/api/oj-accounts/qoj-p2', { method: 'DELETE' })).status, 409, 'Deleting last ready account in referenced pool must be blocked');

  // Contest referencing handle without account_id -> blocks deleting matching handle account!
  const handleContest = await req('/api/contests', {
    body: {
      document: {
        schema_version: 2,
        contest_id: 'cf-handle-ref',
        data_version: 1,
        title: 'CF Handle Ref',
        source: { name: 'CF' },
        materials: { entrypoint: { kind: 'pdf', path: pdfInBase } },
        problems: [{ id: 'A', max_points: 500 }],
        judge: { kind: 'codeforces', contest_id: 1900, gym: false, handle: 'cf_special_handle', languages: { cpp20: '89' } },
      },
    },
  });
  assert.equal(handleContest.status, 201, handleContest.text);
  assert.equal((await req('/api/oj-accounts/cf-h1', { method: 'DELETE' })).status, 409, 'Contest referencing handle must block account delete');

  // Remove handle contest, then add a queued batch job referencing a contest using platform-default CF -> still blocks delete!
  assert.equal((await req('/api/contests/item?path=contests/cf-handle-ref.json', { method: 'DELETE' })).status, 200);
  const activeCfContestPath = join(dir, 'external-cf-contest.json');
  await writeFile(
    activeCfContestPath,
    JSON.stringify({
      schema_version: 2,
      contest_id: 'active-cf',
      data_version: 1,
      title: 'Active CF',
      source: { name: 'CF' },
      materials: { entrypoint: { kind: 'pdf', path: pdfInBase } },
      problems: [{ id: 'A', max_points: 500 }],
      judge: { kind: 'codeforces', contest_id: 1900, gym: false, languages: { cpp20: '89' } },
    }),
  );
  const activeBatchId = randomUUID();
  const fakeDigest = 'a'.repeat(64);
  await mkdir(join(root, '.batches'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, '.batches', `${activeBatchId}.json`),
    JSON.stringify({
      schema_version: 1,
      id: activeBatchId,
      created_at: new Date().toISOString(),
      plan: {
        schema_version: 2,
        protocol_sha256: fakeDigest,
        jobs: [{
          image: FAKE_IMAGE,
          harness: 'codex',
          agent_path: join(base, 'agents', 'a.toml'),
          agent_id: 'a',
          agent_revision: fakeDigest,
          agent_sha256: fakeDigest,
          profile_sha256: fakeDigest,
          contest_path: activeCfContestPath,
          contest_id: 'active-cf',
          data_version: 1,
          contest_sha256: fakeDigest,
        }],
      },
      jobs: [{ status: 'queued' }],
    }),
  );
  assert.equal((await req('/api/oj-accounts/cf-h1', { method: 'DELETE' })).status, 409, 'Queued batch job must block OJ account delete');
  await rm(join(root, '.batches', `${activeBatchId}.json`));
  assert.equal((await req('/api/oj-accounts/cf-h1', { method: 'DELETE' })).status, 200);

  // 7. Empty preflight rejected with 400
  const emptyPre1 = await req('/api/preflight', { body: {} });
  assert.equal(emptyPre1.status, 400);
  assert.match(emptyPre1.value.error, /Select at least one/i);
  const emptyPre2 = await req('/api/preflight', { body: { agents: [], contests: [], cells: [] } });
  assert.equal(emptyPre2.status, 400);

  // 8. Symlinked .materials root rejected on preview & material deletion
  await rm(join(root, '.materials'), { recursive: true, force: true });
  const fakeMatDir = join(dir, 'outside-materials');
  await mkdir(join(fakeMatDir, 'x', 'entrypoint'), { recursive: true });
  await writeFile(join(fakeMatDir, 'x', 'entrypoint', 'p.pdf'), pdfBytes);
  await symlink(fakeMatDir, join(root, '.materials'));
  assert.equal((await req('/api/contests/materials', { method: 'DELETE', body: { cleanup_orphans: true } })).status, 400);
  assert.equal((await req('/api/contests/materials', { method: 'DELETE', body: { path: 'managed/x/entrypoint/p.pdf' } })).status, 400);
  previewMode = 'reflect';
  assert.equal(
    (await req('/api/contests/preview', { body: { platform: 'qoj', contest_id: 42, pdf_path: 'managed/x/entrypoint/p.pdf' } })).status,
    400,
  );
});

test('Studio v2 runtime regressions: SSE closes on terminal queue jobs, /api/coverage execution recency ordering, UUID validation (404 without path leak), and ranked omitted_runs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-studio-v2-rt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'workspace');
  const root = join(dir, 'runs');
  await mkdir(base, { recursive: true });
  await mkdir(join(root, '.batches'), { recursive: true, mode: 0o700 });

  const studio = await startStudio(root, 0, { base, getImage, ssePollMs: 40 });
  t.after(() => studio.close());
  const req = makeRequester(studio.url);

  const dA = '1'.repeat(64);
  const dC = '2'.repeat(64);
  const dP = '3'.repeat(64);
  const makePlanJob = (agentId, extra = {}) => ({
    image: FAKE_IMAGE,
    harness: 'codex',
    agent_path: join(base, `${agentId}.toml`),
    agent_id: agentId,
    agent_revision: dA,
    agent_sha256: dA,
    profile_sha256: dA,
    contest_path: join(base, 'c.json'),
    contest_id: 'cov-contest',
    data_version: 1,
    contest_sha256: dC,
    ...extra,
  });

  const writeRunFiles = async (runId, agentId, { startedAt, status = 'completed', score = 10, maxScore = 10, corrupt = false }) => {
    const runDir = join(root, runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    if (corrupt) {
      await writeFile(join(runDir, 'run.json'), '{not-valid-json');
      return;
    }
    await writeFile(
      join(runDir, 'run.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: runId,
        contest_id: 'cov-contest',
        data_version: 1,
        contest_revision: dC,
        protocol_id: 'contestreplay-mcp',
        protocol_version: 1,
        protocol_sha256: dP,
        agent_id: agentId,
        agent_revision: dA,
        harness: { kind: 'codex', version: '0.170.0' },
        model: { model: 'gpt-5.4', vendor: 'openai' },
        input_sha256: { contest: dC },
        problems: [{ id: '1', max_points: maxScore }],
        rules: { time_limit_ms: 600_000, max_submissions: 10 },
      }),
    );
    const events = [
      JSON.stringify({ schema_version: 1, seq: 1, elapsed_ms: 0, type: 'run_started', started_at: startedAt }),
    ];
    if (status === 'completed') {
      events.push(
        JSON.stringify({ schema_version: 1, seq: 2, elapsed_ms: 1000, type: 'submission_received', submission_id: 's1', problem_id: '1' }),
        JSON.stringify({ schema_version: 1, seq: 3, elapsed_ms: 1000, type: 'submission_judged', submission_id: 's1', problem_id: '1', verdict: 'accepted', score, max_points: maxScore }),
        JSON.stringify({ schema_version: 1, seq: 4, elapsed_ms: 2000, type: 'run_ended', status: 'completed', reason: 'finish', score, max_score: maxScore }),
      );
    }
    await writeFile(join(runDir, 'events.jsonl'), events.join('\n') + '\n');
  };

  // 1. Batch with:
  //   - repeat 1 completed (r1) + repeat 2 queued (no run_id) -> /api/coverage MUST keep latest_status='completed' & latest_run_id=r1!
  //   - cancelled job without run.json (rCancelledNoFile) -> SSE MUST emit event: status & close immediately!
  //   - interrupted job whose run.json is stuck at running (rInterruptedStuck) -> SSE MUST emit event: status & close immediately!
  //   - completed job with corrupted run.json (rCorrupt) -> /api/results/ranked MUST return it in omitted_runs without host paths!
  const r1 = randomUUID();
  const rCancelledNoFile = randomUUID();
  const rInterruptedStuck = randomUUID();
  const rCorrupt = randomUUID();
  const b1 = randomUUID();

  await writeRunFiles(r1, 'agent-repeat', { startedAt: '2026-01-01T00:01:00.000Z', status: 'completed', score: 8, maxScore: 10 });
  await writeRunFiles(rInterruptedStuck, 'agent-int', { startedAt: '2026-01-01T00:02:00.000Z', status: 'running' });
  await writeRunFiles(rCorrupt, 'agent-corrupt', { startedAt: '2026-01-01T00:03:00.000Z', corrupt: true });

  await writeFile(
    join(root, '.batches', `${b1}.json`),
    JSON.stringify({
      schema_version: 1,
      id: b1,
      created_at: '2026-01-01T00:00:00.000Z',
      plan: {
        schema_version: 2,
        protocol_sha256: dP,
        jobs: [
          makePlanJob('agent-repeat', { repeat_index: 1, repeat_total: 2 }),
          makePlanJob('agent-repeat', { repeat_index: 2, repeat_total: 2 }),
          makePlanJob('agent-cancel'),
          makePlanJob('agent-int'),
          makePlanJob('agent-corrupt'),
        ],
      },
      jobs: [
        { status: 'completed', run_id: r1, reason: 'finish' },
        { status: 'queued' },
        { status: 'cancelled', run_id: rCancelledNoFile, reason: 'cancelled' },
        { status: 'interrupted', run_id: rInterruptedStuck, reason: 'executor_stopped' },
        { status: 'completed', run_id: rCorrupt, reason: 'finish' },
      ],
    }),
  );

  // 2. Resumed older batch vs newer batch for /api/coverage execution recency ordering:
  //    bOlder (created 01:00) ran at 05:00 (resumed!) vs bNewer (created 02:00) ran at 03:00 -> bOlder's run MUST win!
  const rOldResumed = randomUUID();
  const rNewerCreated = randomUUID();
  const bOlder = randomUUID();
  const bNewer = randomUUID();
  await writeRunFiles(rOldResumed, 'agent-recency', { startedAt: '2026-01-01T05:00:00.000Z', status: 'completed', score: 10, maxScore: 10 });
  await writeRunFiles(rNewerCreated, 'agent-recency', { startedAt: '2026-01-01T03:00:00.000Z', status: 'completed', score: 5, maxScore: 10 });

  await writeFile(
    join(root, '.batches', `${bOlder}.json`),
    JSON.stringify({
      schema_version: 1,
      id: bOlder,
      created_at: '2026-01-01T01:00:00.000Z',
      plan: { schema_version: 2, protocol_sha256: dP, jobs: [makePlanJob('agent-recency')] },
      jobs: [{ status: 'completed', run_id: rOldResumed, reason: 'finish' }],
    }),
  );
  await writeFile(
    join(root, '.batches', `${bNewer}.json`),
    JSON.stringify({
      schema_version: 1,
      id: bNewer,
      created_at: '2026-01-01T02:00:00.000Z',
      plan: { schema_version: 2, protocol_sha256: dP, jobs: [makePlanJob('agent-recency')] },
      jobs: [{ status: 'completed', run_id: rNewerCreated, reason: 'finish' }],
    }),
  );

  // Check /api/coverage
  const covRes = await req('/api/coverage');
  assert.equal(covRes.status, 200, covRes.text);
  coverageResponseSchema.parse(covRes.value);
  const repeatCell = covRes.value.cells.find(c => c.agent_id === 'agent-repeat');
  assert.ok(repeatCell);
  assert.equal(repeatCell.latest_status, 'completed', 'Unrun queued repeat must NOT overwrite completed latest_status');
  assert.equal(repeatCell.latest_run_id, r1, 'Unrun queued repeat must NOT clear latest_run_id');
  assert.equal(repeatCell.completed_count, 1);

  const recencyCell = covRes.value.cells.find(c => c.agent_id === 'agent-recency');
  assert.ok(recencyCell);
  assert.equal(recencyCell.latest_run_id, rOldResumed, 'Resumed older batch that ran more recently must win latest_run_id');
  assert.equal(recencyCell.completed_count, 2);
  assert.equal(recencyCell.best_score, 10);

  // Check SSE closes promptly on both cancelled-before-run.json AND interrupted-with-running-run.json!
  const readSseToClose = async runId => {
    const res = await fetch(`${studio.url}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.status, 200);
    const bodyText = await res.text();
    const frames = bodyText.split('\n\n').filter(Boolean);
    return frames.map(f => {
      const eventLine = f.split('\n').find(l => l.startsWith('event: '));
      const dataLine = f.split('\n').find(l => l.startsWith('data: '));
      return {
        event: eventLine ? eventLine.slice(7) : null,
        data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
      };
    }).filter(f => f.event);
  };

  const sseCancelFrames = await readSseToClose(rCancelledNoFile);
  const cancelStatus = sseCancelFrames.find(f => f.event === 'status');
  assert.ok(cancelStatus, 'Cancelled job without run.json must emit terminal status event and close');
  runStatusEventSchema.parse(cancelStatus.data);
  assert.equal(cancelStatus.data.status, 'cancelled');

  const sseIntFrames = await readSseToClose(rInterruptedStuck);
  const intStatus = sseIntFrames.find(f => f.event === 'status');
  assert.ok(intStatus, 'Interrupted job with stuck running run.json must emit terminal status event and close');
  runStatusEventSchema.parse(intStatus.data);
  assert.equal(intStatus.data.status, 'interrupted');

  // Check strict UUID validation (400) & missing batch (404 without host path leak) on /api/batches/:id/* and /api/results/ranked
  const missingBatchId = randomUUID();
  assert.equal((await req('/api/batches/not-a-uuid/results')).status, 400);
  assert.equal((await req('/api/batches/not-a-uuid/stop', { method: 'POST', body: {} })).status, 400);
  assert.equal((await req('/api/batches/not-a-uuid/resume', { method: 'POST', body: {} })).status, 400);
  assert.equal((await req('/api/results/ranked?batch_id=not-a-uuid')).status, 400);

  for (const [p, opts] of [
    [`/api/batches/${missingBatchId}/results`, {}],
    [`/api/batches/${missingBatchId}/stop`, { method: 'POST', body: {} }],
    [`/api/batches/${missingBatchId}/resume`, { method: 'POST', body: {} }],
    [`/api/results/ranked?batch_id=${missingBatchId}`, {}],
  ]) {
    const res = await req(p, opts);
    assert.equal(res.status, 404, `Missing batch on ${p} must return 404`);
    assert.equal(res.value.error, 'Batch not found');
    assert.ok(!res.text.includes(root), `404 on ${p} must never leak host filesystem path`);
  }

  // Check /api/results/ranked reports omitted_runs without leaking host paths
  const rankedRes = await req(`/api/results/ranked?batch_id=${b1}`);
  assert.equal(rankedRes.status, 200, rankedRes.text);
  rankedResultsResponseSchema.parse(rankedRes.value);
  assert.equal(rankedRes.value.groups.length, 1);
  assert.equal(rankedRes.value.groups[0].length, 1);
  assert.equal(rankedRes.value.groups[0][0].result.run_id, r1);
  assert.equal(rankedRes.value.omitted_runs.length, 1);
  assert.equal(rankedRes.value.omitted_runs[0].run_id, rCorrupt);
  assert.equal(rankedRes.value.omitted_runs[0].reason, 'invalid_run_metadata');
  assert.ok(!rankedRes.value.omitted_runs[0].reason.includes(root), 'omitted_runs reason must not leak host path');
});

test('Studio v2 final polish regressions: preflight safety & protocol/path sanitization, reserved names, non-extension answer attachments, archive/runs, serialization, concurrent immutable answers, short cookie redaction, platform-default OJ & run.json guards, SSE backpressure/missing batch, fixed omission codes, locked agent delete', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-studio-v2-polish-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'workspace');
  const root = join(dir, 'runs');
  await mkdir(join(base, 'agents'), { recursive: true });
  await mkdir(join(base, 'contests'), { recursive: true });
  await mkdir(join(base, 'archive', 'runs'), { recursive: true });
  await mkdir(join(root, '.batches'), { recursive: true, mode: 0o700 });

  const store = new Connections(join(dir, 'connections'));
  const ojAccounts = new OjAccounts(join(dir, 'oj-accounts'));

  const pdfPath = join(base, 'paper.pdf');
  await synthesizeTextContestPdf([{ id: '1', title: 'P1', body: 'Solve 1' }], pdfPath);
  const pdfBytes = await readFile(pdfPath);

  // Create valid responses provider + incompatible chat-completions provider
  await store.create({
    id: 'resp-prov',
    label: 'Responses Provider',
    protocol: 'responses',
    base_url: 'http://127.0.0.1:19991/v1',
    secret: 'sk-resp-secret-123456',
  });
  await store.create({
    id: 'chat-prov',
    label: 'Chat Provider',
    protocol: 'chat-completions',
    base_url: 'http://127.0.0.1:19992/v1',
    secret: 'sk-chat-secret-123456',
  });

  let previewErrorMode = false;
  const mockPreview = async (platform, contestId, opts) => {
    if (previewErrorMode) {
      throw new Error(`Upstream failed echoing cookie=${opts?.cookie ?? ''} internal-detail`);
    }
    return {
      platform,
      contest_ref: String(contestId),
      title: `Echo ${opts?.cookie ?? ''} short abc and x`,
      status: 'finished',
      problems: [{ remote_id: 'A', title: 'Problem abc x' }],
      suggested_languages: [],
    };
  };

  const studio = await startStudio(root, 0, {
    base,
    store,
    ojAccounts,
    getImage,
    previewContest: mockPreview,
    ssePollMs: 40,
    sseDrainTimeoutMs: 250,
  });
  t.after(() => studio.close());
  const req = makeRequester(studio.url);

  const uploadMat = async (contestId, filename, bytes, kind = 'entrypoint') => {
    const form = new FormData();
    form.set('contest_id', contestId);
    form.set('kind', kind);
    form.set('file', new Blob([bytes]), filename);
    const res = await fetch(`${studio.url}/api/contests/materials`, {
      method: 'POST',
      headers: { Origin: studio.url, 'X-CR-Studio': '1' },
      body: form,
    });
    return { status: res.status, value: await res.json() };
  };

  const validAgentDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'polish-agent',
    vendor: 'openai',
    model: 'gpt-5.4',
    provider: 'resp-prov',
    harness: { kind: 'codex', version: '0.170.0', options: {} },
  };
  assert.equal((await req('/api/agents', { body: { document: validAgentDoc } })).status, 201);

  // 1. Central reserved filename rejection on POST /api/agents, POST /api/agents/clone, POST /api/contests
  for (const reserved of ['package.json', 'run.json', 'judge.json', 'foo.judge.json', 'foo.judge.v1.2.json']) {
    const agentRes = await req('/api/agents', {
      body: { file: reserved, format: 'json', document: { ...validAgentDoc, id: 'res-agent' } },
    });
    assert.equal(agentRes.status, 400, `POST /api/agents must reject reserved filename ${reserved}`);

    const cloneRes = await req('/api/agents/clone', {
      body: { source_path: 'agents/polish-agent.toml', id: 'cloned-res', file: reserved, format: 'json' },
    });
    assert.equal(cloneRes.status, 400, `POST /api/agents/clone must reject reserved filename ${reserved}`);

    const contestRes = await req('/api/contests', {
      body: {
        file: reserved,
        document: {
          schema_version: 2,
          contest_id: 'res-contest',
          data_version: 1,
          title: 'Reserved',
          source: { name: 'Local' },
          materials: { entrypoint: { kind: 'pdf', path: 'paper.pdf' } },
          judge: { kind: 'local', problems: [{ id: '1', max_points: 1, accepted_answers: ['42'] }] },
        },
      },
    });
    assert.equal(contestRes.status, 400, `POST /api/contests must reject reserved filename ${reserved}`);
  }

  // 2. Shared forbidden directory policy rejects nested archive/runs/ everywhere
  assert.equal(
    (await req('/api/contests', {
      body: {
        file: 'archive/runs/hidden-contest.json',
        document: {
          schema_version: 2,
          contest_id: 'hidden-c',
          data_version: 1,
          title: 'Hidden',
          source: { name: 'Local' },
          materials: { entrypoint: { kind: 'pdf', path: '../../paper.pdf' } },
          judge: { kind: 'local', problems: [{ id: '1', max_points: 1, accepted_answers: ['1'] }] },
        },
      },
    })).status,
    400,
    'POST /api/contests must reject archive/runs/',
  );
  assert.equal(
    (await req('/api/agents', {
      body: { file: 'archive/runs/hidden-agent.toml', format: 'toml', document: { ...validAgentDoc, id: 'hidden-a' } },
    })).status,
    400,
    'POST /api/agents must reject archive/runs/',
  );
  assert.equal(
    (await req('/api/agents/variants', {
      body: { base_document: validAgentDoc, reasoning_efforts: ['low'], directory: 'archive/runs', dry_run: true },
    })).status,
    400,
    'POST /api/agents/variants must reject archive/runs/',
  );

  // 3. POST /api/preflight: rejects package.json/run.json/foo.judge.v1.2.json, checks harness protocol compatibility, sanitizes host paths
  await writeFile(join(base, 'package.json'), JSON.stringify({ name: 'demo' }));
  await writeFile(join(base, 'run.json'), JSON.stringify({ run_id: randomUUID() }));
  await writeFile(join(base, 'foo.judge.v1.2.json'), JSON.stringify({
    schema_version: 1,
    problems: [{ id: '1', max_points: 1, accepted_answers: ['42'] }],
  }));
  // Incompatible codex agent bound to chat-completions provider
  await writeFile(
    join(base, 'agents', 'bad-proto.json'),
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'bad-proto',
      vendor: 'openai',
      model: 'gpt-5.4',
      provider: 'chat-prov',
      harness: { kind: 'codex', version: '0.170.0', options: {} },
    }),
  );
  const preRes = await req('/api/preflight', {
    body: {
      agents: ['package.json', 'run.json', 'foo.judge.v1.2.json', 'agents/bad-proto.json'],
      contests: ['package.json', 'run.json', 'foo.judge.v1.2.json'],
    },
  });
  assert.equal(preRes.status, 200, preRes.text);
  assert.equal(preRes.value.ok, false);
  for (const check of [...preRes.value.agents, ...preRes.value.contests]) {
    assert.equal(check.ok, false, `Preflight must reject ${check.path}`);
    assert.ok(check.issues.length > 0);
    for (const iss of check.issues) {
      assert.ok(!iss.includes(base), `Preflight issue must not leak base path: ${iss}`);
      assert.ok(!iss.includes(root), `Preflight issue must not leak root path: ${iss}`);
    }
  }
  const protoCheck = preRes.value.agents.find(a => a.path === 'agents/bad-proto.json');
  assert.ok(protoCheck.issues.some(i => /requires a responses or passthrough provider/i.test(i)));

  // 4. GET /api/contests/item?include_judge=1 refuses external symlinked answer table & non-extension answer attachments
  const externalAnswerFile = join(dir, 'outside-secret.judge.json');
  const externalAnswerJson = JSON.stringify({
    schema_version: 1,
    problems: [{ id: '1', max_points: 10, accepted_answers: ['TOP_SECRET_EXTERNAL_ANSWER'] }],
  });
  await writeFile(externalAnswerFile, externalAnswerJson);
  await symlink(externalAnswerFile, join(base, 'contests', 'symlink-ans.json'));
  await writeFile(
    join(base, 'contests', 'symlink-contest.json'),
    JSON.stringify({
      schema_version: 2,
      contest_id: 'symlink-c',
      data_version: 1,
      title: 'Symlink Contest',
      source: { name: 'Local' },
      materials: { entrypoint: { kind: 'pdf', path: '../paper.pdf' } },
      problems: [{ id: '1', max_points: 10 }],
      judge: { kind: 'local', answers: { path: 'symlink-ans.json' } },
    }),
  );
  const symGet = await req('/api/contests/item?path=contests/symlink-contest.json&include_judge=1');
  assert.equal(symGet.status, 200, symGet.text);
  assert.equal(symGet.value.valid, false, 'Symlinked external answer table must fail Studio contest loading');
  assert.equal(symGet.value.judge, undefined, 'include_judge=1 must NEVER return external symlinked answers');
  assert.ok(!symGet.text.includes('TOP_SECRET_EXTERNAL_ANSWER'));
  assert.ok(!symGet.value.issues.join(' ').includes(base));

  const symPre = await req('/api/preflight', { body: { contests: ['contests/symlink-contest.json'] } });
  assert.equal(symPre.status, 200);
  assert.equal(symPre.value.ok, false);
  assert.equal(symPre.value.contests[0].ok, false);

  // 5. Non-.json extension attachment containing answer table rejected on save AND on load; cross-contest .materials round-trip rejected
  await writeFile(join(base, 'disguised-answers.txt'), externalAnswerJson);
  const attachAnsSave = await req('/api/contests', {
    body: {
      file: 'contests/att-ans.json',
      document: {
        schema_version: 2,
        contest_id: 'att-ans',
        data_version: 1,
        title: 'Att Ans',
        source: { name: 'Local' },
        materials: {
          entrypoint: { kind: 'pdf', path: '../paper.pdf' },
          attachments: [{ path: '../disguised-answers.txt', name: 'hints.txt' }],
        },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] },
      },
    },
  });
  assert.equal(attachAnsSave.status, 400, 'Non-.json attachment containing answer table must be rejected on save');

  // Hand-crafted contest attaching disguised-answers.txt must also fail on GET /api/contests/item & POST /api/preflight
  await writeFile(join(base, 'contests', 'legit-ans.json'), externalAnswerJson);
  await writeFile(
    join(base, 'contests', 'hand-att-ans.json'),
    JSON.stringify({
      schema_version: 2,
      contest_id: 'hand-att-ans',
      data_version: 1,
      title: 'Hand Att Ans',
      source: { name: 'Local' },
      materials: {
        entrypoint: { kind: 'pdf', path: '../paper.pdf' },
        attachments: [{ path: '../disguised-answers.txt', name: 'hints.txt' }],
      },
      problems: [{ id: '1', max_points: 10 }],
      judge: { kind: 'local', answers: { path: 'legit-ans.json' } },
    }),
  );
  const handGet = await req('/api/contests/item?path=contests/hand-att-ans.json&include_judge=1');
  assert.equal(handGet.status, 200);
  assert.equal(handGet.value.valid, false);
  assert.equal(handGet.value.judge, undefined);
  const handPre = await req('/api/preflight', { body: { contests: ['contests/hand-att-ans.json'] } });
  assert.equal(handPre.value.ok, false);

  // Cross-contest .materials relative path round-trip rejected
  const matOther = await uploadMat('other-contest', 'other.pdf', pdfBytes, 'entrypoint');
  assert.equal(matOther.status, 201);
  const otherRelFromContests = `../../runs/.materials/other-contest/entrypoint/${matOther.value.path.split('/').at(-1)}`;
  const crossMatSave = await req('/api/contests', {
    body: {
      file: 'contests/steal-mat.json',
      document: {
        schema_version: 2,
        contest_id: 'steal-contest',
        data_version: 1,
        title: 'Steal',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: otherRelFromContests } },
        judge: { kind: 'local', problems: [{ id: '1', max_points: 1, accepted_answers: ['1'] }] },
      },
    },
  });
  assert.equal(crossMatSave.status, 400, 'Relative round-trip into another contest managed upload must be rejected');

  // 6. Concurrent local contest creates sharing content-addressed answers: loser rollback MUST NOT delete live answer table
  const raceDoc = {
    file: 'contests/race-local.json',
    document: {
      schema_version: 2,
      contest_id: 'race-local',
      data_version: 1,
      title: 'Race Local',
      source: { name: 'Local' },
      materials: { entrypoint: { kind: 'pdf', path: '../paper.pdf' } },
      judge: { kind: 'local', problems: [{ id: '1', max_points: 5, accepted_answers: ['race-ok'] }] },
    },
  };
  const [race1, race2] = await Promise.all([
    req('/api/contests', { body: raceDoc }),
    req('/api/contests', { body: raceDoc }),
  ]);
  assert.deepEqual([race1.status, race2.status].sort((a, b) => a - b), [201, 409]);
  const afterRace = await req('/api/contests/item?path=contests/race-local.json&include_judge=1');
  assert.equal(afterRace.status, 200);
  assert.equal(afterRace.value.valid, true, 'Live answer table must survive concurrent loser rollback');
  assert.equal(afterRace.value.judge.problems[0].accepted_answers[0], 'race-ok');

  // PUT with existing judge.answers.path publishes immutable content-addressed copy
  const sharedSourceAns = join(base, 'shared-src-answers.json');
  await writeFile(sharedSourceAns, JSON.stringify({
    schema_version: 1,
    problems: [{ id: '1', max_points: 5, accepted_answers: ['from-existing-file'] }],
  }));
  const putExisting = await req('/api/contests/item', {
    method: 'PUT',
    body: {
      path: 'contests/race-local.json',
      document: {
        schema_version: 2,
        contest_id: 'race-local',
        data_version: 2,
        title: 'Race Local Existing Answers',
        source: { name: 'Local' },
        materials: { entrypoint: { kind: 'pdf', path: '../paper.pdf' } },
        judge: { kind: 'local', answers: { path: '../shared-src-answers.json' } },
      },
    },
  });
  assert.equal(putExisting.status, 200, putExisting.text);
  assert.match(putExisting.value.judge_path, /^contests\/race-local\.judge\.[a-f0-9]{12}\.json$/);
  const afterPutExisting = await req('/api/contests/item?path=contests/race-local.json&include_judge=1');
  assert.equal(afterPutExisting.value.valid, true);
  assert.equal(afterPutExisting.value.judge.problems[0].accepted_answers[0], 'from-existing-file');

  // 6b. Concurrent POST /api/contests vs DELETE /api/contests/materials (orphan cleanup) never leaves a dangling manifest
  const matRace = await uploadMat('mat-race', 'race.pdf', pdfBytes, 'entrypoint');
  assert.equal(matRace.status, 201);
  const [matSaveRes, matCleanRes] = await Promise.all([
    req('/api/contests', {
      body: {
        file: 'contests/mat-race.json',
        document: {
          schema_version: 2,
          contest_id: 'mat-race',
          data_version: 1,
          title: 'Mat Race',
          source: { name: 'Local' },
          materials: { entrypoint: { kind: 'pdf', path: matRace.value.path } },
          judge: { kind: 'local', problems: [{ id: '1', max_points: 1, accepted_answers: ['1'] }] },
        },
      },
    }),
    req('/api/contests/materials', { method: 'DELETE', body: { cleanup_orphans: true } }),
  ]);
  assert.equal(matCleanRes.status, 200);
  if (matSaveRes.status === 201) {
    assert.ok(!matCleanRes.value.deleted.includes(matRace.value.path), 'Serialized save + cleanup must never delete referenced material');
    const loadedMatRace = await req('/api/contests/item?path=contests/mat-race.json');
    assert.equal(loadedMatRace.value.valid, true);
  } else {
    assert.equal(matSaveRes.status, 404);
    assert.ok(matCleanRes.value.deleted.includes(matRace.value.path));
  }

  // 7. Queued batch referencing managed material blocks material deletion (even if contest is outside workspace)
  const matQueued = await uploadMat('queued-mat', 'q.pdf', pdfBytes, 'entrypoint');
  assert.equal(matQueued.status, 201);
  const extQueuedContest = join(dir, 'ext-queued-contest.json');
  await writeFile(extQueuedContest, JSON.stringify({
    schema_version: 2,
    contest_id: 'queued-mat',
    data_version: 1,
    title: 'Queued Mat',
    source: { name: 'Local' },
    materials: { entrypoint: { kind: 'pdf', path: matQueued.value.path } },
    problems: [{ id: '1', max_points: 1 }],
    judge: { kind: 'local', answers: { path: externalAnswerFile } },
  }));
  const queuedBatchId = randomUUID();
  const h = 'a'.repeat(64);
  await writeFile(
    join(root, '.batches', `${queuedBatchId}.json`),
    JSON.stringify({
      schema_version: 1,
      id: queuedBatchId,
      created_at: new Date().toISOString(),
      plan: {
        schema_version: 2,
        protocol_sha256: h,
        jobs: [{
          image: FAKE_IMAGE,
          harness: 'codex',
          agent_path: join(base, 'agents', 'polish-agent.toml'),
          agent_id: 'polish-agent',
          credential_source: 'provider:resp-prov',
          agent_revision: h,
          agent_sha256: h,
          profile_sha256: h,
          effective_sha256: h,
          contest_path: extQueuedContest,
          contest_id: 'queued-mat',
          data_version: 1,
          contest_sha256: h,
        }],
      },
      jobs: [{ status: 'queued' }],
    }),
  );
  const delQueuedMat = await req('/api/contests/materials', { method: 'DELETE', body: { path: matQueued.value.path } });
  assert.equal(delQueuedMat.status, 409, 'Material referenced by queued batch job must not be deleted');
  // Corrupt queued contest -> fail closed with 409
  await writeFile(extQueuedContest, '{corrupt');
  assert.equal(
    (await req('/api/contests/materials', { method: 'DELETE', body: { cleanup_orphans: true } })).status,
    409,
    'Unparseable queued batch contest must fail closed with 409',
  );
  await rm(join(root, '.batches', `${queuedBatchId}.json`));

  // 8. Short cookie redaction ("abc", "x"), fixed public error on authenticated preview failure, and non-absolute pdf_info.path
  const matShortPrev = await uploadMat('short-prev', 'short.pdf', pdfBytes, 'entrypoint');
  assert.equal(matShortPrev.status, 201);
  await ojAccounts.create({
    id: 'short-ck',
    label: 'Short Cookie',
    platform: 'qoj',
    handle: 'short_h',
    pool: 'default',
    transport: 'cookie',
    secret: 'SID=abc; f=x',
  });
  previewErrorMode = false;
  const shortPrev = await req('/api/contests/preview', {
    body: { platform: 'qoj', contest_id: 77, account_id: 'short-ck', pdf_path: matShortPrev.value.path },
  });
  assert.equal(shortPrev.status, 200, shortPrev.text);
  assert.ok(!shortPrev.value.preview.title.includes('abc'), 'Short cookie value "abc" must be redacted');
  assert.ok(!/\bx\b/.test(shortPrev.value.preview.title), '1-char standalone cookie value "x" must be redacted');
  assert.equal(shortPrev.value.pdf_info.path, matShortPrev.value.path, 'pdf_info.path must echo input ref, not host path');
  assert.ok(!shortPrev.value.pdf_info.path.startsWith('/'));

  previewErrorMode = true;
  const shortErr = await req('/api/contests/preview', {
    body: { platform: 'qoj', contest_id: 77, account_id: 'short-ck' },
  });
  assert.equal(shortErr.status, 400);
  assert.equal(shortErr.value.error, 'Contest preview failed; verify the contest reference and OJ account credentials');
  assert.ok(!shortErr.text.includes('internal-detail'));
  assert.ok(!shortErr.text.includes('SID=abc'));

  // 9. Platform-default OJ account delete guard (blocks last ready account) & active run.json mid-run edit protection
  await ojAccounts.create({
    id: 'qoj-def-2',
    label: 'QOJ Second',
    platform: 'qoj',
    handle: 'qoj_h2',
    pool: 'default',
    transport: 'cookie',
    secret: 'SID=second-secret-token',
  });
  const qojDefaultSave = await req('/api/contests', {
    body: {
      file: 'contests/qoj-default.json',
      document: {
        schema_version: 2,
        contest_id: 'qoj-default',
        data_version: 1,
        title: 'QOJ Default',
        source: { name: 'QOJ' },
        materials: { entrypoint: { kind: 'pdf', path: '../paper.pdf' } },
        problems: [{ id: 'A', max_points: 100 }],
        judge: { kind: 'qoj', contest_id: 10, languages: { cpp20: 'C++20' } },
      },
    },
  });
  assert.equal(qojDefaultSave.status, 201, qojDefaultSave.text);
  // Deleting 1st of 2 ready QOJ accounts succeeds; deleting the last ready QOJ account returns 409!
  assert.equal((await req('/api/oj-accounts/short-ck', { method: 'DELETE' })).status, 200);
  assert.equal(
    (await req('/api/oj-accounts/qoj-def-2', { method: 'DELETE' })).status,
    409,
    'Platform-default QOJ contest must block deleting the last ready QOJ account',
  );
  // Delete the contest manifest, then simulate an already-running job whose run.json pins oj_account_id='qoj-def-2'
  // even though its contest_path on disk was edited to local!
  assert.equal((await req('/api/contests/item?path=contests/qoj-default.json', { method: 'DELETE' })).status, 200);
  const runningId = randomUUID();
  const runningBatchId = randomUUID();
  await mkdir(join(root, runningId), { recursive: true });
  await writeFile(join(root, runningId, 'run.json'), JSON.stringify({
    schema_version: 1,
    run_id: runningId,
    contest_id: 'qoj-default',
    data_version: 1,
    judge_kind: 'qoj',
    oj_account_id: 'qoj-def-2',
    judge_selector: { kind: 'qoj' },
    agent_id: 'polish-agent',
  }));
  await writeFile(join(root, runningId, 'events.jsonl'), JSON.stringify({
    schema_version: 1,
    seq: 1,
    elapsed_ms: 0,
    type: 'run_started',
    started_at: new Date().toISOString(),
  }) + '\n');
  await writeFile(
    join(root, '.batches', `${runningBatchId}.json`),
    JSON.stringify({
      schema_version: 1,
      id: runningBatchId,
      created_at: new Date().toISOString(),
      plan: {
        schema_version: 2,
        protocol_sha256: h,
        jobs: [{
          image: FAKE_IMAGE,
          harness: 'codex',
          agent_path: join(base, 'agents', 'polish-agent.toml'),
          agent_id: 'polish-agent',
          credential_source: 'provider:resp-prov',
          agent_revision: h,
          agent_sha256: h,
          profile_sha256: h,
          effective_sha256: h,
          contest_path: join(base, 'contests', 'race-local.json'), // edited/local contest on disk!
          contest_id: 'qoj-default',
          data_version: 1,
          contest_sha256: h,
        }],
      },
      jobs: [{ status: 'running', run_id: runningId }],
    }),
  );
  assert.equal(
    (await req('/api/oj-accounts/qoj-def-2', { method: 'DELETE' })).status,
    409,
    'Active run.json must block deleting its OJ account even if contest file on disk was edited',
  );

  // 10. SSE missing batch termination (deleting batch while SSE is open emits terminal status and closes)
  const sseMissRes = await fetch(`${studio.url}/api/runs/${runningId}/events`);
  assert.equal(sseMissRes.status, 200);
  const missReader = sseMissRes.body.getReader();
  const missDecoder = new TextDecoder();
  let missBuf = '';
  // Wait for first progress frame, then remove the batch file!
  while (!missBuf.includes('event: progress')) {
    const { done, value } = await missReader.read();
    if (done) break;
    missBuf += missDecoder.decode(value, { stream: true });
  }
  await rm(join(root, '.batches', `${runningBatchId}.json`));
  while (true) {
    const { done, value } = await missReader.read();
    if (done) break;
    missBuf += missDecoder.decode(value, { stream: true });
  }
  assert.match(missBuf, /event: status/, 'Missing batch must emit terminal status event and close SSE stream');

  // 11. SSE backpressure coalescing, terminal flush on drain, and bounded stall timeout
  {
    const fakeRes = new EventEmitter();
    fakeRes.destroyed = false;
    fakeRes.writableEnded = false;
    const written = [];
    let allowWrite = false;
    fakeRes.write = chunk => {
      written.push(chunk);
      return allowWrite;
    };
    let closedCount = 0;
    fakeRes.end = () => { fakeRes.writableEnded = true; };

    const writer = createSseWriter(fakeRes, {
      drainTimeoutMs: 500,
      onClose: () => { closedCount++; fakeRes.end(); },
    });
    // First write returns false -> enters waitingForDrain
    assert.equal(writer.write('event: progress\ndata: {"seq":1}\n\n'), true);
    assert.equal(writer.isWaitingForDrain(), true);
    // Subsequent writes while backpressured coalesce to ONLY the latest real payload; ping does not overwrite real payload
    writer.write('event: progress\ndata: {"seq":2}\n\n');
    writer.write('event: progress\ndata: {"seq":3}\n\n', true);
    writer.write(': ping\n\n');
    assert.equal(written.length, 1, 'Backpressured writes must wait for drain without unbounded buffering');
    assert.equal(closedCount, 0);

    // Emit drain -> flushes ONLY the coalesced latest terminal payload and closes cleanly
    allowWrite = true;
    fakeRes.emit('drain');
    assert.deepEqual(written, [
      'event: progress\ndata: {"seq":1}\n\n',
      'event: progress\ndata: {"seq":3}\n\n',
    ]);
    assert.equal(closedCount, 1, 'Terminal backpressured payload must close stream after drain');

    // Stalled client that never drains closes cleanly after bounded drainTimeoutMs
    const stalledRes = new EventEmitter();
    stalledRes.destroyed = false;
    stalledRes.writableEnded = false;
    stalledRes.write = () => false;
    let stalledClosed = false;
    stalledRes.end = () => { stalledRes.writableEnded = true; };
    const stalledWriter = createSseWriter(stalledRes, {
      drainTimeoutMs: 60,
      onClose: () => { stalledClosed = true; stalledRes.end(); },
    });
    stalledWriter.write('event: progress\ndata: {"seq":1}\n\n');
    assert.equal(stalledClosed, false);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(stalledClosed, true, 'Stalled SSE stream must close after bounded drain timeout');
  }

  // 12. Ranked results fixed omission enum reasons (no malformed JSON text leaked!)
  const omitBatchId = randomUUID();
  const rMissing = randomUUID();
  const rBadMeta = randomUUID();
  const rBadLog = randomUUID();
  await mkdir(join(root, rBadMeta), { recursive: true });
  await writeFile(join(root, rBadMeta, 'run.json'), '{"CANARY_SECRET_META": bad');
  await mkdir(join(root, rBadLog), { recursive: true });
  await writeFile(join(root, rBadLog, 'run.json'), JSON.stringify({
    schema_version: 1,
    run_id: rBadLog,
    contest_id: 'omit-c',
    data_version: 1,
    contest_revision: h,
    input_sha256: { contest: h },
    protocol_id: 'codex-pdf-pages-mcp',
    protocol_version: 2,
    protocol_sha256: h,
    agent_id: 'polish-agent',
    agent_revision: h,
    harness: { kind: 'codex', version: '0.170.0' },
    model: { model: 'gpt-5.4' },
  }));
  await writeFile(join(root, rBadLog, 'events.jsonl'), '{"CANARY_SECRET_LOG": broken\n');
  await writeFile(
    join(root, '.batches', `${omitBatchId}.json`),
    JSON.stringify({
      schema_version: 1,
      id: omitBatchId,
      created_at: new Date().toISOString(),
      plan: {
        schema_version: 2,
        protocol_sha256: h,
        jobs: [rMissing, rBadMeta, rBadLog].map((_id, idx) => ({
          image: FAKE_IMAGE,
          harness: 'codex',
          agent_path: join(base, 'agents', `omit-a-${idx}.toml`),
          agent_id: `omit-a-${idx}`,
          credential_source: 'provider:resp-prov',
          agent_revision: h,
          agent_sha256: h,
          profile_sha256: h,
          effective_sha256: h,
          contest_path: join(base, 'contests', 'race-local.json'),
          contest_id: 'omit-c',
          data_version: 1,
          contest_sha256: h,
        })),
      },
      jobs: [
        { status: 'completed', run_id: rMissing, reason: 'finish' },
        { status: 'completed', run_id: rBadMeta, reason: 'finish' },
        { status: 'completed', run_id: rBadLog, reason: 'finish' },
      ],
    }),
  );
  const omitRes = await req(`/api/results/ranked?batch_id=${omitBatchId}`);
  assert.equal(omitRes.status, 200, omitRes.text);
  rankedResultsResponseSchema.parse(omitRes.value);
  assert.ok(!omitRes.text.includes('CANARY_SECRET_META'));
  assert.ok(!omitRes.text.includes('CANARY_SECRET_LOG'));
  const reasonsByRun = new Map(omitRes.value.omitted_runs.map(r => [r.run_id, r.reason]));
  assert.equal(reasonsByRun.get(rMissing), 'missing_run_file');
  assert.equal(reasonsByRun.get(rBadMeta), 'invalid_run_metadata');
  assert.equal(reasonsByRun.get(rBadLog), 'invalid_event_log');

  // 13. Locked Agent DELETE + provider ref retirement (atomic unregisterAndDelete)
  assert.equal((await req('/api/providers/resp-prov', { method: 'DELETE' })).status, 409, 'Referenced provider blocked');
  assert.equal((await req('/api/agents/item?path=agents/polish-agent.toml', { method: 'DELETE' })).status, 200);
  const remainingRefs = await readdir(join(dir, 'connections', 'references')).catch(() => []);
  assert.equal(remainingRefs.filter(n => n.startsWith('resp-prov~')).length, 0, 'Agent DELETE must retire provider refs');
  assert.equal((await req('/api/providers/resp-prov', { method: 'DELETE' })).status, 200, 'Provider delete succeeds once agent deleted');
});

test('Studio v2 final admission and I/O regressions: plan/execute artifact policy, preview enum safety, verified PDF bytes, cross-process immutable answers, and parent-symlink rejection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-studio-v2-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'workspace');
  const root = join(dir, 'runs');
  await mkdir(join(base, 'agents'), { recursive: true });
  await mkdir(join(base, 'contests'), { recursive: true });
  await mkdir(join(root, '.batches'), { recursive: true, mode: 0o700 });

  const store = new Connections(join(dir, 'connections'));
  await store.create({
    id: 'admission-provider',
    label: 'Admission Provider',
    protocol: 'responses',
    base_url: 'http://127.0.0.1:19993/v1',
    secret: 'sk-admission-secret',
  });
  const ojAccounts = new OjAccounts(join(dir, 'oj-accounts'));
  await ojAccounts.create({
    id: 'qoj-short',
    label: 'QOJ short cookie',
    platform: 'qoj',
    handle: 'short-bot',
    transport: 'cookie',
    secret: 'session=oj; x=a',
  });
  const pdfPath = join(base, 'paper.pdf');
  await synthesizeTextContestPdf([{ id: '1', title: 'Problem 1', body: 'Solve 1' }], pdfPath);
  const studio = await startStudio(root, 0, {
    base,
    store,
    ojAccounts,
    getImage,
    previewContest: async (platform, contestId) => ({
      platform,
      contest_ref: String(contestId),
      title: 'Prefix oj a and abc',
      status: 'finished',
      problems: [{ remote_id: 'A', title: 'Title oj a abc' }],
      suggested_languages: [],
    }),
    queue: { preflight: async () => {} },
  });
  t.after(() => studio.close());
  const req = makeRequester(studio.url);

  const agentDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'admission-agent',
    vendor: 'openai',
    model: 'gpt-5.4',
    provider: 'admission-provider',
    harness: { kind: 'codex', version: '0.170.0', options: {} },
  };
  assert.equal((await req('/api/agents', { body: { document: agentDoc } })).status, 201);

  // Preview preserves trusted enum identities even for cookie value "oj", redacts short text,
  // validates the response, and returns a workspace-relative pdf_info.path instead of an absolute input path.
  const previewRes = await req('/api/contests/preview', {
    body: { platform: 'qoj', contest_id: 42, account_id: 'qoj-short', pdf_path: pdfPath },
  });
  assert.equal(previewRes.status, 200, previewRes.text);
  contestPreviewResponseSchema.parse(previewRes.value);
  assert.equal(previewRes.value.preview.platform, 'qoj');
  assert.equal(previewRes.value.preview.status, 'finished');
  assert.ok(!previewRes.text.includes('Prefix oj a and abc'));
  assert.equal(previewRes.value.pdf_info.path, 'paper.pdf');
  assert.ok(!previewRes.value.pdf_info.path.startsWith('/'));

  const answerTable = {
    schema_version: 1,
    problems: [{ id: '1', max_points: 1, accepted_answers: ['1'] }],
  };
  await writeFile(join(base, 'contests', 'judge.json'), JSON.stringify(answerTable));
  await writeFile(join(base, 'contests', 'disguised-answer.dat'), JSON.stringify(answerTable));
  const unsafeManifest = {
    schema_version: 2,
    contest_id: 'unsafe-admission',
    data_version: 1,
    title: 'Unsafe admission',
    source: { name: 'Local' },
    materials: {
      entrypoint: { kind: 'pdf', path: '../paper.pdf' },
      attachments: [{ name: 'statement-helper.dat', path: 'disguised-answer.dat' }],
    },
    judge: { kind: 'local', answers: { path: 'judge.json' } },
  };
  const unsafePath = join(base, 'contests', 'unsafe.json');
  await writeFile(unsafePath, JSON.stringify(unsafeManifest));
  const spec = {
    schema_version: 2,
    cells: [{ agent: 'agents/admission-agent.toml', contest: 'contests/unsafe.json' }],
  };
  // Studio plan admission uses the exact same artifact policy as item GET/preflight.
  const planRes = await req('/api/plan', { body: spec });
  assert.equal(planRes.status, 400, planRes.text);

  // A plan produced through the unrestricted CLI loader must also be rejected at Studio execution,
  // before any run directory is created, rather than allowing an invalid contest into the sandbox.
  const cliPlan = await makePlan(spec, base, getImage, store);
  await assert.rejects(
    verifyPlan(cliPlan, false, store, undefined, {
      loadAgent: async (file, inputStore) => (await loadStudioAgent(base, root, file, inputStore ?? store)).loaded,
      loadContest: file => loadStudioContest(root, base, file),
    }),
    /Answer files cannot be attached/i,
  );
  const batchId = randomUUID();
  await writeFile(
    join(root, '.batches', `${batchId}.json`),
    JSON.stringify({
      schema_version: 1,
      id: batchId,
      created_at: new Date().toISOString(),
      plan: cliPlan,
      jobs: [{ status: 'queued' }],
    }),
  );
  assert.equal((await req(`/api/batches/${batchId}/resume`, { body: {} })).status, 202);
  let terminalJob;
  for (let i = 0; i < 40; i++) {
    const batches = await req('/api/batches');
    terminalJob = batches.value.batches.find(b => b.id === batchId)?.jobs[0];
    if (terminalJob && terminalJob.status !== 'queued' && terminalJob.status !== 'running') break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(terminalJob?.status, 'void');
  assert.equal(terminalJob?.reason, 'runner_error');
  await assert.rejects(stat(join(root, terminalJob.run_id)), { code: 'ENOENT' });

  // Parent-directory symlinks are rejected even though O_NOFOLLOW alone protects only the final component.
  const outside = join(dir, 'outside-parent');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'data.json'), '{}');
  await symlink(outside, join(base, 'linked-parent'));
  await assert.rejects(
    readWorkspaceFileNoFollow(join(base, 'linked-parent', 'data.json')),
    /Parent directory changed|symlink/i,
  );

  // Searchable but unlistable (0711) ancestors remain usable: directory descriptors
  // use O_PATH while the manifest leaf itself is still opened read-only.
  const searchable = join(base, 'searchable-only');
  await mkdir(searchable, { mode: 0o711 });
  await writeFile(join(searchable, 'data.json'), '{"ok":true}');
  await chmod(searchable, 0o711);
  t.after(() => chmod(searchable, 0o700).catch(() => {}));
  assert.equal((await readWorkspaceFileNoFollow(join(searchable, 'data.json'))).toString('utf8'), '{"ok":true}');

  // Two independent Node processes publishing the same manifest/answer bytes serialize on the shared
  // filesystem lock. The losing manifest link must never remove the winner's immutable answer table.
  const moduleUrl = pathToFileURL(resolve('dist/contest-author.js')).href;
  const childPayload = JSON.stringify({
    file: 'contests/race.json',
    document: {
      schema_version: 2,
      contest_id: 'race-immutable',
      data_version: 1,
      title: 'Cross-process immutable publication',
      source: { name: 'Local' },
      materials: { entrypoint: { kind: 'pdf', path: '../paper.pdf' }, attachments: [] },
      judge: { kind: 'local', problems: answerTable.problems },
    },
  });
  const childSource = `
    import { createContestDocument } from ${JSON.stringify(moduleUrl)};
    const raw = JSON.parse(process.argv[1]);
    try {
      await createContestDocument(process.argv[2], process.argv[3], raw, new AbortController().signal);
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  `;
  const runPublisher = (publishRoot = root) => new Promise((resolveExit, rejectExit) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, childPayload, publishRoot, base], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectExit);
    child.once('close', code => resolveExit({ code, stderr }));
  });
  const otherRoot = join(dir, 'runs-other');
  await mkdir(otherRoot, { recursive: true, mode: 0o700 });
  const publishers = await Promise.all([runPublisher(), runPublisher(otherRoot)]);
  assert.deepEqual(publishers.map(p => p.code).sort(), [0, 1], publishers.map(p => p.stderr).join('\n'));
  const publishedManifest = JSON.parse(await readFile(join(base, 'contests', 'race.json'), 'utf8'));
  const immutableAnswerPath = join(base, 'contests', publishedManifest.judge.answers.path);
  assert.deepEqual(JSON.parse(await readFile(immutableAnswerPath, 'utf8')), answerTable);

  // A relative plan entry remains valid when Studio itself was opened through a symlinked workspace alias.
  await writeFile(
    join(base, 'contests', 'safe.json'),
    JSON.stringify({ ...unsafeManifest, materials: { entrypoint: { kind: 'pdf', path: '../paper.pdf' }, attachments: [] } }),
  );
  const alias = join(dir, 'workspace-alias');
  await symlink(base, alias);
  const aliasStudio = await startStudio(root, 0, { base: alias, store, getImage });
  t.after(() => aliasStudio.close());
  const aliasReq = makeRequester(aliasStudio.url);
  const aliasPlan = await aliasReq('/api/plan', {
    body: {
      schema_version: 2,
      cells: [{ agent: 'agents/admission-agent.toml', contest: 'contests/safe.json' }],
    },
  });
  assert.equal(aliasPlan.status, 200, aliasPlan.text);
});
