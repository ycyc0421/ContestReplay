import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sha256 } from '../dist/config.js';
import { Connections } from '../dist/connections.js';
import { createWorkbenchMcpServer } from '../dist/mcp-server.js';
import { OjAccounts } from '../dist/oj-accounts.js';
import { synthesizeTextContestPdf } from '../dist/pdf-synth.js';
import { verifyPushSignature } from '../dist/push.js';

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function parseToolJson(result) {
  assert.ok(Array.isArray(result.content) && result.content.length > 0);
  const text = result.content[0].text;
  return { text, data: JSON.parse(text) };
}

test('MCP workbench server exposes all narrow-permission tools with zero secret leakage and strict path confinement', async t => {
  const base = await makeTempDir(t, 'cr-mcp-base-');
  const root = await makeTempDir(t, 'cr-mcp-root-');
  const connDir = await makeTempDir(t, 'cr-mcp-conn-');
  const ojDir = await makeTempDir(t, 'cr-mcp-oj-');
  await chmod(connDir, 0o700);
  await chmod(ojDir, 0o700);

  const PROVIDER_SECRET = 'SECRET_PROVIDER_TOKEN_XYZ987';
  const OJ_COOKIE = 'JSESSIONID=SECRET_OJ_COOKIE_ABC123';
  const JUDGE_ANSWER = 'ULTRA_SECRET_ANSWER_424242';

  const store = new Connections(connDir);
  await store.create({
    id: 'p-openai',
    label: 'OpenAI Main',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: PROVIDER_SECRET,
    supports_fast: true,
    supports_ultrafast: true,
  });

  const ojAccounts = new OjAccounts(ojDir);
  await ojAccounts.create({
    id: 'cf-bot-1',
    label: 'CF Bot 1',
    platform: 'codeforces',
    handle: 'cf_demo_bot',
    pool: 'cf-pool',
    transport: 'cookie',
    secret: OJ_COOKIE,
  });

  const server = createWorkbenchMcpServer({
    base,
    root,
    store,
    ojAccounts,
    useExternalPdfTools: false,
  });
  const client = new Client({ name: 'test-coding-agent', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const assertNoSecrets = (rawText) => {
    assert.ok(!rawText.includes(PROVIDER_SECRET), 'Leaked provider secret!');
    assert.ok(!rawText.includes(OJ_COOKIE), 'Leaked OJ cookie!');
    assert.ok(!rawText.includes(JUDGE_ANSWER), 'Leaked local judge accepted answer!');
  };

  // Verify exact tool surface (NO run/cancel/credential/webhook mutation tools)
  const listed = await client.listTools();
  const toolNames = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(toolNames, [
    'cr_agent_batch_apply',
    'cr_agent_generate_variants',
    'cr_agent_validate',
    'cr_catalog_list',
    'cr_contest_batch_import',
    'cr_contest_inspect_pdf',
    'cr_coverage_diff',
    'cr_plan_preview',
    'cr_schema_export',
  ]);

  // 1. cr_schema_export
  const schemaRes = parseToolJson(await client.callTool({ name: 'cr_schema_export', arguments: { target: 'all' } }));
  assertNoSecrets(schemaRes.text);
  assert.equal(schemaRes.data.ok, true);
  assert.ok(schemaRes.data.schemas.agent);
  assert.ok(schemaRes.data.capabilities.speed_tiers.includes('ultrafast'));

  // 2. cr_agent_validate (valid + secret rejection)
  const baseAgentDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'gpt-main',
    name: 'GPT Main',
    vendor: 'openai',
    model: 'gpt-5.3-codex',
    provider: 'p-openai',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'high' } },
  };
  const valOk = parseToolJson(await client.callTool({ name: 'cr_agent_validate', arguments: { document: baseAgentDoc } }));
  assertNoSecrets(valOk.text);
  assert.equal(valOk.data.ok, true);
  assert.equal(valOk.data.valid, true);
  assert.ok(valOk.data.effective.content.includes('gpt-5.3-codex'));

  const valSecret = await client.callTool({
    name: 'cr_agent_validate',
    arguments: { document: { ...baseAgentDoc, api_key: 'sk-should-fail' } },
  });
  assert.equal(valSecret.isError, true);
  assert.equal(parseToolJson(valSecret).data.code, 'secret_rejected');

  // 3. cr_agent_batch_apply + cr_agent_generate_variants
  const applyRes = parseToolJson(
    await client.callTool({
      name: 'cr_agent_batch_apply',
      arguments: { items: [{ format: 'toml', document: baseAgentDoc }], dry_run: false, if_exists: 'error' },
    }),
  );
  assertNoSecrets(applyRes.text);
  assert.equal(applyRes.data.ok, true);
  assert.equal(applyRes.data.created, 1);

  const varRes = parseToolJson(
    await client.callTool({
      name: 'cr_agent_generate_variants',
      arguments: {
        base_document: baseAgentDoc,
        reasoning_efforts: ['low', 'high'],
        speed_tiers: ['fast'],
        format: 'yaml',
        dry_run: false,
        if_exists: 'error',
      },
    }),
  );
  assertNoSecrets(varRes.text);
  assert.equal(varRes.data.ok, true);
  assert.equal(varRes.data.created, 2);

  // 4. cr_contest_batch_import (with synthesized PDF + private local judge answer)
  const importRes = parseToolJson(
    await client.callTool({
      name: 'cr_contest_batch_import',
      arguments: {
        items: [
          {
            document: {
              schema_version: 2,
              contest_id: 'mcp-round',
              data_version: 1,
              title: 'MCP Round',
              source: { name: 'Local' },
              judge: {
                kind: 'local',
                problems: [{ id: 'A', max_points: 100, accepted_answers: [JUDGE_ANSWER] }],
              },
            },
            synth_problems: [{ id: 'A', title: 'Secret Test', body: 'Solve problem A.' }],
          },
        ],
        dry_run: false,
        if_exists: 'error',
      },
    }),
  );
  assertNoSecrets(importRes.text);
  assert.equal(importRes.data.ok, true);
  assert.equal(importRes.data.created, 1);

  // 5. cr_contest_inspect_pdf (valid inside base + path traversal rejection)
  const pdfInspect = parseToolJson(
    await client.callTool({
      name: 'cr_contest_inspect_pdf',
      arguments: { pdf_path: 'contests/mcp-round.pdf', protocol_preset: 'short' },
    }),
  );
  assertNoSecrets(pdfInspect.text);
  assert.equal(pdfInspect.data.ok, true);
  assert.equal(pdfInspect.data.info.page_count, 1);
  assert.deepEqual(pdfInspect.data.info.problem_ids, ['A']);
  assert.equal(pdfInspect.data.limits.ok, true);

  const traversalInspect = await client.callTool({
    name: 'cr_contest_inspect_pdf',
    arguments: { pdf_path: '../outside.pdf' },
  });
  assert.equal(traversalInspect.isError, true);

  // Symlink escape rejection
  await symlink('/etc/hosts', join(base, 'contests', 'evil-link.pdf'));
  const symlinkInspect = await client.callTool({
    name: 'cr_contest_inspect_pdf',
    arguments: { pdf_path: 'contests/evil-link.pdf' },
  });
  assert.equal(symlinkInspect.isError, true);

  // 6. cr_catalog_list for all 4 kinds (ZERO secret leakage!)
  for (const kind of ['agents', 'contests', 'providers', 'oj_accounts']) {
    const res = parseToolJson(await client.callTool({ name: 'cr_catalog_list', arguments: { kind } }));
    assertNoSecrets(res.text);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.total >= 1, `expected >= 1 item for ${kind}`);
  }

  // 7. cr_coverage_diff -> produces ready-to-use Batch Spec v2
  const covRes = parseToolJson(await client.callTool({ name: 'cr_coverage_diff', arguments: { min_repeats: 1 } }));
  assertNoSecrets(covRes.text);
  assert.equal(covRes.data.ok, true);
  assert.equal(covRes.data.total_gaps, 3); // 3 agents x 1 contest
  assert.equal(covRes.data.batch_spec.schema_version, 2);
  assert.equal(covRes.data.batch_spec.cells.length, 3);

  // 8. cr_plan_preview using the emitted Batch Spec v2 (and path traversal rejection)
  const previewRes = parseToolJson(
    await client.callTool({ name: 'cr_plan_preview', arguments: { spec: covRes.data.batch_spec } }),
  );
  assertNoSecrets(previewRes.text);
  assert.equal(previewRes.data.ok, true);
  assert.equal(previewRes.data.valid, true);
  assert.equal(previewRes.data.compatible_count, 3);
  assert.equal(previewRes.data.incompatible_count, 0);

  const badPlan = await client.callTool({
    name: 'cr_plan_preview',
    arguments: { spec: { schema_version: 2, cells: [{ agent: '../escape.toml', contest: 'contests/mcp-round.json' }] } },
  });
  assert.equal(badPlan.isError, true);
});

