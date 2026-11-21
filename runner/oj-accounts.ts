import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { endpoint } from './connections.js';

export const ojPlatformSchema = z.enum(['codeforces', 'qoj', 'vjudge', 'hydro']);
export type OjPlatform = z.infer<typeof ojPlatformSchema>;

export const ojTransportSchema = z.enum(['cookie', 'submitter']);
export type OjTransport = z.infer<typeof ojTransportSchema>;

export const ojBackendSchema = z.enum(['secret-service', 'file', 'executable']);
export type OjBackend = z.infer<typeof ojBackendSchema>;

export const ojAccountId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const ojPoolName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const ojHandle = z.string().trim().min(1).max(80).regex(/^[^\r\n\t]+$/);
export const ojExecutablePath = z.string().trim().min(1).max(4096).refine(
  value => isAbsolute(value) && !/[\r\n\0]/.test(value),
  'Executable path must be an absolute path without control characters',
);
// Cookies/tokens may contain spaces (e.g. "a=1; b=2") but never CR/LF or non-ASCII control chars.
export const ojSecretSchema = z.string().trim().min(1).max(16_384).regex(/^[\x20-\x7e]+$/);

const isoTimestamp = z.iso.datetime();

export function defaultOriginFor(platform: OjPlatform): string | undefined {
  switch (platform) {
    case 'codeforces':
      return 'https://codeforces.com';
    case 'qoj':
      return 'https://qoj.ac';
    case 'vjudge':
      return 'https://vjudge.net';
    case 'hydro':
      return undefined;
  }
}

export function effectiveOriginFor(account: { platform: OjPlatform; base_url?: string; approved_origin?: string }): string | undefined {
  if (account.approved_origin) return account.approved_origin;
  if (account.base_url) return new URL(account.base_url).origin;
  return defaultOriginFor(account.platform);
}

export function submissionQueueKey(platform: OjPlatform, origin: string, handle: string): string {
  const normalizedOrigin = new URL(origin).origin;
  return `${platform}:${normalizedOrigin}:${handle.trim().toLowerCase()}`;
}

const storedOjAccountSchema = z.strictObject({
  id: ojAccountId,
  label: z.string().trim().min(1).max(120),
  platform: ojPlatformSchema,
  handle: ojHandle,
  pool: ojPoolName,
  transport: ojTransportSchema,
  base_url: endpoint.optional(),
  approved_origin: z.string().optional(),
  executable_path: ojExecutablePath.optional(),
  credential_ref: z.uuid().optional(),
  backend: ojBackendSchema,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
}).superRefine((value, ctx) => {
  if (value.platform === 'hydro' && !value.base_url) {
    ctx.addIssue({ code: 'custom', path: ['base_url'], message: 'Hydro accounts require base_url' });
  }
  if (value.base_url && value.approved_origin !== new URL(value.base_url).origin) {
    ctx.addIssue({ code: 'custom', path: ['approved_origin'], message: 'Approved origin does not match base_url' });
  }
  if (value.transport === 'cookie') {
    if (!value.credential_ref) ctx.addIssue({ code: 'custom', path: ['credential_ref'], message: 'Cookie account requires credential_ref' });
    if (value.executable_path) ctx.addIssue({ code: 'custom', path: ['executable_path'], message: 'Cookie account cannot set executable_path' });
    if (value.backend === 'executable') ctx.addIssue({ code: 'custom', path: ['backend'], message: 'Cookie account cannot use executable backend' });
  } else {
    if (!value.executable_path) ctx.addIssue({ code: 'custom', path: ['executable_path'], message: 'Submitter account requires executable_path' });
    if (value.credential_ref) ctx.addIssue({ code: 'custom', path: ['credential_ref'], message: 'Submitter account cannot set credential_ref' });
    if (value.backend !== 'executable') ctx.addIssue({ code: 'custom', path: ['backend'], message: 'Submitter account must use executable backend' });
  }
});

type StoredOjAccount = z.infer<typeof storedOjAccountSchema>;

const createBase = {
  id: ojAccountId.optional(),
  label: z.string().trim().min(1).max(120),
  platform: ojPlatformSchema,
  handle: ojHandle,
  pool: ojPoolName.optional(),
  base_url: endpoint.optional(),
};

