import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Connections } from '../dist/connections.js';
import { createWorkbenchMcpServer } from '../dist/mcp-server.js';
import { OjAccounts } from '../dist/oj-accounts.js';
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