test('CLI automation --json subcommands, oj-account, push-target, coverage, pdf tools, and deterministic exit codes', async t => {
  const base = await makeTempDir(t, 'cr-cli-auto-base-');
  const root = await makeTempDir(t, 'cr-cli-auto-root-');
  const connDir = await makeTempDir(t, 'cr-cli-auto-conn-');
  const ojDir = await makeTempDir(t, 'cr-cli-auto-oj-');
  const pushDir = await makeTempDir(t, 'cr-cli-auto-push-');
  await chmod(connDir, 0o700);
  await chmod(ojDir, 0o700);
  await chmod(pushDir, 0o700);

  const env = {
    ...process.env,
    CR_CONNECTIONS_DIR: connDir,
    CR_OJ_ACCOUNTS_DIR: ojDir,
    CR_PUSH_TARGETS_DIR: pushDir,
    CR_CREDENTIAL_STORAGE: 'file',
  };
  delete env.OPENAI_API_KEY;

  const runCli = (args, input) =>
    spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', env, input });
  const runCliAsync = (args, input) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, ['dist/cli.js', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', rejectPromise);
      child.once('close', status => resolvePromise({ status, stdout, stderr }));
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });

  // 1. cr schema export --target batch
  const schemaOut = runCli(['schema', 'export', '--target', 'batch']);
  assert.equal(schemaOut.status, 0, schemaOut.stderr);
  const schemaJson = JSON.parse(schemaOut.stdout);
  assert.equal(schemaJson.target, 'batch');
  assert.ok(schemaJson.schemas.batch);

  // Validation error exit code 3 + uniform --json error envelope
  const badTarget = runCli(['schema', 'export', '--target', 'nope', '--json']);
  assert.equal(badTarget.status, 3);
  const badTargetJson = JSON.parse(badTarget.stdout);
  assert.equal(badTargetJson.ok, false);
  assert.equal(badTargetJson.code, 'validation_error');

  // Missing credential exit code 4 + uniform --json error envelope
  const missingCred = runCli(['bench', 'run', 'examples/demo/contest.json', '--agent', 'examples/demo/agent.json', '--json']);
  assert.equal(missingCred.status, 4);
  const missingCredJson = JSON.parse(missingCred.stdout);
  assert.equal(missingCredJson.ok, false);
  assert.equal(missingCredJson.code, 'missing_credential');

  // 2. cr contest synth-pdf + cr contest inspect-pdf
  const synthSpecPath = join(base, 'synth-spec.json');
  const pdfOutPath = join(base, 'generated.pdf');
  await writeFile(
    synthSpecPath,
    JSON.stringify({
      title: 'CLI Synth Round',
      problems: [
        { id: 'A', title: 'Sum', body: 'Print a + b.' },
        { id: 'B', title: 'Prod', body: 'Print a * b.' },
      ],
    }),
  );
  const synthRes = runCli(['contest', 'synth-pdf', synthSpecPath, '--out', pdfOutPath, '--json']);
  assert.equal(synthRes.status, 0, synthRes.stdout + synthRes.stderr);
  const synthJson = JSON.parse(synthRes.stdout);
  assert.equal(synthJson.ok, true);
  assert.deepEqual(synthJson.problem_ids, ['A', 'B']);

  const inspectRes = runCli(['contest', 'inspect-pdf', pdfOutPath, '--preset', 'short', '--json']);
  assert.equal(inspectRes.status, 0, inspectRes.stdout + inspectRes.stderr);
  const inspectJson = JSON.parse(inspectRes.stdout);
  assert.equal(inspectJson.ok, true);
  assert.deepEqual(inspectJson.info.problem_ids, ['A', 'B']);

  // 3. Setup provider + cr agent batch-apply + cr contest batch-import + cr coverage --emit-spec
  const addProv = runCli(
    ['provider', 'add', 'p-cli', '--protocol', 'responses', '--base-url', 'https://api.openai.com/v1', '--secret-stdin'],
    'sk-cli-secret-111111',
  );
  assert.equal(addProv.status, 0, addProv.stderr);

  const agentsSpecPath = join(base, 'agents-batch.json');
  await writeFile(
    agentsSpecPath,
    JSON.stringify([
      {
        format: 'toml',
        document: {
          kind: 'contestreplay.dev/agent',
          schema_version: 1,
          id: 'cli-agent',
          model: 'gpt-5.3-codex',
          provider: 'p-cli',
          harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium' } },
        },
      },
    ]),
  );
  const applyAgents = runCli(['agent', 'batch-apply', agentsSpecPath, '--base', base, '--json']);
  assert.equal(applyAgents.status, 0, applyAgents.stdout + applyAgents.stderr);
  assert.equal(JSON.parse(applyAgents.stdout).created, 1);

  const contestsSpecPath = join(base, 'contests-batch.json');
  await writeFile(
    contestsSpecPath,
    JSON.stringify([
      {
        document: {
          schema_version: 2,
          contest_id: 'cli-round',
          data_version: 1,
          title: 'CLI Round',
          source: { name: 'CLI' },
          judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
        },
        synth_problems: [{ id: 'A', title: 'One', body: 'Print 1.' }],
      },
    ]),
  );
  const importContests = runCli(['contest', 'batch-import', contestsSpecPath, '--workspace', root, '--base', base, '--json']);
  assert.equal(importContests.status, 0, importContests.stdout + importContests.stderr);
  assert.equal(JSON.parse(importContests.stdout).created, 1);

  const covEmit = runCli(['coverage', '--workspace', root, '--base', base, '--emit-spec']);
  assert.equal(covEmit.status, 0, covEmit.stderr);
  const emittedSpec = JSON.parse(covEmit.stdout);
  assert.equal(emittedSpec.schema_version, 2);
  assert.equal(emittedSpec.cells.length, 1);
  assert.equal(emittedSpec.cells[0].agent, 'agents/cli-agent.toml');
  assert.equal(emittedSpec.cells[0].contest, 'contests/cli-round.json');

  // 4. cr oj-account add / list / rotate / remove (never echoes secret!)
  const OJ_SECRET_1 = 'JSESSIONID=CLI_OJ_SECRET_1';
  const OJ_SECRET_2 = 'JSESSIONID=CLI_OJ_SECRET_2';
  const ojAdd = runCli(
    ['oj-account', 'add', 'cf1', '--platform', 'codeforces', '--handle', 'bot1', '--pool', 'main', '--secret-stdin', '--json'],
    OJ_SECRET_1,
  );
  assert.equal(ojAdd.status, 0, ojAdd.stdout + ojAdd.stderr);
  assert.ok(!ojAdd.stdout.includes(OJ_SECRET_1) && !ojAdd.stderr.includes(OJ_SECRET_1));
  assert.equal(JSON.parse(ojAdd.stdout).account.id, 'cf1');

  const ojList = runCli(['oj-account', 'list', '--platform', 'codeforces', '--json']);
  assert.equal(ojList.status, 0, ojList.stderr);
  assert.ok(!ojList.stdout.includes(OJ_SECRET_1));
  assert.equal(JSON.parse(ojList.stdout).accounts.length, 1);

  const ojRot = runCli(['oj-account', 'rotate', 'cf1', '--secret-stdin', '--json'], OJ_SECRET_2);
  assert.equal(ojRot.status, 0, ojRot.stdout + ojRot.stderr);
  assert.ok(!ojRot.stdout.includes(OJ_SECRET_2));

  const ojRem = runCli(['oj-account', 'remove', 'cf1', '--json']);
  assert.equal(ojRem.status, 0, ojRem.stdout + ojRem.stderr);
  assert.equal(JSON.parse(ojRem.stdout).removed, 'cf1');

  // 5. cr push-target add / list / rotate / test / remove (with real loopback HMAC receiver)
  const received = [];
  const webhookServer = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(resolveListen => webhookServer.listen(0, '127.0.0.1', resolveListen));
  t.after(() => webhookServer.close());
  const port = webhookServer.address().port;

  const PUSH_SECRET_1 = 'whsec_initial_secret_12345';
  const PUSH_SECRET_2 = 'whsec_rotated_secret_67890';
  const pushAdd = runCli(
    [
      'push-target', 'add', 'hook1',
      '--url', `http://127.0.0.1:${port}/webhook`,
      '--events', 'run.completed,batch.completed',
      '--auth', 'hmac-sha256',
      '--secret-stdin',
      '--json',
    ],
    PUSH_SECRET_1,
  );
  assert.equal(pushAdd.status, 0, pushAdd.stdout + pushAdd.stderr);
  assert.ok(!pushAdd.stdout.includes(PUSH_SECRET_1));

  const pushRot = runCli(['push-target', 'rotate', 'hook1', '--secret-stdin', '--json'], PUSH_SECRET_2);
  assert.equal(pushRot.status, 0, pushRot.stdout + pushRot.stderr);
  assert.ok(!pushRot.stdout.includes(PUSH_SECRET_2));

  const pushTest = await runCliAsync(['push-target', 'test', 'hook1', '--json']);
  assert.equal(pushTest.status, 0, pushTest.stdout + pushTest.stderr);
  const pushTestJson = JSON.parse(pushTest.stdout);
  assert.equal(pushTestJson.ok, true);
  assert.equal(pushTestJson.delivery.status, 'delivered');
  assert.equal(received.length, 1);
  assert.equal(
    verifyPushSignature(
      PUSH_SECRET_2,
      received[0].body,
      received[0].headers['x-cr-timestamp'],
      received[0].headers['x-cr-signature-256'],
    ),
    true,
  );

  const pushList = runCli(['push-target', 'list', '--json']);
  assert.equal(pushList.status, 0);
  assert.equal(JSON.parse(pushList.stdout).targets.length, 1);

  const pushRem = runCli(['push-target', 'remove', 'hook1', '--json']);
  assert.equal(pushRem.status, 0);
  assert.equal(JSON.parse(pushRem.stdout).removed, 'hook1');
});

