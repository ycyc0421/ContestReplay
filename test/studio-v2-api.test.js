import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connections } from '../dist/connections.js';
import { OjAccounts } from '../dist/judges/index.js';
import { synthesizeTextContestPdf } from '../dist/pdf-synth.js';
import { PushDispatcher, PushTargets } from '../dist/push.js';
import { startStudio } from '../dist/studio.js';

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
  const contestFile = resolve('examples/demo/contest.json');

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
});
