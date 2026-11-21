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
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { assertCompatible } from '../dist/plan.js';
import { checkModelRequest, resolveRelayTarget, serveContestChannels } from '../dist/codex.js';

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

test('relay resolves subpaths safely, blocks traversal, and transparently proxies non-Responses endpoints with timing', async t => {
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/responses').target.href, 'https://api.openai.com/v1/responses');
  assert.equal(resolveRelayTarget('https://api.openai.com/v1', '/v1/chat/completions?stream=true').target.href, 'https://api.openai.com/v1/chat/completions?stream=true');
  assert.equal(resolveRelayTarget('https://api.anthropic.com/v1', '/v1/messages').target.href, 'https://api.anthropic.com/v1/messages');
  assert.equal(resolveRelayTarget('https://proxy.example/custom', '/models').target.href, 'https://proxy.example/custom/models');
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/../secret'), /traversal/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '/v1/%2e%2e/secret'), /traversal/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', '//evil.example/v1/responses'), /Invalid relay path/);
  assert.throws(() => resolveRelayTarget('https://api.openai.com/v1', 'https://evil.example/v1/responses'), /Invalid relay path/);

  const seen = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: bodyText ? JSON.parse(bodyText) : null });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-chat-1' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-5.3-codex',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4 } }));
      return;
    }
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-resp-1' });
      const payload = { id: 'resp-1', object: 'response', model: 'gpt-5.3-codex', status: 'completed', output: [],
        usage: { input_tokens: 20, output_tokens: 5 } };
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`);
      return;
    }
    if (req.url === '/v1/redirect') {
      res.writeHead(302, { location: 'https://evil.example/' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'cr-relay-'));
  const events = [];
  const faults = [];
  const close = await serveContestChannels({
    dir: join(dir, 'channels'),
    profile: { id: 'p', harness: 'codex', api: 'passthrough', model: 'gpt-5.3-codex', service_tier: 'fast',
      base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key_env: 'OPENAI_API_KEY' },
    key: 'relay-secret-token',
    signal: new AbortController().signal,
    maxTurns: 4,
    requestTimeoutMs: 10_000,
    contest: { submit: () => ({ verdict: 'ok' }), status: () => ({}), close: () => {} },
    event: e => events.push(e),
    finish: () => {},
    fault: r => faults.push(r),
  });
  t.after(async () => {
    await close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const callSock = (method, path, body, extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: join(dir, 'channels', 'model.sock'), method, path, headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders,
    } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

  // 1. Transparent passthrough to /v1/chat/completions strips client auth & injects Bearer token
  const chat = await callSock('POST', '/v1/chat/completions',
    { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: 'hello' }], custom_vendor_field: true },
    { authorization: 'Bearer spoofed-token', 'x-forwarded-for': '1.2.3.4', 'x-custom-beta': 'v2' });
  assert.equal(chat.status, 200);
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer relay-secret-token');
  assert.equal(seen[0].headers['x-forwarded-for'], undefined);
  assert.equal(seen[0].headers['x-custom-beta'], 'v2');
  assert.equal(seen[0].body.custom_vendor_field, true);

  // 2. Responses path enforces security invariants and injects service_tier + store:false
  const resp = await callSock('POST', '/v1/responses', { model: 'gpt-5.3-codex', input: 'hi', store: true });
  assert.equal(resp.status, 200);
  assert.equal(seen[1].body.store, false);
  assert.equal(seen[1].body.service_tier, 'fast');

  // 3. Path traversal rejected before hitting upstream
  const trav = await callSock('GET', '/v1/../admin');
  assert.equal(trav.status, 400);
  assert.equal(seen.length, 2);

  // 4. Disallowed remote tool on /v1/responses rejected
  const badResp = await callSock('POST', '/v1/responses', { model: 'gpt-5.3-codex', input: 'hi', tools: [{ type: 'web_search' }] });
  assert.equal(badResp.status, 400);
  assert.ok(faults.includes('invalid_model_request'));

  // 5. Upstream redirect blocked (redirect: 'error')
  const redir = await callSock('GET', '/v1/redirect');
  assert.equal(redir.status, 502);

  // 6. Telemetry recorded on forwarded turns
  const timings = events.filter(e => e.type === 'model_timing');
  assert.ok(timings.length >= 2);
  assert.equal(typeof timings[0].ttft_ms, 'number');
  assert.equal(typeof timings[0].duration_ms, 'number');
  assert.ok(events.some(e => e.type === 'model_usage' && e.usage.prompt_tokens === 12));
  assert.ok(events.some(e => e.type === 'model_usage' && e.usage.input_tokens === 20));
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
