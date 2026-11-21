import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { link, mkdir, lstat, open, realpath, rename, rm, writeFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const connectionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const connectionProtocols = ['passthrough', 'responses', 'chat-completions', 'anthropic-messages'] as const;
export type ConnectionProtocol = (typeof connectionProtocols)[number];
export const connectionProtocolSchema = z.enum(connectionProtocols);
export const endpoint = z.url({ protocol: /^https?$/ }).max(4096).refine(value => {
  const u = new URL(value);
  return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
}, 'Use HTTPS or loopback HTTP without credentials, a query or a fragment').transform(value => new URL(value).href.replace(/\/+$/, ''));
const meta = z.strictObject({
  id: connectionId,
  label: z.string().trim().min(1).max(120),
  protocol: connectionProtocolSchema.default('passthrough'),
  base_url: endpoint,
  credential_ref: z.uuid(),
  approved_origin: z.string(),
  supports_fast: z.boolean().optional(),
  supports_ultrafast: z.boolean().optional(),
});
const stored = meta.extend({ backend: z.enum(['secret-service', 'file']) });
const base = meta.pick({ label: true, protocol: true, base_url: true, supports_fast: true, supports_ultrafast: true });
const secret = z.string().trim().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
export const createConnectionSchema = base.extend({ id: connectionId.optional(), secret });
export const patchConnectionSchema = z.strictObject({
  label: meta.shape.label.optional(),
  protocol: connectionProtocolSchema.optional(),
  base_url: endpoint.optional(),
  supports_fast: z.boolean().optional(),
  supports_ultrafast: z.boolean().optional(),
});
export const rotateConnectionSchema = z.strictObject({ secret });
export type Connection = z.infer<typeof meta>;
export class ConnectionError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
type StoredConnection = z.infer<typeof stored>;
const pub = (value: StoredConnection): Connection => ({
  id: value.id, label: value.label, protocol: value.protocol,
  base_url: value.base_url, credential_ref: value.credential_ref, approved_origin: value.approved_origin,
  ...(value.supports_fast !== undefined ? { supports_fast: value.supports_fast } : {}),
  ...(value.supports_ultrafast !== undefined ? { supports_ultrafast: value.supports_ultrafast } : {}),
});
function checkPublicMetadata(value: string, { id, label, base_url }: Pick<Connection, 'id' | 'label' | 'base_url'>) {
  if ([id, label, base_url].some(field => field === value || (value.length >= 8 && field.includes(value)))) {
    throw new ConnectionError('A credential cannot be part of public provider metadata');
  }
}
async function assertPrivateDir(dir: string) {
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new ConnectionError('Connection storage must be an owner-only directory', 500);
}
async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateDir(dir);
}
async function readPrivate(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 32_768) throw new ConnectionError('Connection storage has unsafe permissions', 500);
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== info.size) throw new ConnectionError('Connection storage changed while reading', 500);
    return bytes.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}