test('MCP zero-secret-read catalog, symlinked base validation, write prefix & overwrite guards, and cr_plan_preview parity', async t => {
  const prevStorage = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  t.after(() => {
    if (prevStorage === undefined) delete process.env.CR_CREDENTIAL_STORAGE;
    else process.env.CR_CREDENTIAL_STORAGE = prevStorage;
  });

  const realBase = await makeTempDir(t, 'cr-mcp-hard-base-');
  const linkHolder = await makeTempDir(t, 'cr-mcp-hard-link-');
  const outsideDir = await makeTempDir(t, 'cr-mcp-hard-out-');
  const root = await makeTempDir(t, 'cr-mcp-hard-root-');
  const connDir = await makeTempDir(t, 'cr-mcp-hard-conn-');
  const ojDir = await makeTempDir(t, 'cr-mcp-hard-oj-');
  await chmod(connDir, 0o700);
  await chmod(ojDir, 0o700);

  const symBase = join(linkHolder, 'ws-link');
  await symlink(realBase, symBase);

  const store = new Connections(connDir);
  await store.create({
    id: 'p-locked',
    label: 'Locked Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-locked-secret-0000',
    supports_fast: true,
  });

  const ojAccounts = new OjAccounts(ojDir);
  await ojAccounts.create({
    id: 'cf-locked',
    label: 'Locked OJ',
    platform: 'codeforces',
    handle: 'locked_bot',
    pool: 'locked-pool',
    transport: 'cookie',
    secret: 'JSESSIONID=LOCKED_SECRET_0000',
  });

  // Lock down ALL credential secret files to mode 0o000 (skip assertion only if running as root uid 0).
  const lockedPaths = [];
  for (const dir of [join(connDir, 'credentials'), join(ojDir, 'credentials')]) {
    const files = await readdir(dir);
    assert.ok(files.length >= 1, `expected credential file in ${dir}`);
    for (const f of files) {
      const full = join(dir, f);
      await chmod(full, 0o000);
      lockedPaths.push(full);
    }
  }
  t.after(async () => {
    for (const p of lockedPaths) {
      await chmod(p, 0o600).catch(() => {});
    }
  });

  const server = createWorkbenchMcpServer({
    base: symBase,
    root,
    store,
    ojAccounts,
    useExternalPdfTools: false,
  });
  const client = new Client({ name: 'test-hardening-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // 1. cr_catalog_list (providers & oj_accounts) succeeds EVEN WITH 0o000 secret files -> ZERO secret reads!
  const provList = parseToolJson(await client.callTool({ name: 'cr_catalog_list', arguments: { kind: 'providers' } }));
  assert.equal(provList.data.ok, true);
  assert.equal(provList.data.total, 1);
  assert.equal(provList.data.items[0].id, 'p-locked');
  assert.ok(!provList.text.includes('sk-locked-secret-0000'));

  const ojList = parseToolJson(await client.callTool({ name: 'cr_catalog_list', arguments: { kind: 'oj_accounts' } }));
  assert.equal(ojList.data.ok, true);
  assert.equal(ojList.data.total, 1);
  assert.equal(ojList.data.items[0].id, 'cf-locked');
  assert.ok(!ojList.text.includes('LOCKED_SECRET_0000'));

  // 2. cr_agent_validate works under symlinked base and rejects escaping native_config.path
  const validAgentDoc = {
    kind: 'contestreplay.dev/agent',
    schema_version: 1,
    id: 'sym-val-agent',
    model: 'gpt-5.3-codex',
    provider: 'p-locked',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'medium' } },
  };
  const valSym = parseToolJson(await client.callTool({ name: 'cr_agent_validate', arguments: { document: validAgentDoc } }));
  assert.equal(valSym.data.ok, true);
  assert.equal(valSym.data.valid, true);

  const outNativeText = 'model_verbosity = "low"\n';
  await writeFile(join(outsideDir, 'escape-native.toml'), outNativeText);
  const relEscNative = relative(join(realBase, 'agents'), join(outsideDir, 'escape-native.toml'));
  const valEsc = await client.callTool({
    name: 'cr_agent_validate',
    arguments: {
      document: {
        ...validAgentDoc,
        harness: {
          ...validAgentDoc.harness,
          native_config: { format: 'toml', path: relEscNative, sha256: sha256(outNativeText) },
        },
      },
    },
  });
  assert.equal(valEsc.isError, true);
  assert.equal(parseToolJson(valEsc).data.valid, false);

  // 3. cr_agent_batch_apply & cr_contest_batch_import restrict writes to agents/ & contests/ and refuse overwriting package.json / run.json
  const pkgBytes = '{"name":"do-not-touch"}\n';
  const runBytes = '{"schema_version":2,"run_id":"do-not-touch"}\n';
  await writeFile(join(realBase, 'package.json'), pkgBytes);
  await mkdir(join(realBase, 'agents'), { recursive: true });
  await writeFile(join(realBase, 'agents', 'run.json'), runBytes);
  await mkdir(join(realBase, 'contests'), { recursive: true });
  await writeFile(join(realBase, 'contests', 'package.json'), pkgBytes);

  const badAgentDir = await client.callTool({
    name: 'cr_agent_batch_apply',
    arguments: { items: [{ file: 'other/a.toml', format: 'toml', document: validAgentDoc }], dry_run: false },
  });
  assert.equal(badAgentDir.isError, true);
  assert.match(parseToolJson(badAgentDir).text, /approved directory/i);

  const badAgentOverwrite = await client.callTool({
    name: 'cr_agent_batch_apply',
    arguments: {
      items: [{ file: 'agents/run.json', format: 'json', document: validAgentDoc }],
      dry_run: false,
      if_exists: 'overwrite',
    },
  });
  assert.equal(badAgentOverwrite.isError, true);
  assert.equal(await readFile(join(realBase, 'agents', 'run.json'), 'utf8'), runBytes);

  const badContestDir = await client.callTool({
    name: 'cr_contest_batch_import',
    arguments: {
      items: [{
        file: 'other/c.json',
        document: {
          schema_version: 2,
          contest_id: 'c-other',
          data_version: 1,
          title: 'Other',
          source: { name: 'X' },
          judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
        },
        synth_problems: [{ id: 'A', title: 'A', body: 'A' }],
      }],
      dry_run: false,
    },
  });
  assert.equal(badContestDir.isError, true);
  assert.match(parseToolJson(badContestDir).text, /approved directory/i);

  const badContestOverwrite = await client.callTool({
    name: 'cr_contest_batch_import',
    arguments: {
      items: [{
        file: 'contests/package.json',
        document: {
          schema_version: 2,
          contest_id: 'c-pkg',
          data_version: 1,
          title: 'Pkg',
          source: { name: 'X' },
          judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
        },
        synth_problems: [{ id: 'A', title: 'A', body: 'A' }],
      }],
      dry_run: false,
      if_exists: 'overwrite',
    },
  });
  assert.equal(badContestOverwrite.isError, true);
  assert.equal(await readFile(join(realBase, 'contests', 'package.json'), 'utf8'), pkgBytes);

  // 4. cr_plan_preview parity: duplicate canonical paths, duplicate revisions, escaping transitive paths, and isError on incompatible (!valid)
  const applyAgents = await client.callTool({
    name: 'cr_agent_batch_apply',
    arguments: {
      items: [
        { file: 'agents/a1.toml', format: 'toml', document: validAgentDoc },
        { file: 'agents/a1-dup.toml', format: 'toml', document: validAgentDoc },
        {
          file: 'agents/builtin.toml',
          format: 'toml',
          document: {
            kind: 'contestreplay.dev/agent',
            schema_version: 1,
            id: 'builtin-agent',
            model: 'gpt-4.1-2025-04-14',
            provider: 'p-locked',
            harness: { kind: 'builtin-responses', version: '0.1.0', options: { temperature: 0 } },
          },
        },
      ],
      dry_run: false,
    },
  });
  assert.equal(parseToolJson(applyAgents).data.ok, true);

  // Write a Codeforces contest and a local contest
  const importContests = await client.callTool({
    name: 'cr_contest_batch_import',
    arguments: {
      items: [
        {
          file: 'contests/local-c.json',
          document: {
            schema_version: 2,
            contest_id: 'local-c',
            data_version: 1,
            title: 'Local C',
            source: { name: 'Local' },
            judge: { kind: 'local', problems: [{ id: 'A', max_points: 100, accepted_answers: ['1'] }] },
          },
          synth_problems: [{ id: 'A', title: 'A', body: 'Solve A.' }],
        },
        {
          file: 'contests/cf-c.json',
          document: {
            schema_version: 2,
            contest_id: 'cf-c',
            data_version: 1,
            title: 'CF C',
            source: { name: 'CF' },
            problems: [{ id: 'A', max_points: 500 }],
            judge: { kind: 'codeforces', contest_id: 1999, handle: 'bot', languages: { cpp20: 89 } },
          },
          synth_problems: [{ id: 'A', title: 'A', body: 'Solve A.' }],
        },
      ],
      dry_run: false,
    },
  });
  assert.equal(parseToolJson(importContests).data.ok, true);

  // 4a. Duplicate canonical path (agents/a1.toml vs ./agents/a1.toml)
  const dupCanon = await client.callTool({
    name: 'cr_plan_preview',
    arguments: {
      spec: {
        schema_version: 1,
        agents: ['agents/a1.toml', './agents/a1.toml'],
        contests: ['contests/local-c.json'],
      },
    },
  });
  assert.equal(dupCanon.isError, true);
  assert.match(parseToolJson(dupCanon).text, /Duplicate input paths/i);

  // 4b. Duplicate revision across distinct files (agents/a1.toml & agents/a1-dup.toml)
  const dupRev = await client.callTool({
    name: 'cr_plan_preview',
    arguments: {
      spec: {
        schema_version: 1,
        agents: ['agents/a1.toml', 'agents/a1-dup.toml'],
        contests: ['contests/local-c.json'],
      },
    },
  });
  assert.equal(dupRev.isError, true);
  assert.match(parseToolJson(dupRev).text, /Duplicate Agent revision/i);

  // 4c. Escaping transitive path inside a contest manifest on disk (materials.attachments[].path escaping base)
  await writeFile(join(outsideDir, 'outside-att.txt'), 'secret outside');
  await writeFile(
    join(realBase, 'contests', 'esc-att.json'),
    JSON.stringify({
      schema_version: 2,
      contest_id: 'esc-att',
      data_version: 1,
      title: 'Escaping Attachment',
      source: { name: 'Local' },
      materials: {
        entrypoint: { kind: 'pdf', path: 'local-c.pdf' },
        attachments: [{ name: 'out.txt', path: relative(join(realBase, 'contests'), join(outsideDir, 'outside-att.txt')) }],
      },
      judge: { kind: 'local', answers: { path: 'local-c.judge.json' } },
    }),
  );
  const escTransitive = await client.callTool({
    name: 'cr_plan_preview',
    arguments: {
      spec: {
        schema_version: 2,
        cells: [{ agent: 'agents/a1.toml', contest: 'contests/esc-att.json' }],
      },
    },
  });
  assert.equal(escTransitive.isError, true);
  assert.match(parseToolJson(escTransitive).text, /must stay inside workspace base/i);

  // 4d. Incompatible cell (builtin-responses x codeforces) returns valid: false AND isError: true!
  const incompat = await client.callTool({
    name: 'cr_plan_preview',
    arguments: {
      spec: {
        schema_version: 2,
        cells: [{ agent: 'agents/builtin.toml', contest: 'contests/cf-c.json' }],
      },
    },
  });
  assert.equal(incompat.isError, true);
  const incompatData = parseToolJson(incompat).data;
  assert.equal(incompatData.ok, false);
  assert.equal(incompatData.valid, false);
  assert.equal(incompatData.incompatible_count, 1);
});

