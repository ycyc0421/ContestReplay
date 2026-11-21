import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadInputs } from '../dist/config.js';
import { match } from '../dist/match.js';
import { cfForm, cfReceipt } from '../dist/cf-web.js';
import { exactPracticeCandidates } from '../dist/codeforces.js';
import { exportRun, mergeResults, rankResults } from '../dist/results.js';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { assertCompatible } from '../dist/plan.js';
import { checkChatOrMessagesRequest, checkModelRequest, checkResponsesCompactRequest, resolveRelayTarget, serveContestChannels } from '../dist/codex.js';
import { streamSessions } from '../dist/bridge.js';
import { protocolForPreset } from '../dist/protocol.js';

test('program judge stays pending without blocking and settles against the received timestamp', async () => {
  const inputs = await loadInputs('examples/demo/contest.json', 'examples/demo/codex.toml');
  inputs.contest.judge = { kind: 'codeforces', contest_id: 4, languages: { cpp17: 54 } };
  let now = 0;
  let ready = false;
  const events = [];
  const fake = { submit: async () => 321, verdicts: async () => ready ? new Map([[321, 'OK']]) : new Map() };
  const m = match(inputs, e => events.push({ elapsed: now, ...e }), fake, () => now, 10);
  assert.throws(() => assertCompatible('builtin-responses', inputs.contest, 'baseline'), /Incompatible cell/);
  try {
    now = 17;
    assert.deepEqual(m.submit({ problem_id: '1', language: 'cpp17', source: 'int main(){}' }), { submission_id: 's1', verdict: 'pending' });
    assert.deepEqual(m.status('s1'), { submission_id: 's1', verdict: 'pending' });
    m.close();
    assert.equal(m.submit({ problem_id: '1', language: 'cpp17', source: 'int main(){}' }).verdict, 'contest_closed');
    now = 40;
    ready = true;
    await m.settle(AbortSignal.timeout(1000));
    assert.equal(m.score(), 3);
    assert.equal(events.find(e => e.type === 'submission_received').elapsed, 17);
    assert.equal(events.find(e => e.type === 'submission_judged').remote_submission_id, 321);
  } finally { await m.dispose(); }
});

test('Codeforces requires intended form and matches post-baseline Practice rows', () => {
  const markup = '<a href="/profile/cr-test">cr-test</a><form action="/contest/4/submit"><input type="hidden" name="csrf_token" value="fixture"><select name="submittedProblemIndex"></select><textarea name="source"></textarea></form>';
  assert.equal(cfForm(markup, 4, 'cr-test').fields.get('csrf_token'), 'fixture');
  assert.throws(() => cfForm(markup.replace('/contest/4/submit', 'https://example.com/contest/4/submit'), 4, 'cr-test'));
  assert.equal(cfReceipt('/contest/4/submission/99', 4), 99);
  assert.equal(cfReceipt('https://example.com/contest/4/submission/99', 4), undefined);
  const row = { id: 99, creationTimeSeconds: 50, contestId: 4, problem: { index: 'A' }, author: { participantType: 'PRACTICE', members: [{ handle: 'cr-test' }] } };
  assert.deepEqual(exactPracticeCandidates([row, { ...row, id: 97 }, { ...row, id: 100, contestId: 8 }],
    { baseline: 98, contest: 4, problem: 'A', since: 49, handle: 'cr-test' }), [99]);
});

test('relay rejects a different model and remote tools/files', () => {
  assert.throws(() => checkModelRequest({ model: 'other' }, 'expected'));
  assert.throws(() => checkModelRequest({ model: 'expected', tools: [{ type: 'web_search' }] }, 'expected'));
  assert.throws(() => checkModelRequest({ model: 'expected', input: [{ type: 'input_file', file_id: 'file-x' }] }, 'expected'));
  assert.equal(checkModelRequest({ model: 'expected', store: true }, 'expected').store, false);
});