const createCookieSchema = z.strictObject({
  ...createBase,
  transport: z.literal('cookie'),
  secret: ojSecretSchema,
});

const createSubmitterSchema = z.strictObject({
  ...createBase,
  transport: z.literal('submitter'),
  executable_path: ojExecutablePath,
});

export const createOjAccountSchema = z.discriminatedUnion('transport', [
  createCookieSchema,
  createSubmitterSchema,
]).superRefine((value, ctx) => {
  if (value.platform === 'hydro' && !value.base_url) {
    ctx.addIssue({ code: 'custom', path: ['base_url'], message: 'Hydro accounts require base_url' });
  }
});

export const patchOjAccountSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  handle: ojHandle.optional(),
  pool: ojPoolName.optional(),
  base_url: endpoint.optional(),
  executable_path: ojExecutablePath.optional(),
});

export const rotateOjAccountSchema = z.strictObject({
  secret: ojSecretSchema,
});

export const ojAccountResponseSchema = z.strictObject({
  id: ojAccountId,
  label: z.string(),
  platform: ojPlatformSchema,
  handle: ojHandle,
  pool: ojPoolName,
  transport: ojTransportSchema,
  base_url: endpoint.optional(),
  executable_path: ojExecutablePath.optional(),
  credential_ref: z.uuid().optional(),
  backend: ojBackendSchema,
  ready: z.boolean(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export const ojAccountsResponseSchema = z.strictObject({
  accounts: z.array(ojAccountResponseSchema),
});

export type CreateOjAccountInput = z.infer<typeof createOjAccountSchema>;
export type PatchOjAccountInput = z.infer<typeof patchOjAccountSchema>;
export type RotateOjAccountInput = z.infer<typeof rotateOjAccountSchema>;
export type OjAccount = z.infer<typeof ojAccountResponseSchema>;

export interface ExpectedAccountBinding {
  platform: OjPlatform;
  origin: string;
  handle?: string;
  credential_ref?: string;
}

export interface ResolvedAccountTransport {
  account: OjAccount;
  secret?: string;
  executable_path?: string;
}

export class OjAccountError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'OjAccountError';
  }
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

function toPublic(value: StoredOjAccount, ready: boolean): OjAccount {
  return {
    id: value.id,
    label: value.label,
    platform: value.platform,
    handle: value.handle,
    pool: value.pool,
    transport: value.transport,
    ...(value.base_url ? { base_url: value.base_url } : {}),
    ...(value.executable_path ? { executable_path: value.executable_path } : {}),
    ...(value.credential_ref ? { credential_ref: value.credential_ref } : {}),
    backend: value.backend,
    ready,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function assertAccountBinding(value: StoredOjAccount, expected: ExpectedAccountBinding) {
  if (value.platform !== expected.platform) {
    throw new OjAccountError(
      `OJ account ${value.id} belongs to platform "${value.platform}", expected "${expected.platform}"`,
      409,
    );
  }
  const boundOrigin = effectiveOriginFor(value);
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(expected.origin).origin;
  } catch {
    throw new OjAccountError('Invalid expected origin for OJ account binding', 400);
  }
  if (!boundOrigin || boundOrigin !== expectedOrigin) {
    throw new OjAccountError(
      `OJ account ${value.id} is bound to a different origin; refusing to release credential`,
      409,
    );
  }
  if (expected.handle !== undefined && value.handle.toLowerCase() !== expected.handle.toLowerCase()) {
    throw new OjAccountError(
      `OJ account ${value.id} handle changed since lease acquisition; refusing to release credential`,
      409,
    );
  }
  if (expected.credential_ref !== undefined && value.credential_ref !== expected.credential_ref) {
    throw new OjAccountError(
      `OJ account ${value.id} credential reference changed since lease acquisition; refusing to release credential`,
      409,
    );
  }
}

function checkPublicMetadata(
  secretValue: string,
  meta: Pick<StoredOjAccount, 'id' | 'label' | 'handle' | 'pool' | 'base_url'>,
) {
  const fields = [meta.id, meta.label, meta.handle, meta.pool, ...(meta.base_url ? [meta.base_url] : [])];
  if (fields.some(field => field === secretValue || (secretValue.length >= 8 && field.includes(secretValue)))) {
    throw new OjAccountError('A credential cannot be part of public OJ account metadata', 400);
  }
}

async function assertPrivateDir(dir: string) {
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new OjAccountError('OJ account storage must be an owner-only directory', 500);
  }
}

async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateDir(dir);
}

async function readPrivate(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 65_536) {
      throw new OjAccountError('OJ account storage has unsafe permissions', 500);
    }
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== info.size) throw new OjAccountError('OJ account storage changed while reading', 500);
    return bytes.subarray(0, size).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, text: string, create = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    if (create) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