test('cr mcp stdio E2E returns pure JSON-RPC on stdout, empty stderr, and exits cleanly on stdin EOF', async t => {
  const base = await makeTempDir(t, 'cr-mcp-stdio-base-');
  const root = await makeTempDir(t, 'cr-mcp-stdio-root-');
  const connDir = await makeTempDir(t, 'cr-mcp-stdio-conn-');
  const ojDir = await makeTempDir(t, 'cr-mcp-stdio-oj-');
  await chmod(connDir, 0o700);
  await chmod(ojDir, 0o700);

  const env = {
    ...process.env,
    CR_CONNECTIONS_DIR: connDir,
    CR_OJ_ACCOUNTS_DIR: ojDir,
    CR_CREDENTIAL_STORAGE: 'file',
  };

  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['dist/cli.js', 'mcp', '--workspace', root, '--base', base], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sentList = false;
    let closedStdin = false;

    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && !sentList) {
          sentList = true;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2 && !closedStdin) {
          closedStdin = true;
          child.stdin.end();
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'stdio-e2e', version: '1.0.0' },
        },
      }) + '\n',
    );
  });

  assert.equal(result.code, 0, `expected exit 0, got code=${result.code} signal=${result.signal} stderr=${result.stderr}`);
  assert.equal(result.stderr, '', `expected empty stderr, got: ${result.stderr}`);

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 2, `expected >=2 JSON-RPC lines, got ${lines.length}`);
  const parsedMessages = lines.map(line => JSON.parse(line));
  const initResp = parsedMessages.find(m => m.id === 1);
  const listResp = parsedMessages.find(m => m.id === 2);
  assert.equal(initResp.result.serverInfo.name, 'contestreplay-workbench');
  assert.ok(listResp.result.tools.some(tool => tool.name === 'cr_catalog_list'));
});

