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

test('PushTargets enforces write-only credential storage, origin pinning, and CRUD validation', async t => {
  useFileSecretBackend(t);
  const root = await mkdtemp(join(tmpdir(), 'cr-push-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new PushTargets(join(root, 'targets-store'));
  const bearerSecret = 'cr-test-bearer-token-initial-001';
  const rotatedSecret = 'cr-test-bearer-token-rotated-002';

  assert.deepEqual(await store.list(), []);

  // Reject unsafe URLs (non-loopback HTTP, userinfo, fragment)
  assert.throws(() => createPushTargetSchema.parse({
    label: 'Insecure',
    url: 'http://example.com/hook',
    events: ['run.completed'],
    auth_mode: 'none',
  }));
  assert.throws(() => createPushTargetSchema.parse({
    label: 'Userinfo',
    url: 'https://user:pass@example.com/hook',
    events: ['run.completed'],
    auth_mode: 'none',
  }));
  assert.throws(() => createPushTargetSchema.parse({
    label: 'Fragment',
    url: 'https://example.com/hook#frag',
    events: ['run.completed'],
    auth_mode: 'none',
  }));
  // Reject auth_mode / secret mismatches
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
  // Reject secret embedded in public metadata
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
    url: 'https://hooks.example.test/events?team=bench',
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
  const credFile = join(store.root, 'credentials', created.credential_ref);
  assert.equal((await stat(store.root)).mode & 0o777, 0o700);
  assert.equal((await stat(targetFile)).mode & 0o777, 0o600);
  assert.equal((await stat(credFile)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(targetFile, 'utf8')).includes(bearerSecret), 'Secret must not appear in target JSON');
  assert.equal(await readFile(credFile, 'utf8'), bearerSecret);

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
  // Strict patch schema rejects secret mutation via patch
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
  await chmod(credFile, 0o644);
  assert.equal((await store.get('prod-hook')).credential_available, false);

  // Rotate secret restores 0o600 credential without exposing value
  assert.doesNotThrow(() => rotatePushTargetSchema.parse({ secret: rotatedSecret }));
  const rotated = await store.rotate('prod-hook', { secret: rotatedSecret });
  assert.equal(rotated.credential_available, true);
  assert.equal(rotated.credential_ref, created.credential_ref);
  assert.ok(!JSON.stringify(rotated).includes(rotatedSecret));
  assert.equal(await readFile(credFile, 'utf8'), rotatedSecret);
  assert.equal((await stat(credFile)).mode & 0o777, 0o600);

  // List never echoes secrets
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(bearerSecret));
  assert.ok(!JSON.stringify(listed).includes(rotatedSecret));

  // Remove deletes both target and credential file
  await store.remove('prod-hook');
  await assert.rejects(stat(credFile), { code: 'ENOENT' });
  await assert.rejects(store.get('prod-hook'), error => error instanceof PushTargetError && error.status === 404);
});

test('PushDispatcher delivers Bearer & HMAC-SHA256 webhooks, retries 503/429, skips retry on 400/redirect, and logs sanitized history', async t => {
  useFileSecretBackend(t);
  const root = await mkdtemp(join(tmpdir(), 'cr-push-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bearerSecret = 'secret-bearer-token-987654321';
  const hmacSecret = 'secret-hmac-signing-key-abcdef123456';
  const sleepDelays = [];
  const fastSleep = async ms => { sleepDelays.push(ms); };

  let retry503Count = 0;
  let retry429Count = 0;

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

  const dispatcher = new PushDispatcher(store, { sleep: fastSleep });

  // 1. Deliver run.completed -> hits t-bearer and t-hmac, skips t-disabled and batch.completed targets
  const completedPayload = { run_id: '11111111-1111-4111-8111-111111111111', score: 300 };
  const runResults = await dispatcher.deliver('run.completed', completedPayload);
  assert.equal(runResults.length, 2);
  for (const r of runResults) {
    assert.doesNotThrow(() => pushDeliverySchema.parse(r));
    assert.equal(r.status, 'delivered');
    assert.equal(r.attempts, 1);
  }

  const bearerReq = requests.find(r => r.url === '/bearer');
  assert.equal(bearerReq.headers['authorization'], `Bearer ${bearerSecret}`);
  assert.equal(bearerReq.headers['content-type'], 'application/json');
  assert.equal(bearerReq.headers['x-cr-event'], 'run.completed');
  assert.ok(bearerReq.headers['x-cr-delivery-id']);
  assert.ok(bearerReq.headers['x-cr-timestamp']);
  assert.deepEqual(bearerReq.json, completedPayload);

  const hmacReq = requests.find(r => r.url === '/hmac');
  assert.equal(hmacReq.headers['authorization'], undefined);
  assert.equal(hmacReq.headers['x-cr-event'], 'run.completed');
  const sig = hmacReq.headers['x-cr-signature-256'];
  const ts = hmacReq.headers['x-cr-timestamp'];
  assert.ok(sig && ts);
  assert.equal(sig, signPushPayload(hmacSecret, hmacReq.rawBody, ts));
  assert.equal(verifyPushSignature(hmacSecret, hmacReq.rawBody, ts, sig), true);
  assert.equal(verifyPushSignature(hmacSecret, hmacReq.rawBody + ' ', ts, sig), false);
  assert.equal(verifyPushSignature(hmacSecret, hmacReq.rawBody, String(Number(ts) + 1), sig), false);
  assert.equal(verifyPushSignature('wrong-secret', hmacReq.rawBody, ts, sig), false);

  // 2. Deliver batch.completed -> tests 503 retry, 429 retry, 400 no-retry, 302 redirect rejection
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
  // Ensure redirect target never followed to /bearer
  assert.equal(requests.filter(r => r.url === '/bearer').length, 1);
  // Backoff delays recorded in deterministic target-id order: t-429 (250), t-flaky (250, 500)
  assert.deepEqual(sleepDelays, [250, 250, 500]);

  // 2b. targetIds restricts delivery to specified enabled subscribed targets
  const targeted = await dispatcher.deliver('run.completed', completedPayload, { targetIds: ['t-hmac', 't-disabled'] });
  assert.equal(targeted.length, 1);
  assert.equal(targeted[0].target_id, 't-hmac');
  assert.equal(targeted[0].status, 'delivered');

  // 3. testTarget sends lightweight { type: 'ping', timestamp } even when disabled
  const pingRes = await dispatcher.testTarget('t-disabled');
  assert.equal(pingRes.status, 'delivered');
  assert.equal(pingRes.event, 'ping');
  const pingReq = requests.filter(r => r.url === '/bearer')[1];
  assert.equal(pingReq.headers['x-cr-event'], 'ping');
  assert.equal(pingReq.json.type, 'ping');
  assert.ok(typeof pingReq.json.timestamp === 'string');

  // 4. Secret never leaks into delivery log even if fetch throws error containing the secret
  const leakedFetch = async () => {
    throw new Error(`upstream rejected Authorization: Bearer ${bearerSecret}`);
  };
  const failedLeak = await dispatcher.testTarget('t-bearer', { fetchImpl: leakedFetch, sleep: fastSleep });
  assert.equal(failedLeak.status, 'failed');
  assert.ok(!failedLeak.error.includes(bearerSecret));

  // 5. listDeliveries returns newest-first sanitized history
  const history = await dispatcher.listDeliveries(50);
  assert.equal(history.length, 9);
  assert.equal(history[0].delivery_id, failedLeak.delivery_id);
  assert.equal(history[1].delivery_id, pingRes.delivery_id);

  const filtered = await dispatcher.listDeliveries(10, 't-hmac');
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].target_id, 't-hmac');

  const logRaw = await readFile(dispatcher.deliveriesFile, 'utf8');
  assert.equal((await stat(dispatcher.deliveriesFile)).mode & 0o777, 0o600);
  assert.ok(!logRaw.includes(bearerSecret), 'Bearer secret leaked into deliveries.jsonl');
  assert.ok(!logRaw.includes(hmacSecret), 'HMAC secret leaked into deliveries.jsonl');
});