test('relay enforces strict route/method/header/model allowlists, maps service_tier, handles SSE/disconnect races, and streams sessions via IPC', async t => {
  // Route normalization & anti-bypass checks
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/responses').target.href, 'https://api.openai.com/v1/responses');
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/responses/').subpath, '/responses');
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/Responses').subpath, '/responses');
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/%72esponses').subpath, '/responses');
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/responses/compact').subpath, '/responses/compact');
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/chat/completions?stream=true').target.href, 'https://api.openai.com/v1/chat/completions?stream=true');
  assert.equal(resolveRelayTarget('https://api.anthropic.com/v1', '/v1/messages').target.href, 'https://api.anthropic.com/v1/messages');
  // Protocol-specific route binding
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/responses', 'responses').subpath, '/responses');
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/chat/completions', 'responses'), /not allowed for provider protocol/);
  assert.throws(() => resolveRelayTarget('https://api.anthropic.com/v1', '/v1/responses', 'anthropic-messages'), /not allowed for provider protocol/);
  // Non-inference & traversal routes blocked
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/files'), /Unsupported model endpoint/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/batches'), /Unsupported model endpoint/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/models'), /Unsupported model endpoint/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/../responses'), /traversal/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/%2e%2e/responses'), /traversal/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/responses;foo=1'), /Invalid relay path/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '//evil.example/v1/responses'), /Invalid relay path/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', 'https://evil.example/v1/responses'), /Invalid relay path/);

  // Chat / Messages model & remote tool/file checks + cross-protocol key rejection + service_tier stripping
  assert.throws(() => checkChatOrMessagesRequest({ model: 'other', messages: [] }, 'expected', '/chat/completions'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', input: 'mixed', messages: [] }, 'expected', '/chat/completions'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', previous_response_id: 'r1', messages: [] }, 'expected', '/chat/completions'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', prompt: 'mixed', messages: [] }, 'expected', '/messages'));
  assert.throws(() => checkModelRequest({ model: 'expected', input: 'hi', messages: [] }, 'expected'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', web_search_options: {}, messages: [] }, 'expected', '/chat/completions'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', tools: [{ type: 'web_search' }], messages: [] }, 'expected', '/chat/completions'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://evil.test/x.png' } }] }] }, 'expected', '/chat/completions'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', mcp_servers: [], messages: [] }, 'expected', '/messages'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', tools: [{ type: 'web_search_20250305', name: 'ws' }], messages: [] }, 'expected', '/messages'));
  assert.throws(() => checkChatOrMessagesRequest({ model: 'expected', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://evil.test/a.pdf' } }] }] }, 'expected', '/messages'));
  const sanitizedChat = checkChatOrMessagesRequest({ model: 'expected', store: true, service_tier: 'priority', messages: [] }, 'expected', '/chat/completions');
  assert.equal(sanitizedChat.store, false);
  assert.equal(sanitizedChat.service_tier, undefined);
  const sanitizedCompact = checkResponsesCompactRequest({ model: 'expected', input: 'hi', store: true, service_tier: 'priority' }, 'expected');
  assert.equal('store' in sanitizedCompact, false);
  assert.equal('service_tier' in sanitizedCompact, false);

  const seen = [];
  let holdResponsesAfterCompleted = false;
  let holdResponsesBeforeCompleted = false;
  let releaseHeld = () => {};
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, headers: req.headers, bodyLength: bodyText.length, body: bodyText.length < 100_000 ? JSON.parse(bodyText) : { oversized: true } });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-chat-1' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-5.3-codex',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4 } }));
      return;
    }
    if (req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // No space after `data:` and no trailing newline on final event
      res.write(`event: message_start\ndata:${JSON.stringify({ type: 'message_start', message: { id: 'msg-1', model: 'gpt-5.3-codex', usage: { input_tokens: 50, output_tokens: 1 } } })}\n\n`);
      res.write(`event: message_delta\ndata:${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 15 } })}\n\n`);
      res.end(`event: message_stop\ndata:${JSON.stringify({ type: 'message_stop' })}`);
      return;
    }
    if (req.url === '/v1/responses/compact') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'cmp-1', object: 'response.compaction', model: 'gpt-5.3-codex', output: [],
        usage: { input_tokens: 15, output_tokens: 3 } }));
      return;
    }
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-resp-1' });
      const payload = { id: 'resp-1', object: 'response', model: 'gpt-5.3-codex', status: 'completed', output: [],
        usage: { input_tokens: 20, output_tokens: 5 } };
      if (holdResponsesBeforeCompleted) {
        res.write(`event: response.created\ndata:${JSON.stringify({ type: 'response.created', response: { ...payload, status: 'in_progress' } })}\n\n`);
        await new Promise(resolve => { releaseHeld = resolve; });
        res.end();
        return;
      }
      res.write(`event: response.completed\ndata:${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`);
      if (holdResponsesAfterCompleted) {
        await new Promise(resolve => { releaseHeld = resolve; });
      }
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'cr-relay-'));
  const sessionDir = join(dir, 'session');
  let sessionArchiveResult;
  const events = [];
  const faults = [];
  const cf2hPreset = protocolForPreset('cf-2h');
  const close = await serveContestChannels({
    dir: join(dir, 'channels'),
    profile: { id: 'p', harness: 'codex', api: 'passthrough', model: 'gpt-5.3-codex', reasoning_effort: 'high', service_tier: 'fast',
      base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'relay-secret-token',
    signal: new AbortController().signal,
    maxTurns: 12,
    requestTimeoutMs: 10_000,
    maxRequestBytes: cf2hPreset.maxRequestBytes,
    sessionArchive: { dir: sessionDir, maxBytes: 1024, onResult: r => { sessionArchiveResult = r; } },
    contest: { submit: () => ({ verdict: 'ok' }), status: () => ({}), close: () => {} },
    event: e => events.push(e),
    finish: () => {},
    fault: r => faults.push(r),
  });
  t.after(async () => {
    releaseHeld();
    await close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const callSock = (method, path, body, extraHeaders = {}) => new Promise((resolve, reject) => {
    const raw = typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest({ socketPath: join(dir, 'channels', 'model.sock'), method, path, headers: {
      ...(raw !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders,
    } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });

  // 1. Blocked methods, blocked non-inference routes, mixed cross-protocol bodies, unexpressible configured tiers, and model/tool bypasses produce ZERO upstream calls
  assert.equal((await callSock('DELETE', '/v1/responses')).status, 405);
  assert.equal((await callSock('GET', '/v1/models')).status, 405);
  assert.equal((await callSock('POST', '/v1/files', { model: 'gpt-5.3-codex' })).status, 404);
  assert.equal((await callSock('POST', '/v1/batches', { model: 'gpt-5.3-codex' })).status, 404);
  assert.equal((await callSock('POST', '/v1/../responses', { model: 'gpt-5.3-codex', input: 'hi' })).status, 400);
  assert.equal((await callSock('POST', '/v1/responses/', { model: 'other-model', input: 'hi' })).status, 400);
  assert.equal((await callSock('POST', '/v1/responses', { model: 'gpt-5.3-codex', input: 'hi', messages: [] })).status, 400);
  assert.equal((await callSock('POST', '/v1/%72esponses', { model: 'gpt-5.3-codex', input: 'hi', tools: [{ type: 'web_search' }] })).status, 400);
  assert.equal((await callSock('POST', '/v1/chat/completions', { model: 'other-model', messages: [] })).status, 400);
  assert.equal((await callSock('POST', '/v1/chat/completions', { model: 'gpt-5.3-codex', input: 'mixed', messages: [] })).status, 400);
  assert.equal((await callSock('POST', '/v1/messages', { model: 'gpt-5.3-codex', input: 'mixed', messages: [] })).status, 400);
  assert.equal((await callSock('POST', '/v1/messages', { model: 'gpt-5.3-codex', mcp_servers: [], messages: [] })).status, 400);
  // Profile has reasoning_effort:'high' + service_tier:'fast': routes that cannot express them (/messages, /responses/compact) MUST reject with 0 upstream calls
  assert.equal((await callSock('POST', '/v1/messages', { model: 'gpt-5.3-codex', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })).status, 400);
  assert.equal((await callSock('POST', '/v1/responses/compact', { model: 'gpt-5.3-codex', input: 'hi' })).status, 400);
  assert.equal(seen.length, 0, 'Rejected requests must never hit upstream');

  // 2. Chat Completions forwards with allowlisted headers only, enforces host reasoning_effort ('high') & service_tier ('priority')
  const chat = await callSock('POST', '/v1/chat/completions',
    { model: 'gpt-5.3-codex', reasoning_effort: 'low', service_tier: 'flex', messages: [{ role: 'user', content: 'hello' }] },
    { authorization: 'Bearer spoofed', 'x-goog-api-key': 'spoof', 'openai-organization': 'org-x', 'openai-project': 'proj-x',
      'accept-encoding': 'gzip', 'x-forwarded-for': '1.2.3.4', 'x-custom-header': 'drop-me', accept: 'application/json' });
  assert.equal(chat.status, 200);
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].body.reasoning_effort, 'high');
  assert.equal(seen[0].body.service_tier, 'priority');
  assert.equal(seen[0].headers.authorization, 'Bearer relay-secret-token');
  assert.equal(seen[0].headers['x-goog-api-key'], undefined);
  assert.equal(seen[0].headers['openai-organization'], undefined);
  assert.equal(seen[0].headers['openai-project'], undefined);
  assert.equal(seen[0].headers['accept-encoding'], 'identity');
  assert.equal(seen[0].headers['x-forwarded-for'], undefined);
  assert.equal(seen[0].headers['x-custom-header'], undefined);
  assert.equal(seen[0].headers.accept, 'application/json');

  // 3. /v1/responses enforces host service_tier ('fast' -> 'priority'), overrides spoofed reasoning.effort ('low' -> 'high'), and enforces store:false
  const resp = await callSock('POST', '/v1/responses', { model: 'gpt-5.3-codex', input: 'hi', store: true, service_tier: 'flex', reasoning: { effort: 'low' } });
  assert.equal(resp.status, 200);
  assert.equal(seen[1].body.store, false);
  assert.equal(seen[1].body.service_tier, 'priority');
  assert.equal(seen[1].body.reasoning.effort, 'high');

  // 4. Large >48 MiB payload accepted under cf-2h preset (112 MiB cap)
  const bigInput = 'a'.repeat(50 * 1024 * 1024);
  const bigResp = await callSock('POST', '/v1/responses', JSON.stringify({ model: 'gpt-5.3-codex', input: bigInput }));
  assert.equal(bigResp.status, 200);
  assert.ok(seen[2].bodyLength > 50 * 1024 * 1024);

  // 4b. Unconfigured profile allows /v1/messages (injects x-api-key, strips service_tier, parses `data:` without space & trailing line),
  //     /v1/responses/compact (no store/service_tier, recognizes response.compaction), and strips client reasoning_effort/service_tier on /chat/completions
  const eventsPlain = [];
  const plainClose = await serveContestChannels({
    dir: join(dir, 'channels-plain'),
    profile: { id: 'p-plain', harness: 'codex', api: 'passthrough', model: 'gpt-5.3-codex',
      base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'relay-secret-token', signal: new AbortController().signal, maxTurns: 6, requestTimeoutMs: 10_000,
    contest: { submit: () => ({ verdict: 'ok' }), status: () => ({}), close: () => {} },
    event: e => eventsPlain.push(e), finish: () => {}, fault: () => {},
  });
  t.after(async () => { await plainClose(); });
  const callPlain = (path, body, extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: join(dir, 'channels-plain', 'model.sock'), method: 'POST', path, headers: {
      'content-type': 'application/json', ...extraHeaders,
    } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  const msg = await callPlain('/v1/messages',
    { model: 'gpt-5.3-codex', service_tier: 'priority', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    { 'anthropic-version': '2023-06-01' });
  assert.equal(msg.status, 200);
  assert.equal(seen[3].body.service_tier, undefined);
  assert.equal(seen[3].headers['x-api-key'], 'relay-secret-token');
  assert.equal(seen[3].headers['anthropic-version'], '2023-06-01');
  assert.ok(eventsPlain.some(e => e.type === 'model_identity' && e.response_id === 'msg-1'));

  const compact = await callPlain('/v1/responses/compact', { model: 'gpt-5.3-codex', input: 'hi', store: true, service_tier: 'priority' });
  assert.equal(compact.status, 200);
  assert.equal(seen[4].url, '/v1/responses/compact');
  assert.equal('store' in seen[4].body, false);
  assert.equal('service_tier' in seen[4].body, false);
  assert.ok(eventsPlain.some(e => e.type === 'model_usage' && e.usage.input_tokens === 15));

  const plainChat = await callPlain('/v1/chat/completions',
    { model: 'gpt-5.3-codex', reasoning_effort: 'high', service_tier: 'priority', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plainChat.status, 200);
  assert.equal('reasoning_effort' in seen[5].body, false);
  assert.equal('service_tier' in seen[5].body, false);
  await plainClose();

  // 6. Disconnect AFTER response.completed does NOT fault; disconnect BEFORE response.completed DOES fault
  faults.length = 0;
  holdResponsesAfterCompleted = true;
  await new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: join(dir, 'channels', 'model.sock'), method: 'POST', path: '/v1/responses',
      headers: { 'content-type': 'application/json' } }, res => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify({ model: 'gpt-5.3-codex', input: 'after-complete' }));
  });
  await new Promise(r => setTimeout(r, 40));
  releaseHeld();
  holdResponsesAfterCompleted = false;
  await new Promise(r => setTimeout(r, 40));
  assert.ok(!faults.includes('model_request_failed'), 'Disconnect after response.completed must not void the run');

  holdResponsesBeforeCompleted = true;
  await new Promise(resolve => {
    const req = httpRequest({ socketPath: join(dir, 'channels', 'model.sock'), method: 'POST', path: '/v1/responses',
      headers: { 'content-type': 'application/json' } }, res => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify({ model: 'gpt-5.3-codex', input: 'before-complete' }));
  });
  await new Promise(r => setTimeout(r, 40));
  releaseHeld();
  holdResponsesBeforeCompleted = false;
  await new Promise(r => setTimeout(r, 40));
  assert.ok(faults.includes('model_request_failed'), 'Premature disconnect before response.completed must fault');

  // 7. IPC /channels/session.sock archives & redacts session files cleanly without writable host mounts
  await new Promise((resolve, reject) => {
    const sock = netConnect(join(dir, 'channels', 'session.sock'), () => {
      sock.write(JSON.stringify({ path: '2026/04/rollout.jsonl', data_base64: Buffer.from('token=relay-secret-token\n{"ok":true}\n').toString('base64') }) + '\n');
      sock.end(JSON.stringify({ done: true }) + '\n');
    });
    sock.resume();
    sock.on('error', reject);
    sock.on('close', resolve);
  });
  await close();
  assert.equal(sessionArchiveResult.status, 'archived');
  assert.deepEqual(sessionArchiveResult.files, ['2026/04/rollout.jsonl']);
  const archivedPath = join(sessionDir, '2026', '04', 'rollout.jsonl');
  assert.equal((await stat(archivedPath)).mode & 0o777, 0o600);
  const archivedText = await readFile(archivedPath, 'utf8');
  assert.ok(!archivedText.includes('relay-secret-token'));
  assert.ok(archivedText.includes('[REDACTED]'));
});

test('turn_limit immediately closes submissions, host strips unconfigured service_tier, and session_archive_status distinguishes all 5 states', async t => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp-1', object: 'response', model: 'gpt-5.3-codex', status: 'completed', output: [] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'cr-turn-limit-'));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  // 1. Unconfigured service_tier strips client-supplied service_tier; turn_limit immediately locks out submit
  const inputs = await loadInputs('examples/demo/contest.json', 'examples/demo/codex.toml');
  const events = [];
  const faults = [];
  const m = match(inputs, e => events.push(e));
  let notConnectedRes;
  const ch1 = await serveContestChannels({
    dir: join(root, 'c1'),
    profile: { id: 'p', harness: 'codex', api: 'responses', model: 'gpt-5.3-codex',
      base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'secret-key',
    signal: new AbortController().signal,
    maxTurns: 1,
    sessionArchive: { dir: join(root, 's1'), onResult: r => { notConnectedRes = r; } },
    contest: { submit: a => m.submit(a), status: id => m.status(id), close: () => m.close() },
    event: e => events.push(e),
    finish: () => {},
    fault: r => faults.push(r),
  });
  const postResp = (sock, body) => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: sock, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  assert.equal(await postResp(join(root, 'c1', 'model.sock'), { model: 'gpt-5.3-codex', input: 't1', service_tier: 'priority' }), 200);
  assert.equal('service_tier' in seen[0], false, 'Client-supplied service_tier must be stripped when host did not configure one');
  assert.equal(await postResp(join(root, 'c1', 'model.sock'), { model: 'gpt-5.3-codex', input: 't2' }), 429);
  assert.deepEqual(faults, ['turn_limit']);
  // Submission attempted right after turn_limit must be rejected with contest_closed and produce ZERO submission_received events
  assert.deepEqual(m.submit({ problem_id: '1', answer: '3' }), { verdict: 'contest_closed' });
  assert.equal(events.filter(e => e.type === 'submission_received').length, 0);
  assert.equal(m.score(), 0);
  await ch1();
  assert.deepEqual(notConnectedRes, { status: 'not_connected', files: [] });

  // 2. Connected + done with 0 files -> 'empty'
  let emptyRes;
  const ch2 = await serveContestChannels({
    dir: join(root, 'c2'),
    profile: { id: 'p', harness: 'codex', api: 'responses', model: 'gpt-5.3-codex',
      base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'secret-key', signal: new AbortController().signal,
    sessionArchive: { dir: join(root, 's2'), onResult: r => { emptyRes = r; } },
    contest: { submit: () => ({ verdict: 'ok' }), status: () => ({}), close: () => {} },
    event: () => {}, finish: () => {}, fault: () => {},
  });
  await new Promise((resolve, reject) => {
    const sock = netConnect(join(root, 'c2', 'session.sock'), () => sock.end(JSON.stringify({ done: true }) + '\n'));
    sock.resume(); sock.on('error', reject); sock.on('close', resolve);
  });
  await ch2();
  assert.deepEqual(emptyRes, { status: 'empty', files: [] });

  // 3. Disconnected without done -> 'failed' and incomplete file discarded
  let failedRes;
  const ch3 = await serveContestChannels({
    dir: join(root, 'c3'),
    profile: { id: 'p', harness: 'codex', api: 'responses', model: 'gpt-5.3-codex',
      base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'secret-key', signal: new AbortController().signal,
    sessionArchive: { dir: join(root, 's3'), onResult: r => { failedRes = r; } },
    contest: { submit: () => ({ verdict: 'ok' }), status: () => ({}), close: () => {} },
    event: () => {}, finish: () => {}, fault: () => {},
  });
  await new Promise((resolve, reject) => {
    const sock = netConnect(join(root, 'c3', 'session.sock'), () => {
      sock.end(JSON.stringify({ path: 'partial.jsonl', data_base64: Buffer.from('incomplete').toString('base64') }) + '\n');
    });
    sock.resume(); sock.on('error', reject); sock.on('close', resolve);
  });
  await ch3();
  assert.deepEqual(failedRes, { status: 'failed', files: [] });
  await assert.rejects(stat(join(root, 's3', 'partial.jsonl')), { code: 'ENOENT' });

  // 4. Exceeding maxBytes -> 'truncated'
  let truncatedRes;
  const ch4 = await serveContestChannels({
    dir: join(root, 'c4'),
    profile: { id: 'p', harness: 'codex', api: 'responses', model: 'gpt-5.3-codex',
      base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'secret-key', signal: new AbortController().signal,
    sessionArchive: { dir: join(root, 's4'), maxBytes: 16, onResult: r => { truncatedRes = r; } },
    contest: { submit: () => ({ verdict: 'ok' }), status: () => ({}), close: () => {} },
    event: () => {}, finish: () => {}, fault: () => {},
  });
  await new Promise(resolve => {
    const sock = netConnect(join(root, 'c4', 'session.sock'), () => {
      sock.end(JSON.stringify({ path: 'big.jsonl', data_base64: Buffer.from('x'.repeat(64)).toString('base64') }) + '\n');
    });
    sock.resume(); sock.on('error', () => resolve()); sock.on('close', resolve);
  });
  await ch4();
  assert.equal(truncatedRes.status, 'truncated');
  assert.deepEqual(truncatedRes.files, ['big.jsonl']);

  // 5. stopInference() immediately aborts an in-flight upstream request without triggering model_request_failed while keeping session.sock open
  let releaseHang = () => {};
  let upstreamAborted = false;
  const hangUpstream = createServer((req, res) => {
    req.on('close', () => { upstreamAborted = true; });
    void new Promise(resolve => { releaseHang = resolve; }).then(() => { if (!res.destroyed) res.end('{}'); });
  });
  await new Promise(resolve => hangUpstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    releaseHang();
    hangUpstream.closeAllConnections();
    await new Promise(resolve => hangUpstream.close(resolve));
  });
  const abortFaults = [];
  let afterAbortSession;
  const ch5 = await serveContestChannels({
    dir: join(root, 'c5'),
    profile: { id: 'p', harness: 'codex', api: 'responses', model: 'gpt-5.3-codex',
      base_url: `http://127.0.0.1:${hangUpstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'secret-key', signal: new AbortController().signal, requestTimeoutMs: 30_000,
    sessionArchive: { dir: join(root, 's5'), onResult: r => { afterAbortSession = r; } },
    contest: { submit: () => ({ verdict: 'ok' }), status: () => ({}), close: () => {} },
    event: () => {}, finish: () => {}, fault: r => abortFaults.push(r),
  });
  const inflightPromise = new Promise(resolve => {
    const req = httpRequest({ socketPath: join(root, 'c5', 'model.sock'), method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve('aborted'));
    req.end(JSON.stringify({ model: 'gpt-5.3-codex', input: 'hang' }));
  });
  await new Promise(r => setTimeout(r, 40));
  ch5.stopInference();
  const inflightOutcome = await inflightPromise;
  assert.ok(inflightOutcome === 502 || inflightOutcome === 'aborted');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(upstreamAborted, true, 'stopInference() must abort the in-flight upstream request');
  assert.deepEqual(abortFaults, [], 'stopInference() must not spuriously trigger model_request_failed');
  // Session socket remains open after stopInference() so bridge.js can flush!
  await new Promise((resolve, reject) => {
    const sock = netConnect(join(root, 'c5', 'session.sock'), () => {
      sock.write(JSON.stringify({ path: 'flush.jsonl', data_base64: Buffer.from('ok\n').toString('base64') }) + '\n');
      sock.end(JSON.stringify({ done: true }) + '\n');
    });
    sock.resume(); sock.on('error', reject); sock.on('close', resolve);
  });
  await ch5();
  assert.deepEqual(afterAbortSession, { status: 'archived', files: ['flush.jsonl'] });

  // 6. Real bridge.ts streamSessions() with 257 files sends { done: true, truncated: true } -> receiver records 'truncated'
  const manySrc = join(root, 'many-sessions');
  await mkdir(manySrc, { recursive: true });
  await Promise.all(Array.from({ length: 257 }, (_, i) => writeFile(join(manySrc, `f${String(i).padStart(3, '0')}.jsonl`), `{"i":${i}}\n`)));
  let bridgeTruncRes;
  const ch6 = await serveContestChannels({
    dir: join(root, 'c6'),
    profile: { id: 'p', harness: 'codex', api: 'responses', model: 'gpt-5.3-codex',
      base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'secret-key', signal: new AbortController().signal,
    sessionArchive: { dir: join(root, 's6'), onResult: r => { bridgeTruncRes = r; } },
    contest: { submit: () => ({ verdict: 'ok' }), status: () => ({}), close: () => {} },
    event: () => {}, finish: () => {}, fault: () => {},
  });
  await streamSessions(manySrc, join(root, 'c6', 'session.sock'), 5_000);
  await ch6();
  assert.equal(bridgeTruncRes.status, 'truncated');
  assert.equal(bridgeTruncRes.files.length, 256);
});

test('result export omits raw answers/logs, merges by run and ranks Agent revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run_id = randomUUID(), dir = join(root, run_id), hash = 'a'.repeat(64);
  await mkdir(dir);
  await writeFile(join(dir, 'run.json'), JSON.stringify({ run_id, contest_id: 'demo', data_version: 1, input_sha256: { contest: hash },
    protocol_id: 'test', protocol_version: 2, protocol_sha256: hash, agent_id: 'a', agent_revision: hash, harness: { kind: 'codex', version: 'test' },
    model: { model: 'fixture', model_family_id: 'family', vendor: 'openai', base_url: 'private' }, local_inputs: { pdf: '/private' } }));
  const events = [{ type: 'submission_received', submission_id: 's1', problem_id: 'A', elapsed_ms: 100, source: 'private code' },
    { type: 'submission_judged', submission_id: 's1', verdict: 'OK' }, { type: 'run_ended', status: 'completed', score: 1, max_score: 2 }];
  await writeFile(join(dir, 'events.jsonl'), events.map((e, i) => JSON.stringify({ schema_version: 1, seq: i+1, ...e })).join('\n')+'\n');
  const first = await exportRun(root, run_id);
  assert.doesNotMatch(JSON.stringify(first), /private/);
  const second = { ...first, run_id: randomUUID(), agent_revision: 'b'.repeat(64), score: 2 };
  const bundle = { schema_version: 3, results: [first, second] };
  const { telemetry: _t, ...v2Base } = first;
  const v2Bundle = { schema_version: 2, results: [{ ...v2Base, run_id: randomUUID() }] };
  const { vendor: _vendor, ...legacyModel } = v2Base.model;
  const legacy = { schema_version: 1, results: [{ ...v2Base, run_id: randomUUID(), model: legacyModel }] };
  assert.equal(mergeResults([bundle, v2Bundle, legacy]).results.length, 4);
  assert.equal(mergeResults([bundle, bundle]).schema_version, 3);
  assert.equal(mergeResults([bundle, bundle]).results.length, 2);
  assert.deepEqual(rankResults(bundle, 'family')[0].map(row => row.result.score), [2, 1]);
  assert.deepEqual(rankResults(bundle, 'another'), []);
  assert.equal(rankResults(bundle, undefined, 'openai')[0].length, 2);
  assert.deepEqual(rankResults(legacy, undefined, 'openai'), []);
});