const secretChannel = (op: 'store' | 'lookup' | 'clear', ref: string, input?: string) =>
  new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(
      'secret-tool',
      [
        op,
        ...(op === 'store' ? ['--label=ContestReplay OJ account credential'] : []),
        'application',
        'contestreplay-oj',
        'credential',
        ref,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], timeout: 2500 },
    );
    let value = '';
    child.stdout.setEncoding('utf8').on('data', part => {
      value += part;
      if (value.length > 20_000) child.kill();
    });
    child.stdin.on('error', () => {});
    child.once('error', rejectPromise);
    child.once('close', code =>
      code === 0 ? resolvePromise(value.trim()) : rejectPromise(new Error('OS credential store unavailable')),
    );
    child.stdin.end(input);
  });

export class OjAccounts {
  readonly root: string;

  constructor(
    root = process.env.CR_OJ_ACCOUNTS_DIR ||
      join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'contestreplay', 'oj-accounts'),
  ) {
    this.root = resolve(root);
  }

  private get index() { return join(this.root, 'accounts'); }
  private get secrets() { return join(this.root, 'credentials'); }
  private path(id: string) { return join(this.index, `${ojAccountId.parse(id)}.json`); }

  private async stored(id: string): Promise<StoredOjAccount> {
    try {
      await assertPrivateDir(this.root);
      await assertPrivateDir(this.index);
      const parsed = storedOjAccountSchema.parse(JSON.parse(await readPrivate(this.path(id))));
      if (parsed.id !== id) throw new Error('Invalid OJ account record');
      return parsed;
    } catch (e) {
      if (missing(e)) throw new OjAccountError('OJ account not found', 404);
      throw e;
    }
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await privateDir(this.root);
    const handle = await open(
      join(this.root, '.oj-accounts.lock'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const result = await new Promise<number | null>((resolvePromise, rejectPromise) => {
        const child = spawn('flock', ['-x', '-w', '10', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', handle.fd],
        });
        child.once('error', rejectPromise);
        child.once('close', resolvePromise);
      }).catch(() => {
        throw new OjAccountError('OJ account storage lock unavailable', 503);
      });
      if (result !== 0) throw new OjAccountError('OJ account storage is busy; retry shortly', 503);
      return await fn();
    } finally {
      await handle.close();
    }
  }

  private async ids(): Promise<string[]> {
    try {
      await assertPrivateDir(this.root);
      await assertPrivateDir(this.index);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const names = await readdir(this.index).catch(e => {
      if (missing(e)) return [];
      throw e;
    });
    return names.sort().filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
  }

  private async readSecret(value: StoredOjAccount): Promise<string> {
    if (value.transport !== 'cookie' || !value.credential_ref) {
      throw new OjAccountError('OJ account does not store a cookie credential', 400);
    }
    if (value.backend === 'file') {
      await assertPrivateDir(this.secrets);
      return ojSecretSchema.parse(await readPrivate(join(this.secrets, value.credential_ref)));
    }
    if (value.backend === 'secret-service') {
      return ojSecretSchema.parse(await secretChannel('lookup', value.credential_ref));
    }
    throw new OjAccountError('Unsupported credential backend', 500);
  }

  private async checkReady(value: StoredOjAccount): Promise<boolean> {
    if (value.transport === 'submitter') {
      if (!value.executable_path) return false;
      try {
        // Use stat() (following symlinks) so a symlink to a directory is rejected.
        const info = await stat(value.executable_path);
        if (!info.isFile()) return false;
        await access(value.executable_path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    return this.readSecret(value).then(() => true, () => false);
  }

  private async putSecret(
    ref: string,
    secretValue: string,
    backend?: 'secret-service' | 'file',
  ): Promise<'secret-service' | 'file'> {
    if (
      backend === 'secret-service' ||
      (!backend && process.env.DBUS_SESSION_BUS_ADDRESS && process.env.CR_CREDENTIAL_STORAGE !== 'file')
    ) {
      try {
        await secretChannel('store', ref, secretValue);
        return 'secret-service';
      } catch {
        if (backend) throw new OjAccountError('OS credential store unavailable', 503);
      }
    }
    await privateDir(this.secrets);
    await atomicWrite(join(this.secrets, ref), secretValue);
    return 'file';
  }

  private async forgetSecret(old: StoredOjAccount) {
    if (old.transport !== 'cookie' || !old.credential_ref) return;
    if (old.backend === 'file') {
      await assertPrivateDir(this.secrets).catch(error => {
        if (!missing(error)) throw error;
      });
      await rm(join(this.secrets, old.credential_ref), { force: true });
    } else if (old.backend === 'secret-service') {
      await secretChannel('clear', old.credential_ref);
    }
  }

  async get(id: string): Promise<OjAccount> {
    const value = await this.stored(id);
    return toPublic(value, await this.checkReady(value));
  }

  async list(): Promise<OjAccount[]> {
    const ids = await this.ids();
    const result: OjAccount[] = [];
    for (let i = 0; i < ids.length; i += 8) {
      const batch = await Promise.all(
        ids.slice(i, i + 8).map(id =>
          this.get(id).catch(error => {
            if (!(error instanceof OjAccountError) || error.status !== 404) throw error;
            return undefined;
          }),
        ),
      );
      for (const item of batch) if (item !== undefined) result.push(item);
    }
    return result;
  }

  async listPool(platform: OjPlatform, pool?: string): Promise<OjAccount[]> {
    const all = await this.list();
    return all.filter(acc => acc.platform === platform && (pool === undefined || acc.pool === pool));
  }

  /**
   * Host-only secret lookup bound to the caller's target platform and origin.
   * Reads the stored account record once and validates platform + approved origin
   * before touching or returning the stored credential.
   */
  async resolveSecret(id: string, expected: ExpectedAccountBinding): Promise<string> {
    const value = await this.stored(id);
    assertAccountBinding(value, expected);
    if (value.transport !== 'cookie') {
      throw new OjAccountError('OJ account uses submitter transport, not a stored cookie secret', 400);
    }
    try {
      return await this.readSecret(value);
    } catch (error) {
      if (error instanceof OjAccountError && error.status === 400) throw error;
      throw new OjAccountError('OJ account credential unavailable; rotate it to restore access', 503);
    }
  }

  /**
   * Atomically read an OJ account record once, validate its platform and origin
   * binding, and resolve either its cookie secret or executable submitter path.
   */
  async resolveAccountTransport(id: string, expected: ExpectedAccountBinding): Promise<ResolvedAccountTransport> {
    const value = await this.stored(id);
    assertAccountBinding(value, expected);
    if (value.transport === 'cookie') {
      let secret: string;
      try {
        secret = await this.readSecret(value);
      } catch (error) {
        if (error instanceof OjAccountError && error.status === 400) throw error;
        throw new OjAccountError('OJ account credential unavailable; rotate it to restore access', 503);
      }
      return { account: toPublic(value, true), secret };
    }
    const ready = await this.checkReady(value);
    if (!ready || !value.executable_path) {
      throw new OjAccountError('OJ account submitter executable is not accessible', 503);
    }
    return { account: toPublic(value, true), executable_path: value.executable_path };
  }

  create(rawInput: CreateOjAccountInput): Promise<OjAccount> {
    return this.locked(async () => {
      const input = createOjAccountSchema.parse(rawInput);
      const id = input.id ?? `oj-${input.platform}-${randomUUID()}`;
      const pool = input.pool ?? input.platform;
      const now = new Date().toISOString();
      await privateDir(this.index);
      try {
        await lstat(this.path(id));
        throw new OjAccountError('OJ account already exists', 409);
      } catch (e) {
        if (!missing(e)) throw e;
      }

      const approved_origin = input.base_url ? new URL(input.base_url).origin : undefined;

      if (input.transport === 'cookie') {
        checkPublicMetadata(input.secret, {
          id,
          label: input.label,
          handle: input.handle,
          pool,
          base_url: input.base_url,
        });
        const ref = randomUUID();
        const backend = await this.putSecret(ref, input.secret);
        const record: StoredOjAccount = storedOjAccountSchema.parse({
          id,
          label: input.label,
          platform: input.platform,
          handle: input.handle,
          pool,
          transport: 'cookie',
          ...(input.base_url ? { base_url: input.base_url, approved_origin } : {}),
          credential_ref: ref,
          backend,
          created_at: now,
          updated_at: now,
        });
        try {
          await atomicWrite(this.path(id), JSON.stringify(record), true);
        } catch (e) {
          await this.forgetSecret(record).catch(() => {});
          throw e;
        }
        return toPublic(record, true);
      }

      const record: StoredOjAccount = storedOjAccountSchema.parse({
        id,
        label: input.label,
        platform: input.platform,
        handle: input.handle,
        pool,
        transport: 'submitter',
        ...(input.base_url ? { base_url: input.base_url, approved_origin } : {}),
        executable_path: input.executable_path,
        backend: 'executable',
        created_at: now,
        updated_at: now,
      });
      await atomicWrite(this.path(id), JSON.stringify(record), true);
      return toPublic(record, await this.checkReady(record));
    });
  }

  patch(id: string, rawPatch: PatchOjAccountInput): Promise<OjAccount> {
    return this.locked(async () => {
      const patch = patchOjAccountSchema.parse(rawPatch);
      const old = await this.stored(id);
      if (patch.executable_path !== undefined && old.transport !== 'submitter') {
        throw new OjAccountError('Cannot set executable_path on a cookie OJ account', 400);
      }
      if (patch.base_url !== undefined) {
        const nextOrigin = new URL(patch.base_url).origin;
        if (old.approved_origin && nextOrigin !== old.approved_origin) {
          throw new OjAccountError('Create a new OJ account to authorize a different origin', 409);
        }
        if (!old.approved_origin) {
          throw new OjAccountError('Create a new OJ account to bind a custom origin', 409);
        }
      }

      const updated: StoredOjAccount = storedOjAccountSchema.parse({
        ...old,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
        ...(patch.pool !== undefined ? { pool: patch.pool } : {}),
        ...(patch.base_url !== undefined ? { base_url: patch.base_url } : {}),
        ...(patch.executable_path !== undefined ? { executable_path: patch.executable_path } : {}),
        updated_at: new Date().toISOString(),
      });

      if (old.transport === 'cookie') {
        const current = await this.readSecret(old).catch(() => undefined);
        if (current) {
          checkPublicMetadata(current, {
            id: updated.id,
            label: updated.label,
            handle: updated.handle,
            pool: updated.pool,
            base_url: updated.base_url,
          });
        }
      }

      await atomicWrite(this.path(id), JSON.stringify(updated));
      return toPublic(updated, await this.checkReady(updated));
    });
  }

  rotate(id: string, rawSecret: string | RotateOjAccountInput): Promise<OjAccount> {
    return this.locked(async () => {
      const secretValue =
        typeof rawSecret === 'string' ? ojSecretSchema.parse(rawSecret) : rotateOjAccountSchema.parse(rawSecret).secret;
      const old = await this.stored(id);
      if (old.transport !== 'cookie' || !old.credential_ref || old.backend === 'executable') {
        throw new OjAccountError('Cannot rotate secret on a submitter OJ account', 400);
      }
      checkPublicMetadata(secretValue, {
        id: old.id,
        label: old.label,
        handle: old.handle,
        pool: old.pool,
        base_url: old.base_url,
      });
      await this.putSecret(old.credential_ref, secretValue, old.backend);
      const updated: StoredOjAccount = { ...old, updated_at: new Date().toISOString() };
      await atomicWrite(this.path(id), JSON.stringify(updated));
      return toPublic(updated, true);
    });
  }

  remove(id: string, referenced?: (id: string) => Promise<boolean>): Promise<void> {
    return this.locked(async () => {
      const old = await this.stored(id);
      if (referenced && (await referenced(id))) {
        throw new OjAccountError('OJ account is referenced by an active contest or plan', 409);
      }
      await this.forgetSecret(old);
      await rm(this.path(id));
    });
  }
}

export interface OjAccountSelector {
  accountIds?: string[];
  pool?: string;
}

export interface OjAccountLease {
  readonly account: OjAccount;
  release(): void;
}

export interface OjAccountPoolStatus {
  total: number;
  busy: number;
  available: number;
  queued: number;
}

interface PoolWaiter {
  platform: OjPlatform;
  selector: OjAccountSelector;
  signal?: AbortSignal;
  settled: boolean;
  resolve: (lease: OjAccountLease) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'Operation aborted');
  err.name = 'AbortError';
  return err;
}

// Process-wide submission serialization chains keyed by canonical (platform, origin, handle) or account ID.
// Shared across all OjAccountPool instances and standalone adapter calls so the same remote account
// never has >1 concurrent submission write in flight.
const processSubmissionChains = new Map<string, Promise<void>>();

/**
 * Resource pool and per-account submission serializer for OJ accounts.
 *
 * - `acquire` leases an exclusive account from a platform/pool (or explicit IDs),
 *   queuing callers in FIFO order until one becomes available or `signal` aborts.
 * - `enqueueSubmission` strictly serializes submission writes per serialization key
 *   (account ID or canonical `platform:origin:handle`) across the entire process so
 *   concurrent operations never race on submission ID correlation.
 */
export class OjAccountPool {
  private readonly busyIds = new Set<string>();
  private readonly waiters: PoolWaiter[] = [];
  private readonly store?: OjAccounts;
  private readonly staticAccounts?: OjAccount[];
  private dispatching = false;
  private drainNeeded = false;

  constructor(source: OjAccounts | OjAccount[]) {
    if (Array.isArray(source)) {
      this.staticAccounts = [...source];
    } else {
      this.store = source;
    }
  }

  private async resolveCandidates(platform: OjPlatform, selector: OjAccountSelector): Promise<OjAccount[]> {
    const accounts = this.store ? await this.store.list() : [...(this.staticAccounts ?? [])];
    const idFilter = selector.accountIds ? new Set(selector.accountIds) : undefined;
    return accounts.filter(acc => {
      if (acc.platform !== platform || !acc.ready) return false;
      if (idFilter && !idFilter.has(acc.id)) return false;
      if (!idFilter && selector.pool !== undefined && acc.pool !== selector.pool) return false;
      return true;
    });
  }

  private removeWaiter(waiter: PoolWaiter): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx !== -1) this.waiters.splice(idx, 1);
  }

  private makeLease(account: OjAccount): OjAccountLease {
    let released = false;
    return {
      account,
      release: () => {
        if (released) return;
        released = true;
        this.busyIds.delete(account.id);
        this.scheduleDispatch();
      },
    };
  }

  private scheduleDispatch(): void {
    if (this.dispatching) {
      this.drainNeeded = true;
      return;
    }
    this.dispatching = true;
    void (async () => {
      try {
        do {
          this.drainNeeded = false;
          await this.drainWaitersOnce();
        } while (this.drainNeeded);
      } finally {
        this.dispatching = false;
      }
    })();
  }

  private async drainWaitersOnce(): Promise<void> {
    const snapshot = [...this.waiters];
    for (const waiter of snapshot) {
      if (waiter.settled) {
        this.removeWaiter(waiter);
        continue;
      }
      if (waiter.signal?.aborted) {
        waiter.settled = true;
        this.removeWaiter(waiter);
        waiter.cleanup();
        waiter.reject(abortError(waiter.signal));
        continue;
      }

      let candidates: OjAccount[];
      try {
        candidates = await this.resolveCandidates(waiter.platform, waiter.selector);
      } catch (err) {
        if (waiter.settled) continue;
        waiter.settled = true;
        this.removeWaiter(waiter);
        waiter.cleanup();
        waiter.reject(err);
        continue;
      }

      // Re-check settled & abort status after async await to prevent lease leaks.
      if (waiter.settled) {
        this.removeWaiter(waiter);
        continue;
      }
      if (waiter.signal?.aborted) {
        waiter.settled = true;
        this.removeWaiter(waiter);
        waiter.cleanup();
        waiter.reject(abortError(waiter.signal));
        continue;
      }

      if (!candidates.length) {
        waiter.settled = true;
        this.removeWaiter(waiter);
        waiter.cleanup();
        waiter.reject(
          new OjAccountError(
            `No ready ${waiter.platform} OJ accounts available${waiter.selector.pool ? ` in pool "${waiter.selector.pool}"` : ''}`,
            503,
          ),
        );
        continue;
      }

      const free = candidates.find(acc => !this.busyIds.has(acc.id));
      if (free) {
        waiter.settled = true;
        this.removeWaiter(waiter);
        waiter.cleanup();
        this.busyIds.add(free.id);
        waiter.resolve(this.makeLease(free));
      }
    }
  }

  async acquire(
    platform: OjPlatform,
    selector: OjAccountSelector = {},
    signal?: AbortSignal,
  ): Promise<OjAccountLease> {
    if (signal?.aborted) throw abortError(signal);

    const candidates = await this.resolveCandidates(platform, selector);
    if (signal?.aborted) throw abortError(signal);

    if (!candidates.length) {
      throw new OjAccountError(
        `No ready ${platform} OJ accounts available${selector.pool ? ` in pool "${selector.pool}"` : ''}`,
        503,
      );
    }

    // Only allow fast-path acquisition when no existing waiters are queued and no drain is running,
    // preserving strict FIFO fairness and preventing lease starvation.
    const free = candidates.find(acc => !this.busyIds.has(acc.id));
    if (free && this.waiters.length === 0 && !this.dispatching) {
      this.busyIds.add(free.id);
      return this.makeLease(free);
    }

    return new Promise<OjAccountLease>((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.removeWaiter(waiter);
        waiter.cleanup();
        rejectPromise(abortError(signal!));
      };
      const waiter: PoolWaiter = {
        platform,
        selector,
        signal,
        settled: false,
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort);
        },
      };
      if (signal) {
        if (signal.aborted) {
          waiter.settled = true;
          rejectPromise(abortError(signal));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(waiter);
      if (free || !this.dispatching) {
        this.scheduleDispatch();
      }
    });
  }

  /**
   * Strictly serialize submission writes per key (e.g. `submissionQueueKey(platform, origin, handle)`
   * or account ID). If `signal` aborts while waiting in line, the caller rejects immediately
   * without invoking `fn`, and later callers in the chain continue cleanly.
   */
  enqueueSubmission<T>(
    key: string,
    fn: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const prev = processSubmissionChains.get(key) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const currentTurn = new Promise<void>(resolveTurn => {
      releaseTurn = resolveTurn;
    });
    const nextChain = prev.then(() => currentTurn);
    processSubmissionChains.set(key, nextChain);

    const cleanupChain = () => {
      releaseTurn();
      if (processSubmissionChains.get(key) === nextChain) {
        processSubmissionChains.delete(key);
      }
    };

    return new Promise<T>((resolvePromise, rejectPromise) => {
      let settled = false;
      let started = false;

      const onAbortBeforeStart = () => {
        if (started || settled) return;
        settled = true;
        rejectPromise(abortError(signal!));
      };

      if (signal) {
        signal.addEventListener('abort', onAbortBeforeStart, { once: true });
      }

      prev.then(async () => {
        if (signal) signal.removeEventListener('abort', onAbortBeforeStart);
        if (settled || signal?.aborted) {
          if (!settled && signal?.aborted) {
            settled = true;
            rejectPromise(abortError(signal));
          }
          cleanupChain();
          return;
        }
        started = true;
        try {
          const result = await fn(signal);
          settled = true;
          resolvePromise(result);
        } catch (err) {
          settled = true;
          rejectPromise(err);
        } finally {
          cleanupChain();
        }
      });
    });
  }

  async status(platform?: OjPlatform, pool?: string): Promise<OjAccountPoolStatus> {
    const accounts = this.store ? await this.store.list() : [...(this.staticAccounts ?? [])];
    const matching = accounts.filter(
      acc => acc.ready && (platform === undefined || acc.platform === platform) && (pool === undefined || acc.pool === pool),
    );
    const matchingIds = new Set(matching.map(a => a.id));
    let busy = 0;
    for (const id of this.busyIds) {
      if (matchingIds.has(id)) busy++;
    }
    const queued = this.waiters.filter(w => {
      if (w.settled) return false;
      if (platform !== undefined && w.platform !== platform) return false;
      if (pool === undefined) return true;
      if (w.selector.accountIds) {
        return w.selector.accountIds.some(id => matchingIds.has(id));
      }
      return w.selector.pool === undefined || w.selector.pool === pool;
    }).length;
    return {
      total: matching.length,
      busy,
      available: Math.max(0, matching.length - busy),
      queued,
    };
  }
}
