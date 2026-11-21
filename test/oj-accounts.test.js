import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  submissionQueueKey,
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

test('OjAccounts cookie CRUD enforces write-only secrets, origin binding, permissions, rotation and delete guard', async t => {
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

  // Runtime origin & platform strong binding on resolveSecret and resolveAccountTransport
  assert.equal(
    await store.resolveSecret('cf-main-1', { platform: 'codeforces', origin: 'https://codeforces.com' }),
    initialCookie,
  );
  const atomicResolved = await store.resolveAccountTransport('cf-main-1', {
    platform: 'codeforces',
    origin: 'https://codeforces.com',
  });
  assert.equal(atomicResolved.secret, initialCookie);
  assert.equal(atomicResolved.account.handle, 'cr_cf_bot1');

  // Wrong origin or wrong platform MUST refuse to release secret
  await assert.rejects(
    store.resolveSecret('cf-main-1', { platform: 'codeforces', origin: 'https://evil.example.com' }),
    err => err instanceof OjAccountError && err.status === 409,
  );
  await assert.rejects(
    store.resolveSecret('cf-main-1', { platform: 'qoj', origin: 'https://codeforces.com' }),
    err => err instanceof OjAccountError && err.status === 409,
  );
  await assert.rejects(
    store.resolveAccountTransport('cf-main-1', { platform: 'codeforces', origin: 'https://mirror.codeforces.com' }),
    err => err instanceof OjAccountError && err.status === 409,
  );

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
  assert.equal(
    await store.resolveSecret('cf-main-1', { platform: 'codeforces', origin: 'https://codeforces.com' }),
    rotatedCookie,
  );
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

test('OjAccounts submitter transport verifies X_OK regular file (rejecting symlink to directory) and rejects secret rotation', async t => {
  const { base, store } = await makeTempStore(t);
  const scriptPath = join(base, 'cf-submitter.sh');
  await writeFile(scriptPath, '#!/bin/sh\necho \'{"submission_id":"1"}\'\n', { mode: 0o644 });

  // Symlink pointing to a directory MUST NOT be considered ready
  const someDir = join(base, 'some-dir');
  await mkdir(someDir, { mode: 0o755 });
  const dirSymlink = join(base, 'dir-link');
  await symlink(someDir, dirSymlink);

  const dirAcc = await store.create({
    id: 'qoj-dir-link',
    label: 'Bad Symlink',
    platform: 'qoj',
    handle: 'qoj_bot',
    transport: 'submitter',
    executable_path: dirSymlink,
  });
  assert.equal(dirAcc.ready, false);

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

  // Symlink pointing to an executable regular file IS ready
  const fileSymlink = join(base, 'file-link');
  await symlink(scriptPath, fileSymlink);
  const fileLinkAcc = await store.create({
    id: 'qoj-file-link',
    label: 'Good Symlink',
    platform: 'qoj',
    handle: 'qoj_bot',
    transport: 'submitter',
    executable_path: fileSymlink,
  });
  assert.equal(fileLinkAcc.ready, true);

  await assert.rejects(
    store.rotate('qoj-exec-1', rotatedCookie),
    err => err instanceof OjAccountError && err.status === 400,
  );
  await assert.rejects(
    store.resolveSecret('qoj-exec-1', { platform: 'qoj', origin: 'https://qoj.ac' }),
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

  // Third caller waits with no explicit pool (should still be counted in status('codeforces', 'shared')!);
  // fourth caller waits with explicit accountIds and aborts.
  const ac = new AbortController();
  const waiter3 = pool.acquire('codeforces', {});
  const waiter4 = pool.acquire('codeforces', { accountIds: ['cf-1'] }, ac.signal);

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

test('OjAccountPool handles concurrent release + abort during async lookup with zero lease leaks and no lost waiters', async t => {
  const { store } = await makeTempStore(t);
  await store.create({
    id: 'cf-r1',
    label: 'CF R1',
    platform: 'codeforces',
    handle: 'r1',
    pool: 'race',
    transport: 'cookie',
    secret: 'secret-race-0001',
  });
  await store.create({
    id: 'cf-r2',
    label: 'CF R2',
    platform: 'codeforces',
    handle: 'r2',
    pool: 'race',
    transport: 'cookie',
    secret: 'secret-race-0002',
  });

  // Wrap store.list() with controlled async deferral to deterministically trigger abort mid-lookup
  let deferNextList = false;
  let releaseDeferredList;
  let listStarted;
  const wrappedStore = Object.create(store);
  wrappedStore.list = async () => {
    if (deferNextList) {
      deferNextList = false;
      listStarted?.();
      await new Promise(resolve => {
        releaseDeferredList = resolve;
      });
    }
    return store.list();
  };

  const pool = new OjAccountPool(wrappedStore);
  const l1 = await pool.acquire('codeforces', { pool: 'race' });
  const l2 = await pool.acquire('codeforces', { pool: 'race' });

  const ac1 = new AbortController();
  const w1 = pool.acquire('codeforces', { pool: 'race' }, ac1.signal);
  const w2 = pool.acquire('codeforces', { pool: 'race' });
  const w3 = pool.acquire('codeforces', { pool: 'race' });
  await delay(10);

  // Trigger concurrent releases while w1 is mid-lookup, and abort w1 before lookup resolves!
  deferNextList = true;
  const startedPromise = new Promise(resolve => {
    listStarted = resolve;
  });
  l1.release();
  l2.release();
  await startedPromise;
  ac1.abort(new Error('aborted mid-dispatch'));
  releaseDeferredList();

  await assert.rejects(w1, /aborted mid-dispatch/);
  // Both w2 and w3 MUST receive the two freed leases with zero leaks and zero starvation!
  const [lease2, lease3] = await Promise.all([w2, w3]);
  assert.notEqual(lease2.account.id, lease3.account.id);

  lease2.release();
  lease3.release();
  assert.deepEqual(await pool.status('codeforces', 'race'), {
    total: 2,
    busy: 0,
    available: 2,
    queued: 0,
  });

  // If all remaining accounts are removed while a waiter is queued, releasing rejects the waiter promptly
  const held = await pool.acquire('codeforces', { accountIds: ['cf-r1'] });
  const doomed = pool.acquire('codeforces', { accountIds: ['cf-r1'] });
  await delay(10);
  await store.remove('cf-r1');
  held.release();
  await assert.rejects(doomed, err => err instanceof OjAccountError && err.status === 503);
});

test('OjAccountPool.enqueueSubmission strictly serializes writes per canonical handle key and allows cross-handle parallelism', async () => {
  const pool = new OjAccountPool([]);
  const timeline = [];
  let inFlightA = 0;
  let maxInFlightA = 0;

  // Two different account IDs pointing at the same (platform, origin, handle) share one canonical key
  const keyA1 = submissionQueueKey('codeforces', 'https://codeforces.com/', 'Bot_A');
  const keyA2 = submissionQueueKey('codeforces', 'https://codeforces.com', 'bot_a');
  const keyB = submissionQueueKey('codeforces', 'https://codeforces.com', 'bot_b');
  assert.equal(keyA1, keyA2);
  assert.notEqual(keyA1, keyB);

  const jobA = (key, label, ms) =>
    pool.enqueueSubmission(key, async () => {
      inFlightA++;
      maxInFlightA = Math.max(maxInFlightA, inFlightA);
      timeline.push(`start:${label}`);
      await delay(ms);
      timeline.push(`end:${label}`);
      inFlightA--;
      return label;
    });

  const abortMiddle = new AbortController();
  const p1 = jobA(keyA1, 'A1', 40);
  const pCancelled = pool.enqueueSubmission(
    keyA2,
    async () => {
      timeline.push('SHOULD_NOT_RUN');
      return 'cancelled';
    },
    abortMiddle.signal,
  );
  const p3 = jobA(keyA2, 'A3', 20);
  const pB = pool.enqueueSubmission(keyB, async () => {
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
  assert.ok(timeline.indexOf('end:B1') < timeline.indexOf('end:A1'));
});
