import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  OjAccountError,
  OjAccountPool,
  OjAccounts,
  createOjAccountSchema,
  ojAccountResponseSchema,
  ojAccountsResponseSchema,
} from '../dist/oj-accounts.js';

const initialCookie = 'JSESSIONID=test-only-cf-session-initial-001; 39ce7=fixtureA';
const rotatedCookie = 'JSESSIONID=test-only-cf-session-rotated-002; 39ce7=fixtureB';

function assertNoSecrets(text) {
  for (const s of [initialCookie, rotatedCookie]) {
    assert.ok(!text.includes(s), 'OJ account secret leaked into public output or metadata');
  }
}

async function makeTempStore(t) {
  const prevStorage = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  const base = await mkdtemp(join(tmpdir(), 'cr-oj-accounts-'));
  const store = new OjAccounts(join(base, 'oj-accounts'));
  t.after(async () => {
    if (prevStorage === undefined) delete process.env.CR_CREDENTIAL_STORAGE;
    else process.env.CR_CREDENTIAL_STORAGE = prevStorage;
    await rm(base, { recursive: true, force: true });
  });
  return { base, store };
}

test('OjAccounts cookie CRUD enforces write-only secrets, origin pinning, permissions, rotation and delete guard', async t => {
  const { store } = await makeTempStore(t);

  assert.deepEqual(await store.list(), []);

  // Secret cannot appear in public metadata
  await assert.rejects(
    store.create({
      id: 'cf-leak',
      label: `bad-${initialCookie}`,
      platform: 'codeforces',
      handle: 'cf_bot_1',
      transport: 'cookie',
      secret: initialCookie,
    }),
    err => err instanceof OjAccountError && err.status === 400,
  );

  // Hydro requires base_url and rejects non-HTTPS remote URLs
  assert.throws(() =>
    createOjAccountSchema.parse({
      label: 'Hydro missing URL',
      platform: 'hydro',
      handle: 'hydro_bot',
      transport: 'cookie',
      secret: initialCookie,
    }),
  );
  assert.throws(() =>
    createOjAccountSchema.parse({
      label: 'Hydro insecure HTTP',
      platform: 'hydro',
      handle: 'hydro_bot',
      transport: 'cookie',
      base_url: 'http://hydro.example.com',
      secret: initialCookie,
    }),
  );

  // Create cookie account
  const created = await store.create({
    id: 'cf-main-1',
    label: 'CF Bot #1',
    platform: 'codeforces',
    handle: 'cr_cf_bot1',
    pool: 'cf-pool-a',
    transport: 'cookie',
    base_url: 'https://codeforces.com/',
    secret: initialCookie,
  });

  ojAccountResponseSchema.parse(created);
  assertNoSecrets(JSON.stringify(created));
  assert.equal(created.id, 'cf-main-1');
  assert.equal(created.platform, 'codeforces');
  assert.equal(created.pool, 'cf-pool-a');
  assert.equal(created.transport, 'cookie');
  assert.equal(created.backend, 'file');
  assert.equal(created.ready, true);
  assert.equal(created.base_url, 'https://codeforces.com');
  assert.ok(created.credential_ref);

  // On-disk metadata contains no secret; credential file is 0o600
  const metaJson = await readFile(join(store.root, 'accounts', 'cf-main-1.json'), 'utf8');
  assertNoSecrets(metaJson);
  const credPath = join(store.root, 'credentials', created.credential_ref);
  assert.equal((await stat(credPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(credPath, 'utf8'), initialCookie);
  assert.equal(await store.resolveSecret('cf-main-1'), initialCookie);

  // Duplicate ID fails with 409
  await assert.rejects(
    store.create({
      id: 'cf-main-1',
      label: 'Duplicate',
      platform: 'codeforces',
      handle: 'cr_cf_bot1',
      transport: 'cookie',
      secret: rotatedCookie,
    }),
    err => err instanceof OjAccountError && err.status === 409,
  );

  // Patch metadata works, changing origin fails with 409
  const patched = await store.patch('cf-main-1', { label: 'CF Bot #1 Updated', pool: 'cf-pool-b' });
  assert.equal(patched.label, 'CF Bot #1 Updated');
  assert.equal(patched.pool, 'cf-pool-b');
  assertNoSecrets(JSON.stringify(patched));

  await assert.rejects(
    store.patch('cf-main-1', { base_url: 'https://mirror.example.test' }),
    err => err instanceof OjAccountError && err.status === 409,
  );

  // Degrading credential file permissions or removing it marks ready: false
  await chmod(credPath, 0o644);
  assert.equal((await store.get('cf-main-1')).ready, false);
  await rm(credPath);
  assert.equal((await store.get('cf-main-1')).ready, false);

  // Rotating restores ready: true and updates stored secret
  const rotated = await store.rotate('cf-main-1', { secret: rotatedCookie });
  assert.equal(rotated.ready, true);
  assertNoSecrets(JSON.stringify(rotated));
  assert.equal(await store.resolveSecret('cf-main-1'), rotatedCookie);
  assert.equal((await stat(credPath)).mode & 0o777, 0o600);

  // list() & listPool()
  const all = await store.list();
  ojAccountsResponseSchema.parse({ accounts: all });
  assertNoSecrets(JSON.stringify(all));
  assert.equal((await store.listPool('codeforces', 'cf-pool-b')).length, 1);
  assert.equal((await store.listPool('codeforces', 'cf-pool-a')).length, 0);
  assert.equal((await store.listPool('qoj')).length, 0);

  // Delete guard blocks deletion while referenced
  await assert.rejects(
    store.remove('cf-main-1', async id => id === 'cf-main-1'),
    err => err instanceof OjAccountError && err.status === 409,
  );
  await store.remove('cf-main-1', async () => false);
  await assert.rejects(stat(credPath), { code: 'ENOENT' });
  await assert.rejects(store.get('cf-main-1'), err => err instanceof OjAccountError && err.status === 404);
});

test('OjAccounts submitter transport verifies X_OK readiness and rejects secret rotation', async t => {
  const { base, store } = await makeTempStore(t);
  const scriptPath = join(base, 'cf-submitter.sh');
  await writeFile(scriptPath, '#!/bin/sh\necho \'{"submission_id":"1"}\'\n', { mode: 0o644 });

  const acc = await store.create({
    id: 'qoj-exec-1',
    label: 'QOJ Submitter',
    platform: 'qoj',
    handle: 'qoj_bot',
    transport: 'submitter',
    executable_path: scriptPath,
  });

  assert.equal(acc.backend, 'executable');
  assert.equal(acc.pool, 'qoj'); // defaults to platform
  assert.equal(acc.ready, false); // not executable yet

  await chmod(scriptPath, 0o755);
  assert.equal((await store.get('qoj-exec-1')).ready, true);

  await assert.rejects(
    store.rotate('qoj-exec-1', rotatedCookie),
    err => err instanceof OjAccountError && err.status === 400,
  );
  await assert.rejects(
    store.resolveSecret('qoj-exec-1'),
    err => err instanceof OjAccountError && err.status === 400,
  );
});

test('OjAccountPool manages exclusive leasing, queueing, double-release safety and AbortSignal cancellation', async t => {
  const { store } = await makeTempStore(t);
  await store.create({
    id: 'cf-1',
    label: 'CF 1',
    platform: 'codeforces',
    handle: 'bot1',
    pool: 'shared',
    transport: 'cookie',
    secret: 'cookie-secret-alpha-0001',
  });
  await store.create({
    id: 'cf-2',
    label: 'CF 2',
    platform: 'codeforces',
    handle: 'bot2',
    pool: 'shared',
    transport: 'cookie',
    secret: 'cookie-secret-beta-0002',
  });

  const pool = new OjAccountPool(store);
  assert.deepEqual(await pool.status('codeforces', 'shared'), {
    total: 2,
    busy: 0,
    available: 2,
    queued: 0,
  });

  const lease1 = await pool.acquire('codeforces', { pool: 'shared' });
  const lease2 = await pool.acquire('codeforces', { pool: 'shared' });
  assert.notEqual(lease1.account.id, lease2.account.id);

  // Third caller waits in queue; fourth caller aborts while waiting
  const ac = new AbortController();
  const waiter3 = pool.acquire('codeforces', { pool: 'shared' });
  const waiter4 = pool.acquire('codeforces', { pool: 'shared' }, ac.signal);

  // Give microtasks a tick so waiters register
  await delay(10);
  assert.deepEqual(await pool.status('codeforces', 'shared'), {
    total: 2,
    busy: 2,
    available: 0,
    queued: 2,
  });

  ac.abort(new Error('caller cancelled'));
  await assert.rejects(waiter4, /caller cancelled/);

  assert.deepEqual(await pool.status('codeforces', 'shared'), {
    total: 2,
    busy: 2,
    available: 0,
    queued: 1,
  });

  // Releasing lease1 hands that account directly to waiter3; double release is a safe no-op
  const releasedId = lease1.account.id;
  lease1.release();
  lease1.release();
  const lease3 = await waiter3;
  assert.equal(lease3.account.id, releasedId);

  lease2.release();
  lease3.release();
  assert.deepEqual(await pool.status('codeforces', 'shared'), {
    total: 2,
    busy: 0,
    available: 2,
    queued: 0,
  });
});

test('OjAccountPool.enqueueSubmission strictly serializes writes per account and allows cross-account parallelism', async () => {
  const pool = new OjAccountPool([]);
  const timeline = [];
  let inFlightA = 0;
  let maxInFlightA = 0;

  const jobA = (label, ms) =>
    pool.enqueueSubmission('acc-A', async () => {
      inFlightA++;
      maxInFlightA = Math.max(maxInFlightA, inFlightA);
      timeline.push(`start:${label}`);
      await delay(ms);
      timeline.push(`end:${label}`);
      inFlightA--;
      return label;
    });

  const abortMiddle = new AbortController();
  const p1 = jobA('A1', 40);
  const pCancelled = pool.enqueueSubmission(
    'acc-A',
    async () => {
      timeline.push('SHOULD_NOT_RUN');
      return 'cancelled';
    },
    abortMiddle.signal,
  );
  const p3 = jobA('A3', 20);
  const pB = pool.enqueueSubmission('acc-B', async () => {
    timeline.push('start:B1');
    await delay(15);
    timeline.push('end:B1');
    return 'B1';
  });

  abortMiddle.abort(new Error('cancel-middle'));
  await assert.rejects(pCancelled, /cancel-middle/);

  const [r1, r3, rB] = await Promise.all([p1, p3, pB]);
  assert.equal(r1, 'A1');
  assert.equal(r3, 'A3');
  assert.equal(rB, 'B1');
  assert.equal(maxInFlightA, 1);
  assert.ok(!timeline.includes('SHOULD_NOT_RUN'));
  assert.ok(timeline.indexOf('end:A1') < timeline.indexOf('start:A3'));
  // B1 ran in parallel with A1 and finished before A1 finished
  assert.ok(timeline.indexOf('end:B1') < timeline.indexOf('end:A1'));
});
