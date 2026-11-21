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

  // Loose credential permissions mark credential_available: false until rotated
  await chmod(oldCredFile, 0o644);
  assert.equal((await store.get('prod-hook')).credential_available, false);

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

  // 1. Outbound payload whitelist canary test: private fields must NEVER leave the host!
  const canaryPayload = {
    run_id: '11111111-1111-4111-8111-111111111111',
    contest_id: 'demo-contest',
    score: 300,
    max_score: 500,
    reason: 'failed at /home/alice/private/judge.json with Bearer CANARY_BEARER_XYZ',
    source: 'CANARY_SOURCE_CODE',
    answer: 'CANARY_LOCAL_ANSWER',
    stdout: 'CANARY_STDOUT_LOG',
    stderr: 'CANARY_STDERR_LOG',
    local_inputs: { pdf: '/home/alice/secret.pdf' },
    session: 'CANARY_SESSION_TRANSCRIPT',
    extra_nested: { secret: 'CANARY_UNDECLARED_NESTED' },
    submissions: [
      {
        submission_id: 's1',
        problem_id: 'A',
        elapsed_ms: 1000,
        verdict: 'AC',
        source: 'CANARY_SUB_SOURCE',
        answer: 'CANARY_SUB_ANSWER',
      },
    ],
  };

  const sanitizedDirect = sanitizePushPayload('run.completed', canaryPayload);
  const sanitizedStr = JSON.stringify(sanitizedDirect);
  for (const canary of [
    'CANARY_SOURCE_CODE',
    'CANARY_LOCAL_ANSWER',
    'CANARY_STDOUT_LOG',
    'CANARY_STDERR_LOG',
    'CANARY_SESSION_TRANSCRIPT',
    'CANARY_UNDECLARED_NESTED',
    'CANARY_SUB_SOURCE',
    'CANARY_SUB_ANSWER',
    'CANARY_BEARER_XYZ',
    '/home/alice',
  ]) {
    assert.ok(!sanitizedStr.includes(canary), `Whitelist leaked canary: ${canary}`);
  }

  const runResults = await dispatcher.deliver('run.completed', canaryPayload);
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
  assert.equal(requests.filter(r => r.url === '/bearer').length, 1);

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

  // 6. Short secret & symbol Bearer redaction + safe fixed error codes on transport failure
  assert.equal(sanitizeDeliveryError('failed with key abc12', 'abc12'), 'failed with key [REDACTED]');
  assert.equal(sanitizeDeliveryError('header Authorization: Bearer tok!@#$%xyz failed'), 'header Authorization: Bearer [REDACTED] failed');

  const leakedFetch = async () => {
    throw new Error(`upstream rejected Authorization: Bearer ${bearerSecret} at https://secret.host/?k=1`);
  };
  const failedLeak = await dispatcher.testTarget('t-bearer', { fetchImpl: leakedFetch, sleep: fastSleep });
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