async function atomic(path: string, text: string, create = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    if (create) await link(temp, path);
    else await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
const channel = (op: string, ref: string, input?: string) => new Promise<string>((resolve, reject) => {
  const child = spawn('secret-tool', [op, ...(op === 'store' ? ['--label=ContestReplay API connection'] : []), 'application', 'contestreplay', 'credential', ref],
    { stdio: ['pipe', 'pipe', 'ignore'], timeout: 2500 });
  let value = '';
  child.stdout.setEncoding('utf8').on('data', part => { value += part; if (value.length > 10_000) child.kill(); });
  child.stdin.on('error', () => {});
  child.once('error', reject); child.once('close', code => code === 0 ? resolve(value.trim()) : reject(new Error('OS credential store unavailable')));
  child.stdin.end(input);
});
export class Connections {
  readonly root: string;
  constructor(root = process.env.CR_CONNECTIONS_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'contestreplay')) {
    this.root = resolve(root);
  }
  private get refs() { return join(this.root, 'references'); }
  private get secrets() { return join(this.root, 'credentials'); }
  private get index() { return join(this.root, 'connections'); }
  private path(id: string) { return join(this.index, `${connectionId.parse(id)}.json`); }
  private async stored(id: string) {
    try {
      await assertPrivateDir(this.root);
      await assertPrivateDir(this.index);
      const value = stored.parse(JSON.parse(await readPrivate(this.path(id))));
      if (value.id !== id || new URL(value.base_url).origin !== value.approved_origin) throw new Error('Invalid connection record');
      return value;
    } catch (e) { if (missing(e)) throw new ConnectionError('Connection not found', 404); throw e; }
  }
  // The child locks the open file description inherited from the parent. Keep
  // the parent descriptor open until the write completes, including across CLI/Studio processes.
  private async locked<T>(fn: () => Promise<T>) {
    await privateDir(this.root);
    const handle = await open(join(this.root, '.provider.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const result = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('flock', ['-x', '-w', '10', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
        child.once('error', reject);
        child.once('close', resolve);
      }).catch(() => { throw new ConnectionError('Provider storage lock unavailable', 503); });
      if (result !== 0) throw new ConnectionError('Provider storage is busy; retry shortly', 503);
      return await fn();
    } finally { await handle.close(); }
  }
  async get(id: string) { return pub(await this.stored(id)); }
  private async ids() {
    try { await assertPrivateDir(this.root); await assertPrivateDir(this.index); }
    catch (error) { if (missing(error)) return []; throw error; }
    const names = await readdir(this.index).catch(e => { if (missing(e)) return []; throw e; });
    return names.sort().filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
  }
  async list() { return Promise.all((await this.ids()).map(id => this.get(id))); }
  private async credential(value: StoredConnection) {
    if (value.backend === 'file') await assertPrivateDir(this.secrets);
    return secret.parse(value.backend === 'file' ? await readPrivate(join(this.secrets, value.credential_ref)) : await channel('lookup', value.credential_ref));
  }
  async provider(id: string) {
    const value = await this.stored(id);
    const credential_available = await this.credential(value).then(() => true, () => false);
    return { ...pub(value), backend: value.backend, credential_available };
  }
  async listProviders() {
    const ids = await this.ids();
    const result = [];
    // Bound concurrency. A record deleted after listing the directory is not an API error.
    for (let i = 0; i < ids.length; i += 8) result.push(...(await Promise.all(ids.slice(i, i + 8).map(id => this.provider(id).catch(error => {
      if (!(error instanceof ConnectionError) || error.status !== 404) throw error;
    })))).filter(item => item !== undefined));
    return result;
  }
  async key(id: string, expected: { base_url: string; api?: string }) {
    const value = await this.stored(id);
    const protocolMatches = !expected.api || value.protocol === 'passthrough' || expected.api === 'passthrough' || value.protocol === expected.api;
    if (value.base_url !== expected.base_url || !protocolMatches) throw new ConnectionError('Connection endpoint changed; regenerate the plan', 409);
    try {
      return await this.credential(value);
    } catch { throw new ConnectionError('API credential unavailable; rotate it in Studio or use cr provider rotate'); }
  }
  private async put(ref: string, value: string, backend?: z.infer<typeof stored>['backend']) {
    if (backend === 'secret-service' || (!backend && process.env.DBUS_SESSION_BUS_ADDRESS && process.env.CR_CREDENTIAL_STORAGE !== 'file')) {
      try { await channel('store', ref, value); return 'secret-service' as const; }
      catch { if (backend) throw new ConnectionError('OS credential store unavailable'); }
    }
    await privateDir(this.secrets);
    await atomic(join(this.secrets, ref), value);
    return 'file' as const;
  }
  create(input: z.input<typeof createConnectionSchema>) {
    return this.locked(async () => {
      const { secret, ...data } = createConnectionSchema.parse(input);
      const id = data.id ?? 'conn-' + randomUUID();
      checkPublicMetadata(secret, { ...data, id });
      const ref = randomUUID();
      await privateDir(this.index);
      try { await lstat(this.path(id)); throw new ConnectionError('Connection already exists', 409); }
      catch (e) { if (!missing(e)) throw e; }
      const backend = await this.put(ref, secret);
      const value = { ...data, id, credential_ref: ref, approved_origin: new URL(data.base_url).origin, backend };
      try { await atomic(this.path(id), JSON.stringify(value), true); }
      catch (e) { await this.forget(value).catch(() => {}); throw e; }
      return pub(value);
    });
  }
  patch(id: string, patch: z.input<typeof patchConnectionSchema>) {
    return this.locked(async () => {
      const parsedPatch = patchConnectionSchema.parse(patch);
      const old = await this.stored(id);
      if (parsedPatch.base_url && new URL(parsedPatch.base_url).origin !== old.approved_origin) throw new ConnectionError('Create a new provider to authorize a different origin', 409);
      const value = { ...old, ...parsedPatch };
      const current = await this.credential(old).catch(() => undefined);
      if (current) checkPublicMetadata(current, pub(value));
      await atomic(this.path(id), JSON.stringify(value));
      return pub(value);
    });
  }
  rotate(id: string, value: string) {
    return this.locked(async () => {
      const old = await this.stored(id);
      checkPublicMetadata(value, pub(old));
      await this.put(old.credential_ref, value, old.backend);
      return pub(old);
    });
  }
  private async forget(old: z.infer<typeof stored>) {
    if (old.backend === 'file') {
      await assertPrivateDir(this.secrets).catch(error => { if (!missing(error)) throw error; });
      await rm(join(this.secrets, old.credential_ref), { force: true });
    }
    else await channel('clear', old.credential_ref);
  }
  private async canonicalRefPath(p: string) {
    const abs = resolve(p);
    try {
      return await realpath(abs);
    } catch {
      const parentReal = await realpath(dirname(abs)).catch(() => dirname(abs));
      return join(parentReal, basename(abs));
    }
  }
  register<T>(id: string, path: string, save: () => Promise<T>) {
    return this.locked(async () => {
      await this.stored(id); await privateDir(this.refs);
      const targetResolved = resolve(path);
      const targetBefore = await this.canonicalRefPath(path);
      const fileName = `${id}~${randomUUID()}.json`;
      const file = join(this.refs, fileName);
      await writeFile(file, JSON.stringify({ path: targetBefore }), { mode: 0o600, flag: 'wx' });
      let result: T;
      try { result = await save(); } catch (e) { await rm(file, { force: true }); throw e; }
      const targetAfter = await this.canonicalRefPath(path);
      const records = await readdir(this.refs).catch(e => { if (missing(e)) return []; throw e; });
      for (const record of records) {
        if (record === fileName || !record.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(await readPrivate(join(this.refs, record))) as { path?: unknown };
          if (typeof parsed.path !== 'string') continue;
          const recordCanonical = await this.canonicalRefPath(parsed.path);
          if (recordCanonical === targetBefore || recordCanonical === targetAfter || resolve(parsed.path) === targetResolved) {
            await rm(join(this.refs, record), { force: true });
          }
        } catch {
          // Ignore malformed or concurrently removed ref files.
        }
      }
      return result;
    });
  }
  unregisterPath(path: string) {
    return this.locked(async () => {
      try { await assertPrivateDir(this.refs); }
      catch (e) { if (missing(e)) return; throw e; }
      const targetResolved = resolve(path);
      const targetCanonical = await this.canonicalRefPath(path);
      const records = await readdir(this.refs).catch(e => { if (missing(e)) return []; throw e; });
      for (const record of records) {
        if (!record.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(await readPrivate(join(this.refs, record))) as { path?: unknown };
          if (typeof parsed.path !== 'string') continue;
          const recordCanonical = await this.canonicalRefPath(parsed.path);
          if (recordCanonical === targetCanonical || resolve(parsed.path) === targetResolved) {
            await rm(join(this.refs, record), { force: true });
          }
        } catch {
          // Ignore malformed or unreadable ref files.
        }
      }
    });
  }
  remove(id: string, referenced: (id: string) => Promise<boolean>) {
    return this.locked(async () => {
      const old = await this.stored(id);
      await assertPrivateDir(this.refs).catch(error => { if (!missing(error)) throw error; });
      const records = await readdir(this.refs).catch(e => { if (missing(e)) return []; throw e; });
      for (const record of records.filter(name => name.startsWith(`${id}~`))) {
        const { path } = JSON.parse(await readPrivate(join(this.refs, record)));
        try { await lstat(path); throw new ConnectionError('Connection is referenced by a saved Agent', 409); }
        catch (e) { if (!missing(e)) throw e; }
      }
      if (await referenced(id)) throw new ConnectionError('Connection is referenced by an Agent in this workspace', 409);
      await this.forget(old); await rm(this.path(id));
    });
  }
}