test('CLI deterministic exit codes for missing args, unknown commands/flags, --secret-stdin=val, 0-gap emit-spec, and inspect-pdf exit alignment', async t => {
  const base = await makeTempDir(t, 'cr-cli-err-base-');
  const root = await makeTempDir(t, 'cr-cli-err-root-');
  const connDir = await makeTempDir(t, 'cr-cli-err-conn-');
  const ojDir = await makeTempDir(t, 'cr-cli-err-oj-');
  await chmod(connDir, 0o700);
  await chmod(ojDir, 0o700);

  const env = {
    ...process.env,
    CR_CONNECTIONS_DIR: connDir,
    CR_OJ_ACCOUNTS_DIR: ojDir,
    CR_CREDENTIAL_STORAGE: 'file',
  };
  const runCli = (args, input) =>
    spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', env, input });

  // 1. Missing positional arg -> exit 3 (validation_error)
  const missingPos = runCli(['agent', 'batch-apply', '--json']);
  assert.equal(missingPos.status, 3, missingPos.stdout + missingPos.stderr);
  assert.equal(JSON.parse(missingPos.stdout).code, 'validation_error');

  // 2. Unknown command -> exit 3 (validation_error)
  const unknownCmd = runCli(['bogus-cmd', '--json']);
  assert.equal(unknownCmd.status, 3, unknownCmd.stdout + unknownCmd.stderr);
  assert.equal(JSON.parse(unknownCmd.stdout).code, 'validation_error');

  // 3. Unknown flag -> exit 3 (validation_error)
  const unknownFlag = runCli(['coverage', '--bogus', '--json']);
  assert.equal(unknownFlag.status, 3, unknownFlag.stdout + unknownFlag.stderr);
  assert.equal(JSON.parse(unknownFlag.stdout).code, 'validation_error');

  // 4. --secret-stdin=LEAKED_VALUE -> exit 3 (validation_error), NOT 4 or 1, and NEVER echoes LEAKED_VALUE!
  const SECRET_FLAG_VAL = 'DO_NOT_ECHO_CLI_ARG_99999';
  const badSecretFlag = runCli([
    'oj-account', 'add', 'x', '--platform', 'codeforces', '--handle', 'h', `--secret-stdin=${SECRET_FLAG_VAL}`, '--json',
  ]);
  assert.equal(badSecretFlag.status, 3, badSecretFlag.stdout + badSecretFlag.stderr);
  const badSecretJson = JSON.parse(badSecretFlag.stdout);
  assert.equal(badSecretJson.ok, false);
  assert.equal(badSecretJson.code, 'validation_error');
  assert.ok(!badSecretFlag.stdout.includes(SECRET_FLAG_VAL));
  assert.ok(!badSecretFlag.stderr.includes(SECRET_FLAG_VAL));

  // 5. cr coverage --emit-spec with 0 gaps handles batch_spec === null cleanly
  const covZeroJson = runCli(['coverage', '--workspace', root, '--base', base, '--emit-spec', '--json']);
  assert.equal(covZeroJson.status, 0, covZeroJson.stdout + covZeroJson.stderr);
  const covZeroParsed = JSON.parse(covZeroJson.stdout);
  assert.equal(covZeroParsed.ok, true);
  assert.equal(covZeroParsed.total_gaps, 0);
  assert.equal(covZeroParsed.batch_spec, null);

  const covZeroPlain = runCli(['coverage', '--workspace', root, '--base', base, '--emit-spec']);
  assert.equal(covZeroPlain.status, 0, covZeroPlain.stdout + covZeroPlain.stderr);
  assert.equal(JSON.parse(covZeroPlain.stdout), null);

  // 6. cr contest inspect-pdf --json aligns exit code with ok (even when limits.ok is false -> ok: true, exit 0; missing file -> ok: false, non-zero)
  const bigPdfPath = join(base, 'many-pages.pdf');
  const manyProblems = Array.from({ length: 40 }, (_, idx) => ({
    id: `P${idx + 1}`,
    title: `Problem ${idx + 1}`,
    body: 'Repeat line\n'.repeat(60),
  }));
  await synthesizeTextContestPdf(manyProblems, bigPdfPath, { title: 'Long PDF' });
  const overLimit = runCli(['contest', 'inspect-pdf', bigPdfPath, '--preset', 'short', '--json']);
  assert.equal(overLimit.status, 0, overLimit.stdout + overLimit.stderr);
  const overLimitJson = JSON.parse(overLimit.stdout);
  assert.equal(overLimitJson.ok, true);
  assert.equal(overLimitJson.limits.ok, false);

  const missingPdf = runCli(['contest', 'inspect-pdf', join(base, 'does-not-exist.pdf'), '--json']);
  assert.notEqual(missingPdf.status, 0);
  assert.equal(JSON.parse(missingPdf.stdout).ok, false);

  // 7. cr bench run (no args), cr bench run contest.json --json (missing --agent), and cr studio --port 99999 --json all exit 3!
  const benchNoArgs = runCli(['bench', 'run', '--json']);
  assert.equal(benchNoArgs.status, 3, benchNoArgs.stdout + benchNoArgs.stderr);
  assert.equal(JSON.parse(benchNoArgs.stdout).code, 'validation_error');

  const benchNoArgsPlain = runCli(['bench', 'run']);
  assert.equal(benchNoArgsPlain.status, 3, benchNoArgsPlain.stdout + benchNoArgsPlain.stderr);

  const benchMissingAgent = runCli(['bench', 'run', 'examples/demo/contest.json', '--json']);
  assert.equal(benchMissingAgent.status, 3, benchMissingAgent.stdout + benchMissingAgent.stderr);
  assert.equal(JSON.parse(benchMissingAgent.stdout).code, 'validation_error');

  const studioBadPort = runCli(['studio', '--port', '99999', '--json']);
  assert.equal(studioBadPort.status, 3, studioBadPort.stdout + studioBadPort.stderr);
  assert.equal(JSON.parse(studioBadPort.stdout).code, 'validation_error');

  // 8. Malformed automation JSON input files return fixed diagnostic without echoing private text!
  const SECRET_EXCERPT = 'PRIVATE_MALFORMED_SECRET_TEXT_77777';
  const badJsonPath = join(base, 'malformed.json');
  await writeFile(badJsonPath, `{ invalid json ${SECRET_EXCERPT} `);
  for (const cmdArgs of [
    ['agent', 'batch-apply', badJsonPath, '--base', base, '--json'],
    ['agent', 'variants', badJsonPath, '--base', base, '--json'],
    ['contest', 'batch-import', badJsonPath, '--workspace', root, '--base', base, '--json'],
    ['contest', 'synth-pdf', badJsonPath, '--out', join(base, 'never.pdf'), '--json'],
  ]) {
    const res = runCli(cmdArgs);
    assert.equal(res.status, 3, `${cmdArgs.join(' ')}: ${res.stdout}${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'validation_error');
    assert.equal(parsed.error, 'Invalid JSON input file');
    assert.ok(!res.stdout.includes(SECRET_EXCERPT), `Leaked private text for ${cmdArgs.join(' ')}`);
    assert.ok(!res.stderr.includes(SECRET_EXCERPT), `Leaked private text on stderr for ${cmdArgs.join(' ')}`);
  }
});

test('MCP cr_catalog_list invokes 0 secret methods via prototype spy, and cr_plan_preview blocks forbidden filenames, content-based judge attachments, and malformed JSON leakage', async t => {
  const prevStorage = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  t.after(() => {
    if (prevStorage === undefined) delete process.env.CR_CREDENTIAL_STORAGE;
    else process.env.CR_CREDENTIAL_STORAGE = prevStorage;
  });

  const base = await makeTempDir(t, 'cr-mcp-spy-base-');
  const root = await makeTempDir(t, 'cr-mcp-spy-root-');
  const connDir = await makeTempDir(t, 'cr-mcp-spy-conn-');
  const ojDir = await makeTempDir(t, 'cr-mcp-spy-oj-');
  await chmod(connDir, 0o700);
  await chmod(ojDir, 0o700);

  const store = new Connections(connDir);
  await store.create({
    id: 'p-spy',
    label: 'Spy Provider',
    protocol: 'responses',
    base_url: 'https://api.openai.com/v1',
    secret: 'sk-spy-secret-0000',
  });

  const ojAccounts = new OjAccounts(ojDir);
  await ojAccounts.create({
    id: 'cf-spy',
    label: 'Spy OJ',
    platform: 'codeforces',
    handle: 'spy_bot',
    pool: 'spy-pool',
    transport: 'cookie',
    secret: 'JSESSIONID=SPY_SECRET_0000',
  });

  const server = createWorkbenchMcpServer({
    base,
    root,
    store,
    ojAccounts,
    useExternalPdfTools: false,
  });
  const client = new Client({ name: 'test-spy-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // 1. Prototype call-counter spy proving 0 calls to secret/status-probing methods during cr_catalog_list!
  const spyCounts = {
    ojResolveSecret: 0,
    ojGet: 0,
    ojList: 0,
    connKey: 0,
    connProvider: 0,
    connListProviders: 0,
  };
  const origOjResolveSecret = OjAccounts.prototype.resolveSecret;
  const origOjGet = OjAccounts.prototype.get;
  const origOjList = OjAccounts.prototype.list;
  const origConnKey = Connections.prototype.key;
  const origConnProvider = Connections.prototype.provider;
  const origConnListProviders = Connections.prototype.listProviders;

  OjAccounts.prototype.resolveSecret = function (...args) {
    spyCounts.ojResolveSecret++;
    return origOjResolveSecret.apply(this, args);
  };
  OjAccounts.prototype.get = function (...args) {
    spyCounts.ojGet++;
    return origOjGet.apply(this, args);
  };
  OjAccounts.prototype.list = function (...args) {
    spyCounts.ojList++;
    return origOjList.apply(this, args);
  };
  Connections.prototype.key = function (...args) {
    spyCounts.connKey++;
    return origConnKey.apply(this, args);
  };
  Connections.prototype.provider = function (...args) {
    spyCounts.connProvider++;
    return origConnProvider.apply(this, args);
  };
  Connections.prototype.listProviders = function (...args) {
    spyCounts.connListProviders++;
    return origConnListProviders.apply(this, args);
  };

  try {
    for (const kind of ['providers', 'oj_accounts', 'agents', 'contests']) {
      const res = parseToolJson(await client.callTool({ name: 'cr_catalog_list', arguments: { kind } }));
      assert.equal(res.data.ok, true);
    }
    assert.deepEqual(spyCounts, {
      ojResolveSecret: 0,
      ojGet: 0,
      ojList: 0,
      connKey: 0,
      connProvider: 0,
      connListProviders: 0,
    });
  } finally {
    OjAccounts.prototype.resolveSecret = origOjResolveSecret;
    OjAccounts.prototype.get = origOjGet;
    OjAccounts.prototype.list = origOjList;
    Connections.prototype.key = origConnKey;
    Connections.prototype.provider = origConnProvider;
    Connections.prototype.listProviders = origConnListProviders;
  }

  // 2. cr_plan_preview rejects judge.json / package.json as contest or attachment, rejects disguised judge attachments, and sanitizes malformed JSON!
  await mkdir(join(base, 'agents'), { recursive: true });
  await mkdir(join(base, 'contests'), { recursive: true });
  await writeFile(
    join(base, 'agents', 'a1.json'),
    JSON.stringify({
      kind: 'contestreplay.dev/agent',
      schema_version: 1,
      id: 'a1',
      model: 'gpt-5.3-codex',
      provider: 'p-spy',
      harness: { kind: 'codex', version: '0.170.0', options: {} },
    }),
  );
  await synthesizeTextContestPdf(
    [{ id: 'A', title: 'Alpha', body: 'Solve A.' }],
    join(base, 'contests', 'p.pdf'),
    { title: 'P' },
  );
  const judgeBody = JSON.stringify({
    schema_version: 1,
    problems: [{ id: 'A', max_points: 100, accepted_answers: ['42'] }],
  });
  await writeFile(join(base, 'contests', 'judge.json'), judgeBody);
  await writeFile(join(base, 'contests', 'package.json'), '{"name":"pkg"}');
  await writeFile(join(base, 'contests', 'disguised.txt'), judgeBody);

  // 2a. Top-level judge.json / package.json rejected
  for (const badContest of ['contests/judge.json', 'contests/package.json']) {
    const res = await client.callTool({
      name: 'cr_plan_preview',
      arguments: { spec: { schema_version: 2, cells: [{ agent: 'agents/a1.json', contest: badContest }] } },
    });
    assert.equal(res.isError, true, `expected ${badContest} to be rejected in cr_plan_preview`);
  }

  // 2b. judge.json, package.json, and disguised.txt rejected as attachments in cr_plan_preview
  for (const att of ['judge.json', 'package.json', 'disguised.txt']) {
    const manifestName = `contests/bad-att-${att.replace(/\./g, '-')}.json`;
    await writeFile(
      join(base, manifestName),
      JSON.stringify({
        schema_version: 2,
        contest_id: 'bad-att',
        data_version: 1,
        title: 'Bad Att',
        source: { name: 'Local' },
        materials: {
          entrypoint: { kind: 'pdf', path: 'p.pdf' },
          attachments: [{ name: 'att.dat', path: att }],
        },
        judge: { kind: 'local', answers: { path: 'judge.json' } },
      }),
    );
    const res = await client.callTool({
      name: 'cr_plan_preview',
      arguments: { spec: { schema_version: 2, cells: [{ agent: 'agents/a1.json', contest: manifestName }] } },
    });
    assert.equal(res.isError, true, `expected attachment ${att} to be rejected in cr_plan_preview`);
  }

  // 2c. Malformed JSON in cr_plan_preview MUST NOT echo private file text!
  const SECRET_LINE = 'TOP_SECRET_MALFORMED_CONTEST_LINE_54321';
  await writeFile(join(base, 'contests', 'broken.json'), `{ broken json ${SECRET_LINE} `);
  const brokenRes = await client.callTool({
    name: 'cr_plan_preview',
    arguments: { spec: { schema_version: 2, cells: [{ agent: 'agents/a1.json', contest: 'contests/broken.json' }] } },
  });
  assert.equal(brokenRes.isError, true);
  const brokenText = parseToolJson(brokenRes).text;
  assert.ok(!brokenText.includes(SECRET_LINE), 'Leaked raw malformed JSON content in cr_plan_preview!');
  assert.match(brokenText, /Invalid JSON: contests\/broken\.json/);
});
