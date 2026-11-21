import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PushDispatcher,
  PushTargetError,
  PushTargets,
  createPushTargetSchema,
  patchPushTargetSchema,
  pushDeliverySchema,
  pushTargetResponseSchema,
  rotatePushTargetSchema,
  sanitizeDeliveryError,
  sanitizePushPayload,
  signPushPayload,
  verifyPushSignature,
} from '../dist/push.js';

function useFileSecretBackend(t) {
  const previous = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  t.after(() => {
    if (previous === undefined) delete process.env.CR_CREDENTIAL_STORAGE;
    else process.env.CR_CREDENTIAL_STORAGE = previous;
  });
}

async function startMockReceiver(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const record = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        rawBody,
        json: rawBody ? JSON.parse(rawBody) : undefined,
      };
      requests.push(record);
      handler(record, res, requests.length);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { baseUrl, requests };
}

test('PushTargets enforces write-only credential storage, origin pinning, URL/SSRF rules, and atomic credential_ref rotation', async t => {
  useFileSecretBackend(t);
  const root = await mkdtemp(join(tmpdir(), 'cr-push-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new PushTargets(join(root, 'targets-store'));
  const bearerSecret = 'cr-test-bearer-token-initial-001';
  const rotatedSecret = 'cr-test-hmac-secret-rotated-002';

  assert.deepEqual(await store.list(), []);

  // Reject unsafe URLs: non-loopback HTTP, userinfo, query string, fragment, link-local / IMDS / unspecified
  const badUrls = [
    'http://example.com/hook',
    'https://user:pass@example.com/hook',
    'https://example.com/hook?token=secret',
    'https://example.com/hook#frag',
    'https://0.0.0.0/hook',
    'https://[::]/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[fe80::1]/hook',
    'https://[::ffff:169.254.169.254]/hook',
    'https://metadata.google.internal/computeMetadata/v1/',
  ];
  for (const url of badUrls) {
    assert.throws(
      () => createPushTargetSchema.parse({ label: 'Bad', url, events: ['run.completed'], auth_mode: 'none' }),
      `Expected URL to be rejected: ${url}`,
    );
  }

  // Reject short secrets (< 8 chars) and auth_mode / secret mismatches
  assert.throws(() => createPushTargetSchema.parse({
    label: 'Short secret',
    url: 'https://hooks.example.test/v1',
    events: ['run.completed'],
    auth_mode: 'bearer',
    secret: 'short7!',
  }));
  assert.throws(() => createPushTargetSchema.parse({
    label: 'Unexpected secret',
    url: 'https://hooks.example.test/v1',
    events: ['run.completed'],
    auth_mode: 'none',
    secret: bearerSecret,
  }));
  assert.throws(() => createPushTargetSchema.parse({
    label: 'Missing secret',
    url: 'https://hooks.example.test/v1',
    events: ['run.completed'],
    auth_mode: 'bearer',
  }));
  await assert.rejects(
    store.create({
      id: 'bad-meta',
      label: `Leak ${bearerSecret}`,
      url: 'https://hooks.example.test/v1',
      events: ['run.completed'],
      auth_mode: 'bearer',
      secret: bearerSecret,
    }),
    error => error instanceof PushTargetError && error.status === 400,
  );

  // Create authenticated target
  const created = await store.create({
    id: 'prod-hook',
    label: 'Prod Webhook',
    url: 'https://hooks.example.test/events',
    events: ['run.completed', 'batch.completed'],
    auth_mode: 'bearer',
    secret: bearerSecret,
  });
  assert.doesNotThrow(() => pushTargetResponseSchema.parse(created));
  assert.equal(created.id, 'prod-hook');
  assert.equal(created.approved_origin, 'https://hooks.example.test');
  assert.equal(created.backend, 'file');
  assert.equal(created.credential_available, true);
  assert.ok(created.credential_ref);
  assert.ok(!JSON.stringify(created).includes(bearerSecret), 'Secret must never echo in create response');

  // Verify on-disk permissions and secret separation
  const targetFile = join(store.root, 'targets', 'prod-hook.json');
  const oldCredFile = join(store.root, 'credentials', created.credential_ref);
  assert.equal((await stat(store.root)).mode & 0o777, 0o700);
  assert.equal((await stat(targetFile)).mode & 0o777, 0o600);
  assert.equal((await stat(oldCredFile)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(targetFile, 'utf8')).includes(bearerSecret), 'Secret must not appear in target JSON');
  assert.equal(await readFile(oldCredFile, 'utf8'), bearerSecret);

  // Duplicate ID rejected with 409
  await assert.rejects(
    store.create({
      id: 'prod-hook',
      label: 'Dup',
      url: 'https://hooks.example.test/dup',
      events: ['run.completed'],
      auth_mode: 'none',
    }),
    error => error instanceof PushTargetError && error.status === 409,
  );

  // Cross-origin URL patch rejected with 409
  await assert.rejects(
    store.patch('prod-hook', { url: 'https://evil.example.test/events' }),
    error => error instanceof PushTargetError && error.status === 409,
  );
  await assert.rejects(
    store.patch('prod-hook', { url: 'https://hooks.example.test:8443/events' }),
    error => error instanceof PushTargetError && error.status === 409,
  );
  assert.throws(() => patchPushTargetSchema.parse({ secret: rotatedSecret }));

  // Same-origin patch succeeds
  const patched = await store.patch('prod-hook', {
    label: 'Prod Webhook v2',
    url: 'https://hooks.example.test/v2/events',
    enabled: false,
    events: ['run.completed'],
    timeout_ms: 5000,
    max_retries: 2,
  });
  assert.equal(patched.label, 'Prod Webhook v2');
  assert.equal(patched.url, 'https://hooks.example.test/v2/events');
  assert.equal(patched.enabled, false);
  assert.equal(patched.timeout_ms, 5000);
  assert.equal(patched.max_retries, 2);

  // Loose credential permissions mark credential_available: false AND fail-close patch() until rotated!
  await chmod(oldCredFile, 0o644);
  assert.equal((await store.get('prod-hook')).credential_available, false);
  await assert.rejects(
    store.patch('prod-hook', { label: 'Should Fail Closed' }),
    error => error instanceof PushTargetError && error.status === 500,
  );

  // Atomic rotation from bearer -> hmac-sha256 allocates a NEW credential_ref and cleans up the old one
  assert.doesNotThrow(() => rotatePushTargetSchema.parse({ secret: rotatedSecret, auth_mode: 'hmac-sha256' }));
  const rotated = await store.rotate('prod-hook', { secret: rotatedSecret, auth_mode: 'hmac-sha256' });
  assert.equal(rotated.credential_available, true);
  assert.equal(rotated.auth_mode, 'hmac-sha256');
  assert.notEqual(rotated.credential_ref, created.credential_ref, 'Rotation must allocate a fresh credential_ref');
  assert.ok(!JSON.stringify(rotated).includes(rotatedSecret));

  const newCredFile = join(store.root, 'credentials', rotated.credential_ref);
  assert.equal(await readFile(newCredFile, 'utf8'), rotatedSecret);
  assert.equal((await stat(newCredFile)).mode & 0o777, 0o600);
  await assert.rejects(stat(oldCredFile), { code: 'ENOENT' });

  // Concurrent resolveForDelivery + rotate always yields a mutually consistent (auth_mode, secret) pair
  const nextBearer = 'cr-test-bearer-next-consistent-003';
  const [snap1, rotatedAgain, snap2] = await Promise.all([
    store.resolveForDelivery('prod-hook'),
    store.rotate('prod-hook', { secret: nextBearer, auth_mode: 'bearer' }),
    store.resolveForDelivery('prod-hook'),
  ]);
  assert.equal(rotatedAgain.auth_mode, 'bearer');
  for (const snap of [snap1, snap2]) {
    if (snap.target.auth_mode === 'hmac-sha256') assert.equal(snap.secret, rotatedSecret);
    else if (snap.target.auth_mode === 'bearer') assert.equal(snap.secret, nextBearer);
    else assert.fail(`Unexpected auth_mode: ${snap.target.auth_mode}`);
  }

  // Remove deletes both target and latest credential file
  const latestCredFile = join(store.root, 'credentials', rotatedAgain.credential_ref);
  await store.remove('prod-hook');
  await assert.rejects(stat(latestCredFile), { code: 'ENOENT' });
  await assert.rejects(store.get('prod-hook'), error => error instanceof PushTargetError && error.status === 404);
});

test('PushDispatcher enforces public payload whitelist, redacts short/symbol secrets, refreshes retry timestamps, and handles concurrency/cancellation', async t => {
  useFileSecretBackend(t);
  const root = await mkdtemp(join(tmpdir(), 'cr-push-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bearerSecret = 'secret-bearer!@#$%^&*()_+-98765';
  const hmacSecret = 'secret-hmac-signing-key-abcdef123456';
  const sleepDelays = [];
  let fakeNow = Date.parse('2026-04-01T12:00:00.000Z');
  const fastSleep = async ms => {
    sleepDelays.push(ms);
    fakeNow += 5_000; // Advance clock across retries so X-CR-Timestamp refreshes visibly
  };

  let retry503Count = 0;
  let retry429Count = 0;
  let hmacRetryCount = 0;

  const { baseUrl, requests } = await startMockReceiver(t, (req, res) => {
    if (req.url === '/bearer') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/hmac') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"accepted":true}');
      return;
    }
    if (req.url === '/hmac-retry') {
      hmacRetryCount++;
      res.writeHead(hmacRetryCount < 2 ? 503 : 200);
      res.end(hmacRetryCount < 2 ? 'retry' : 'ok');
      return;
    }
    if (req.url === '/always-503') {
      res.writeHead(503);
      res.end('always unavailable');
      return;
    }
    if (req.url === '/flaky-503') {
      retry503Count++;
      res.writeHead(retry503Count < 3 ? 503 : 200);
      res.end(retry503Count < 3 ? 'temporarily unavailable' : 'ok');
      return;
    }
    if (req.url === '/rate-429') {
      retry429Count++;
      res.writeHead(retry429Count < 2 ? 429 : 200);
      res.end('rate limited');
      return;
    }
    if (req.url === '/bad-400') {
      res.writeHead(400);
      res.end('bad payload');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `${baseUrl}/bearer` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const store = new PushTargets(join(root, 'push-targets'));
  await store.create({
    id: 't-bearer',
    label: 'Bearer Receiver',
    url: `${baseUrl}/bearer`,
    events: ['run.completed'],
    auth_mode: 'bearer',
    secret: bearerSecret,
  });
  await store.create({
    id: 't-hmac',
    label: 'HMAC Receiver',
    url: `${baseUrl}/hmac`,
    events: ['run.completed', 'run.progress'],
    auth_mode: 'hmac-sha256',
    secret: hmacSecret,
  });
  await store.create({
    id: 't-hmac-retry',
    label: 'HMAC Retry Receiver',
    url: `${baseUrl}/hmac-retry`,
    events: ['run.progress'],
    auth_mode: 'hmac-sha256',
    secret: hmacSecret,
    max_retries: 2,
  });
  await store.create({
    id: 't-flaky',
    label: 'Flaky 503',
    url: `${baseUrl}/flaky-503`,
    events: ['batch.completed'],
    auth_mode: 'none',
    max_retries: 3,
  });
  await store.create({
    id: 't-429',
    label: 'Rate Limited 429',
    url: `${baseUrl}/rate-429`,
    events: ['batch.completed'],
    auth_mode: 'none',
    max_retries: 2,
  });
  await store.create({
    id: 't-400',
    label: 'Bad Request 400',
    url: `${baseUrl}/bad-400`,
    events: ['batch.completed'],
    auth_mode: 'none',
    max_retries: 3,
  });
  await store.create({
    id: 't-redirect',
    label: 'Redirect Target',
    url: `${baseUrl}/redirect`,
    events: ['batch.completed'],
    auth_mode: 'none',
    max_retries: 3,
  });
  await store.create({
    id: 't-disabled',
    label: 'Disabled Target',
    url: `${baseUrl}/bearer`,
    enabled: false,
    events: ['run.completed'],
    auth_mode: 'bearer',
    secret: bearerSecret,
  });

  const dispatcher = new PushDispatcher(store, { sleep: fastSleep, now: () => fakeNow, concurrency: 4 });

  // 1. Outbound payload whitelist canary test: private fields, free-form/unknown reason, and untrusted problem_ids
  const id64 = 'p' + 'a'.repeat(63);
  const id65 = 'p' + 'b'.repeat(64);
  const id128 = 'p' + 'c'.repeat(127);
  const id129 = 'p' + 'd'.repeat(128);
  const canaryPayload = {
    run_id: '11111111-1111-4111-8111-111111111111',
    contest_id: 'demo-contest',
    score: 300,
    max_score: 500,
    reason: 'review_only_marker',
    source: 'CANARY_SOURCE_CODE',
    answer: 'CANARY_LOCAL_ANSWER',
    stdout: 'CANARY_STDOUT_LOG',
    stderr: 'CANARY_STDERR_LOG',
    local_inputs: { pdf: '/home/alice/secret.pdf' },
    session: 'CANARY_SESSION_TRANSCRIPT',
    extra_nested: { secret: 'CANARY_UNDECLARED_NESTED' },
    submissions: [
      { submission_id: 's1', problem_id: id64, elapsed_ms: 1000, verdict: 'AC', source: 'CANARY_SUB_SOURCE', answer: 'CANARY_SUB_ANSWER' },
      { submission_id: 's2', problem_id: id65, elapsed_ms: 1100, verdict: 'AC' },
      { submission_id: 's3', problem_id: id128, elapsed_ms: 1200, verdict: 'AC' },
      { submission_id: 's4', problem_id: id129, elapsed_ms: 1300, verdict: 'AC' },
      { submission_id: 's5', problem_id: 'CANARY_INVALID_PID_EXFIL', elapsed_ms: 2000, verdict: 'invalid_submission' },
    ],
  };

  // Without validProblemIds (default): unverified submissions are omitted and problem_breakdown_unavailable is set
  const defaultSanitized = sanitizePushPayload('run.completed', canaryPayload);
  assert.equal(defaultSanitized.reason, 'other');
  assert.equal(defaultSanitized.submissions, undefined);
  assert.equal(defaultSanitized.problem_breakdown_unavailable, true);
  assert.ok(!JSON.stringify(defaultSanitized).includes('CANARY_'));

  // With explicit validProblemIds (testing 64 / 65 / 128-char IDs allowed, 129-char & invalid normalized)
  const sanitizedDirect = sanitizePushPayload('run.completed', canaryPayload, { validProblemIds: [id64, id65, id128, id129] });
  assert.equal(sanitizedDirect.reason, 'other');
  assert.deepEqual(sanitizedDirect.submissions.map(s => s.problem_id), [id64, id65, id128, '[invalid]', '[invalid]']);
  const sanitizedStr = JSON.stringify(sanitizedDirect);
  for (const canary of [
    'review_only_marker',
    'CANARY_INVALID_PID_EXFIL',
    'CANARY_SOURCE_CODE',
    'CANARY_LOCAL_ANSWER',
    'CANARY_STDOUT_LOG',
    'CANARY_STDERR_LOG',
    'CANARY_SESSION_TRANSCRIPT',
    'CANARY_UNDECLARED_NESTED',
    'CANARY_SUB_SOURCE',
    'CANARY_SUB_ANSWER',
    '/home/alice',
  ]) {
    assert.ok(!sanitizedStr.includes(canary), `Whitelist leaked canary: ${canary}`);
  }

  // run.progress shares the exact same trusted problem ID enforcement (both default omitted and explicit set)
  const rawProgressPayload = {
    run_id: '11111111-1111-4111-8111-111111111111',
    status: 'running',
    reason: 'password=CANARY_ONLY',
    score: 100,
    problem_breakdown_unavailable: false,
    problems: [
      { id: id128, max_points: 100, attempts: 1, status: 'accepted', best_score: 100 },
      { id: 'UNTRUSTED_CANARY_PROB', max_points: 1, attempts: 1, status: 'wrong', best_score: 0 },
    ],
    recent_activity: [
      { seq: 1, elapsed_ms: 1000, type: 'submission_received', problem_id: id128, summary: 'CANARY_SUMMARY_STRIPPED' },
      { seq: 2, elapsed_ms: 2000, type: 'submission_judged', problem_id: 'UNTRUSTED_CANARY_ACT', verdict: 'invalid_submission' },
    ],
  };
  const progDefault = sanitizePushPayload('run.progress', rawProgressPayload);
  assert.equal(progDefault.reason, 'other');
  assert.equal(progDefault.problems, undefined);
  assert.equal(progDefault.recent_activity, undefined);
  assert.equal(progDefault.problem_breakdown_unavailable, true);
  assert.ok(!JSON.stringify(progDefault).includes('CANARY'));

  const progFiltered = sanitizePushPayload('run.progress', rawProgressPayload, { validProblemIds: [id128] });
  assert.equal(progFiltered.problems.length, 1);
  assert.equal(progFiltered.problems[0].id, id128);
  assert.equal(progFiltered.recent_activity[0].problem_id, id128);
  assert.equal(progFiltered.recent_activity[0].summary, undefined);
  assert.equal(progFiltered.recent_activity[1].problem_id, '[invalid]');
  assert.ok(!JSON.stringify(progFiltered).includes('CANARY'));

  // Canonical runner reason codes pass through untouched
  assert.equal(sanitizePushPayload('run.completed', { run_id: canaryPayload.run_id, reason: 'time_limit' }).reason, 'time_limit');

  // Deliver run.completed over default pinned node:http transport (NO validProblemIds -> breakdown omitted on wire)
  const defaultWireResults = await dispatcher.deliver('run.completed', canaryPayload, { targetIds: ['t-bearer'] });
  assert.equal(defaultWireResults[0].status, 'delivered');
  const firstBearerReq = requests.find(r => r.url === '/bearer');
  assert.equal(firstBearerReq.json.submissions, undefined);
  assert.equal(firstBearerReq.json.problem_breakdown_unavailable, true);
  assert.ok(!firstBearerReq.rawBody.includes('CANARY'));

  const runResults = await dispatcher.deliver('run.completed', canaryPayload, { validProblemIds: [id64, id65, id128] });
  assert.equal(runResults.length, 2);
  for (const r of runResults) {
    assert.doesNotThrow(() => pushDeliverySchema.parse(r));
    assert.equal(r.status, 'delivered');
    assert.equal(r.attempts, 1);
  }

  const bearerReq = requests.find(r => r.url === '/bearer');
  assert.equal(bearerReq.headers['authorization'], `Bearer ${bearerSecret}`);
  assert.equal(bearerReq.headers['x-cr-event'], 'run.completed');
  assert.ok(!bearerReq.rawBody.includes('CANARY_'), 'Canary leaked over wire to Bearer target');
  assert.equal(bearerReq.json.score, 300);

  const hmacReq = requests.find(r => r.url === '/hmac');
  assert.equal(hmacReq.headers['authorization'], undefined);
  const sig = hmacReq.headers['x-cr-signature-256'];
  const ts = hmacReq.headers['x-cr-timestamp'];
  assert.ok(sig && ts);
  assert.equal(sig, signPushPayload(hmacSecret, hmacReq.rawBody, ts));
  assert.equal(verifyPushSignature(hmacSecret, hmacReq.rawBody, ts, sig), true);
  assert.equal(verifyPushSignature(hmacSecret, hmacReq.rawBody, ts, sig.toUpperCase()), false);
  assert.equal(verifyPushSignature(hmacSecret, hmacReq.rawBody, ts, 'sha256=deadbeef'), false);

  // 2. Retries preserve X-CR-Delivery-Id while refreshing X-CR-Timestamp and X-CR-Signature-256
  const retryRes = await dispatcher.deliver(
    'run.progress',
    { run_id: '11111111-1111-4111-8111-111111111111', status: 'running', score: 100, answer: 'CANARY_PROGRESS_ANS' },
    { targetIds: ['t-hmac-retry'] },
  );
  assert.equal(retryRes.length, 1);
  assert.equal(retryRes[0].status, 'delivered');
  assert.equal(retryRes[0].attempts, 2);
  const hmacAttempts = requests.filter(r => r.url === '/hmac-retry');
  assert.equal(hmacAttempts.length, 2);
  assert.equal(hmacAttempts[0].headers['x-cr-delivery-id'], hmacAttempts[1].headers['x-cr-delivery-id']);
  assert.notEqual(hmacAttempts[0].headers['x-cr-timestamp'], hmacAttempts[1].headers['x-cr-timestamp']);
  assert.notEqual(hmacAttempts[0].headers['x-cr-signature-256'], hmacAttempts[1].headers['x-cr-signature-256']);
  for (const req of hmacAttempts) {
    assert.ok(!req.rawBody.includes('CANARY_PROGRESS_ANS'));
    assert.equal(
      verifyPushSignature(hmacSecret, req.rawBody, req.headers['x-cr-timestamp'], req.headers['x-cr-signature-256']),
      true,
    );
  }

  // 3. Batch delivery with 503/429 retries, 400 no-retry, 302 redirect rejection (concurrently!)
  sleepDelays.length = 0;
  const batchResults = await dispatcher.deliver('batch.completed', { batch_id: 'b-1', completed: 4 });
  const byTarget = Object.fromEntries(batchResults.map(r => [r.target_id, r]));

  assert.equal(byTarget['t-flaky'].status, 'delivered');
  assert.equal(byTarget['t-flaky'].http_status, 200);
  assert.equal(byTarget['t-flaky'].attempts, 3);

  assert.equal(byTarget['t-429'].status, 'delivered');
  assert.equal(byTarget['t-429'].http_status, 200);
  assert.equal(byTarget['t-429'].attempts, 2);

  assert.equal(byTarget['t-400'].status, 'failed');
  assert.equal(byTarget['t-400'].http_status, 400);
  assert.equal(byTarget['t-400'].attempts, 1);

  assert.equal(byTarget['t-redirect'].status, 'failed');
  assert.equal(byTarget['t-redirect'].attempts, 1);
  assert.equal(byTarget['t-redirect'].error, 'redirect_rejected');
  assert.equal(requests.filter(r => r.url === '/bearer').length, 2);

  // 4. Pre-aborted signal skips fanout cleanly without writing bogus attempt=1 failures
  const beforeAbortCount = (await dispatcher.listDeliveries(100)).length;
  const aborted = new AbortController();
  aborted.abort();
  const abortedResults = await dispatcher.deliver('run.completed', canaryPayload, { signal: aborted.signal });
  assert.deepEqual(abortedResults, []);
  assert.equal((await dispatcher.listDeliveries(100)).length, beforeAbortCount);

  // 5. Target disabled/deleted race during dispatch skips cleanly without bogus failure record
  const raceTarget = await store.create({
    id: 't-race',
    label: 'Race Target',
    url: `${baseUrl}/bearer`,
    events: ['run.completed'],
    auth_mode: 'none',
  });
  let deletedDuringList = false;
  const origResolve = store.resolveForDelivery.bind(store);
  store.resolveForDelivery = async id => {
    if (id === raceTarget.id && !deletedDuringList) {
      deletedDuringList = true;
      await store.remove(raceTarget.id);
    }
    return origResolve(id);
  };
  const afterRace = await dispatcher.deliver('run.completed', canaryPayload, { targetIds: [raceTarget.id] });
  store.resolveForDelivery = origResolve;
  assert.deepEqual(afterRace, []);

  // 5b. Target disabled during retry backoff stops retrying without sending a second HTTP request
  const disableRetryTarget = await store.create({
    id: 't-disable-retry',
    label: 'Disable Mid Retry',
    url: `${baseUrl}/flaky-503`,
    events: ['run.completed'],
    auth_mode: 'none',
    max_retries: 3,
  });
  let midRetryFetches = 0;
  const midRetryRes = await dispatcher.deliver('run.completed', canaryPayload, {
    targetIds: [disableRetryTarget.id],
    transportImpl: async () => {
      midRetryFetches++;
      return { status: 503 };
    },
    sleep: async () => {
      await store.patch(disableRetryTarget.id, { enabled: false });
    },
  });
  assert.equal(midRetryFetches, 1, 'Disabled target must not receive retry attempts after backoff');
  assert.equal(midRetryRes[0].status, 'failed');
  assert.equal(midRetryRes[0].error, 'target_disabled');

  // 5c. Delete-and-recreate under the same target ID during retry backoff MUST abort old delivery (0 requests to new receiver)
  const newReceiver = await startMockReceiver(t, (_req, res) => {
    res.writeHead(200);
    res.end('new-receiver-should-not-see-old-event');
  });
  const recreateTarget = await store.create({
    id: 't-recreate',
    label: 'Old Target',
    url: `${baseUrl}/always-503`,
    events: ['run.completed'],
    auth_mode: 'none',
    max_retries: 3,
  });
  const recreateRes = await dispatcher.deliver('run.completed', canaryPayload, {
    targetIds: [recreateTarget.id],
    sleep: async () => {
      await store.remove(recreateTarget.id);
      await store.create({
        id: recreateTarget.id,
        label: 'Recreated Different Origin',
        url: `${newReceiver.baseUrl}/fresh`,
        events: ['run.completed'],
        auth_mode: 'none',
        max_retries: 3,
      });
    },
  });
  assert.equal(recreateRes[0].status, 'failed');
  assert.equal(recreateRes[0].error, 'target_replaced');
  assert.equal(newReceiver.requests.length, 0, 'Recreated target must receive ZERO old retried events');

  // 5d. Connection-layer DNS pinning blocks IMDS/link-local IPs in default node:https transport AND pinned transportImpl
  const dnsTarget = await store.create({
    id: 't-dns-imds',
    label: 'DNS Rebind IMDS',
    url: 'https://rebind.example.test/hook',
    events: ['run.completed'],
    auth_mode: 'none',
    max_retries: 2,
  });
  // Default pinned node:https transport (NO transportImpl): lookup hook blocks 169.254.169.254 before TCP connect
  const pinnedBlocked = await dispatcher.deliver('run.completed', canaryPayload, {
    targetIds: [dnsTarget.id],
    lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
  });
  assert.equal(pinnedBlocked[0].status, 'failed');
  assert.equal(pinnedBlocked[0].error, 'blocked_destination');
  assert.equal(pinnedBlocked[0].attempts, 1);

  // Pinned transportImpl receives ONLY the verified resolved IP after lookupImpl validation
  let dnsFetchCalls = 0;
  const dnsBlocked = await dispatcher.deliver('run.completed', canaryPayload, {
    targetIds: [dnsTarget.id],
    lookupImpl: async () => [{ address: 'fe80::1', family: 6 }],
    transportImpl: async () => { dnsFetchCalls++; return { status: 200 }; },
  });
  assert.equal(dnsFetchCalls, 0);
  assert.equal(dnsBlocked[0].status, 'failed');
  assert.equal(dnsBlocked[0].error, 'blocked_destination');

  // Verify transportImpl receives the exact validated IP address + family resolved by lookupImpl
  let capturedReq;
  const pinnedOk = await dispatcher.deliver('run.completed', canaryPayload, {
    targetIds: [dnsTarget.id],
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    transportImpl: async req => { capturedReq = req; return { status: 202 }; },
  });
  assert.equal(pinnedOk[0].status, 'delivered');
  assert.equal(capturedReq.address, '93.184.216.34');
  assert.equal(capturedReq.family, 4);
  assert.equal(capturedReq.hostname, 'rebind.example.test');

  // transportImpl WITHOUT lookupImpl on non-loopback domain STILL runs default dns.lookup and fails closed
  const dnsNoLookupTarget = await store.create({
    id: 't-dns-invalid',
    label: 'Unresolvable Domain',
    url: `https://${'a'.repeat(64)}.invalid/hook`,
    events: ['run.completed'],
    auth_mode: 'none',
    max_retries: 0,
  });
  const dnsNoLookupRes = await dispatcher.deliver('run.completed', canaryPayload, {
    targetIds: [dnsNoLookupTarget.id],
    transportImpl: async () => { dnsFetchCalls++; return { status: 200 }; },
  });
  assert.equal(dnsFetchCalls, 0);
  assert.equal(dnsNoLookupRes[0].status, 'failed');
  assert.equal(dnsNoLookupRes[0].error, 'blocked_destination');

  // 5e. 202 response with open/unended response body MUST settle immediately as 'delivered' on attempt 1 (zero duplicate retries)
  const openBodyResponses = [];
  const openBodyServer = await startMockReceiver(t, (_req, res) => {
    res.writeHead(202, { 'Content-Type': 'text/plain' });
    res.flushHeaders();
    openBodyResponses.push(res);
    // Intentionally keep the response stream open!
  });
  t.after(() => {
    for (const r of openBodyResponses) {
      if (!r.destroyed) r.destroy();
    }
  });
  const openBodyTarget = await store.create({
    id: 't-open-202',
    label: 'Open Body 202',
    url: `${openBodyServer.baseUrl}/accepted`,
    events: ['run.completed'],
    auth_mode: 'none',
    timeout_ms: 1000,
    max_retries: 2,
  });
  const openBodyRes = await dispatcher.deliver('run.completed', canaryPayload, {
    targetIds: [openBodyTarget.id],
    sleep: fastSleep,
  });
  assert.equal(openBodyRes[0].status, 'delivered');
  assert.equal(openBodyRes[0].http_status, 202);
  assert.equal(openBodyRes[0].attempts, 1);
  assert.equal(openBodyServer.requests.length, 1, 'Receiver must see the 202 event exactly once');

  // 5f. run.progress accepts up to 200 recent_activity entries (matching readRunProgress) and caps/omits per policy
  const makeActivities = count => Array.from({ length: count }, (_, idx) => ({
    seq: idx + 1,
    elapsed_ms: idx * 1000,
    type: 'submission_judged',
    summary: `Activity ${idx + 1}`,
    problem_id: 'A',
    verdict: 'accepted',
  }));
  const progress51WithTrusted = sanitizePushPayload('run.progress', {
    run_id: '11111111-1111-4111-8111-111111111111',
    status: 'running',
    agent_id: 'agent-1',
    contest_id: 'cf-1',
    recent_activity: makeActivities(51),
  }, { validProblemIds: ['A'] });
  assert.equal(progress51WithTrusted.recent_activity.length, 50, 'Trusted progress activity is capped at 50 entries');

  const progress200WithTrusted = sanitizePushPayload('run.progress', {
    run_id: '22222222-2222-4222-8222-222222222222',
    status: 'running',
    agent_id: 'agent-1',
    contest_id: 'cf-1',
    recent_activity: makeActivities(200),
  }, { validProblemIds: ['A'] });
  assert.equal(progress200WithTrusted.recent_activity.length, 50);

  const progress200Untrusted = sanitizePushPayload('run.progress', {
    run_id: '33333333-3333-4333-8333-333333333333',
    status: 'running',
    agent_id: 'agent-1',
    contest_id: 'cf-1',
    recent_activity: makeActivities(200),
  });
  assert.equal(progress200Untrusted.recent_activity, undefined);
  assert.equal(progress200Untrusted.problem_breakdown_unavailable, true);

  // 6. Short secret & symbol Bearer redaction + safe fixed error codes on transport failure
  assert.equal(sanitizeDeliveryError('failed with key abc12', 'abc12'), 'failed with key [REDACTED]');
  assert.equal(sanitizeDeliveryError('header Authorization: Bearer tok!@#$%xyz failed'), 'header Authorization: Bearer [REDACTED] failed');

  const leakedTransport = async () => {
    throw new Error(`upstream rejected Authorization: Bearer ${bearerSecret} at https://secret.host/?k=1`);
  };
  const failedLeak = await dispatcher.testTarget('t-bearer', { transportImpl: leakedTransport, sleep: fastSleep });
  assert.equal(failedLeak.status, 'failed');
  assert.equal(failedLeak.error, 'network_error');

  // 7. testTarget sends lightweight { type: 'ping', timestamp } even when disabled
  const pingRes = await dispatcher.testTarget('t-disabled');
  assert.equal(pingRes.status, 'delivered');
  assert.equal(pingRes.event, 'ping');

  // 8. Audit log permissions & secret non-leakage
  const logRaw = await readFile(dispatcher.deliveriesFile, 'utf8');
  assert.equal((await stat(dispatcher.deliveriesFile)).mode & 0o777, 0o600);
  assert.ok(!logRaw.includes(bearerSecret), 'Bearer secret leaked into deliveries.jsonl');
  assert.ok(!logRaw.includes(hmacSecret), 'HMAC secret leaked into deliveries.jsonl');

  // Loosened deliveries.jsonl permissions fail closed on listDeliveries
  await chmod(dispatcher.deliveriesFile, 0o644);
  await assert.rejects(dispatcher.listDeliveries(10), error => error instanceof PushTargetError && error.status === 500);
  await chmod(dispatcher.deliveriesFile, 0o600);
  assert.ok((await dispatcher.listDeliveries(10)).length >= 5);
});
