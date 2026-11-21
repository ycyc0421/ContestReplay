import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { credentialJson } from './credential-redaction.js';

export const pushTargetId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const pushUrlSchema = z.url({ protocol: /^https?$/ }).max(4096).refine(value => {
  const u = new URL(value);
  return !u.username && !u.password && !u.hash &&
    (u.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
}, 'Use HTTPS or loopback HTTP without credentials or a fragment').transform(value => new URL(value).href);

export const pushEventTypeSchema = z.enum(['run.completed', 'run.progress', 'batch.completed']);
export type PushEventType = z.infer<typeof pushEventTypeSchema>;

export const pushDeliveryEventSchema = z.enum(['run.completed', 'run.progress', 'batch.completed', 'ping']);
export type PushDeliveryEvent = z.infer<typeof pushDeliveryEventSchema>;

export const pushAuthModeSchema = z.enum(['none', 'bearer', 'hmac-sha256']);
export type PushAuthMode = z.infer<typeof pushAuthModeSchema>;

const pushBackendSchema = z.enum(['secret-service', 'file']);
const pushSecretSchema = z.string().trim().min(1).max(8192).regex(/^[\x21-\x7e]+$/);

const pushEventsSchema = z.array(pushEventTypeSchema).min(1).max(3).refine(
  events => new Set(events).size === events.length,
  'Duplicate push event types are not allowed',
);

const timeoutMsSchema = z.number().int().min(100).max(30_000);
const maxRetriesSchema = z.number().int().min(0).max(5);

const storedTargetSchema = z.strictObject({
  id: pushTargetId,
  label: z.string().trim().min(1).max(120),
  url: pushUrlSchema,
  approved_origin: z.string().min(1),
  enabled: z.boolean(),
  events: pushEventsSchema,
  auth_mode: pushAuthModeSchema,
  credential_ref: z.uuid().optional(),
  backend: pushBackendSchema.optional(),
  timeout_ms: timeoutMsSchema,
  max_retries: maxRetriesSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
}).superRefine((value, ctx) => {
  if (value.auth_mode === 'none') {
    if (value.credential_ref !== undefined || value.backend !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['credential_ref'], message: 'Unauthenticated target must not carry credentials' });
    }
  } else {
    if (!value.credential_ref || !value.backend) {
      ctx.addIssue({ code: 'custom', path: ['credential_ref'], message: 'Authenticated target requires credential_ref and backend' });
    }
  }
});

export const pushTargetResponseSchema = z.strictObject({
  id: pushTargetId,
  label: z.string().trim().min(1).max(120),
  url: z.string().min(1),
  approved_origin: z.string().min(1),
  enabled: z.boolean(),
  events: pushEventsSchema,
  auth_mode: pushAuthModeSchema,
  credential_ref: z.uuid().optional(),
  backend: pushBackendSchema.optional(),
  credential_available: z.boolean().optional(),
  timeout_ms: timeoutMsSchema,
  max_retries: maxRetriesSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type PushTarget = z.infer<typeof pushTargetResponseSchema>;

export const createPushTargetSchema = z.strictObject({
  id: pushTargetId.optional(),
  label: z.string().trim().min(1).max(120),
  url: pushUrlSchema,
  enabled: z.boolean().default(true),
  events: pushEventsSchema,
  auth_mode: pushAuthModeSchema.default('none'),
  secret: pushSecretSchema.optional(),
  timeout_ms: timeoutMsSchema.default(10_000),
  max_retries: maxRetriesSchema.default(3),
}).superRefine((value, ctx) => {
  if (value.auth_mode === 'none' && value.secret !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['secret'], message: 'Do not supply a secret when auth_mode is none' });
  }
  if (value.auth_mode !== 'none' && value.secret === undefined) {
    ctx.addIssue({ code: 'custom', path: ['secret'], message: 'A secret is required for bearer or hmac-sha256 auth_mode' });
  }
});
export type CreatePushTargetInput = z.input<typeof createPushTargetSchema>;

export const patchPushTargetSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  url: pushUrlSchema.optional(),
  enabled: z.boolean().optional(),
  events: pushEventsSchema.optional(),
  timeout_ms: timeoutMsSchema.optional(),
  max_retries: maxRetriesSchema.optional(),
});
export type PatchPushTargetInput = z.input<typeof patchPushTargetSchema>;

export const rotatePushTargetSchema = z.strictObject({
  secret: pushSecretSchema,
  auth_mode: z.enum(['bearer', 'hmac-sha256']).optional(),
});
export type RotatePushTargetInput = z.input<typeof rotatePushTargetSchema>;

export const pushDeliverySchema = z.strictObject({
  delivery_id: z.uuid(),
  target_id: pushTargetId,
  event: pushDeliveryEventSchema,
  status: z.enum(['delivered', 'failed']),
  http_status: z.number().int().min(100).max(599).optional(),
  attempts: z.number().int().positive(),
  duration_ms: z.number().int().nonnegative(),
  error: z.string().max(500).optional(),
  timestamp: z.iso.datetime(),
});
export type PushDelivery = z.infer<typeof pushDeliverySchema>;

export class PushTargetError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type StoredPushTarget = z.infer<typeof storedTargetSchema>;

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function checkPublicMetadata(secretValue: string, meta: { id: string; label: string; url: string }) {
  if ([meta.id, meta.label, meta.url].some(field => field === secretValue || (secretValue.length >= 8 && field.includes(secretValue)))) {
    throw new PushTargetError('A push credential cannot be part of public target metadata', 400);
  }
}

async function assertPrivateDir(dir: string) {
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new PushTargetError('Push target storage must be an owner-only directory', 500);
  }
}

async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateDir(dir);
}

async function readPrivate(filePath: string, maxBytes = 65_536) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > maxBytes) {
      throw new PushTargetError('Push target storage has unsafe permissions', 500);
    }
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== info.size) throw new PushTargetError('Push target storage changed while reading', 500);
    return bytes.subarray(0, size).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath: string, text: string, create = false) {
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    if (create) await link(temp, filePath);
    else await rename(temp, filePath);
  } finally {
    await rm(temp, { force: true });
  }
}

const secretChannel = (op: 'store' | 'lookup' | 'clear', ref: string, input?: string) =>
  new Promise<string>((resolvePromise, rejectPromise) => {
    const args = [
      op,
      ...(op === 'store' ? ['--label=ContestReplay push target credential'] : []),
      'application',
      'contestreplay',
      'push-target',
      ref,
    ];
    const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 2500 });
    let value = '';
    child.stdout.setEncoding('utf8').on('data', part => {
      value += part;
      if (value.length > 10_000) child.kill();
    });
    child.stdin.on('error', () => {});
    child.once('error', rejectPromise);
    child.once('close', code => code === 0 ? resolvePromise(value.trim()) : rejectPromise(new Error('OS credential store unavailable')));
    child.stdin.end(input);
  });

function toPublicTarget(stored: StoredPushTarget, credentialAvailable?: boolean): PushTarget {
  return pushTargetResponseSchema.parse({
    id: stored.id,
    label: stored.label,
    url: stored.url,
    approved_origin: stored.approved_origin,
    enabled: stored.enabled,
    events: stored.events,
    auth_mode: stored.auth_mode,
    ...(stored.credential_ref !== undefined ? { credential_ref: stored.credential_ref } : {}),
    ...(stored.backend !== undefined ? { backend: stored.backend } : {}),
    ...(credentialAvailable !== undefined ? { credential_available: credentialAvailable } : {}),
    timeout_ms: stored.timeout_ms,
    max_retries: stored.max_retries,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  });
}

export class PushTargets {
  readonly root: string;

  constructor(
    root = process.env.CR_PUSH_TARGETS_DIR ||
      join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'contestreplay', 'push-targets'),
  ) {
    this.root = resolve(root);
  }

  private get index() { return join(this.root, 'targets'); }
  private get secrets() { return join(this.root, 'credentials'); }
  private path(id: string) { return join(this.index, `${pushTargetId.parse(id)}.json`); }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await privateDir(this.root);
    const handle = await open(
      join(this.root, '.push-targets.lock'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const result = await new Promise<number | null>((resolvePromise, rejectPromise) => {
        const child = spawn('flock', ['-x', '-w', '10', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
        child.once('error', rejectPromise);
        child.once('close', resolvePromise);
      }).catch(() => {
        throw new PushTargetError('Push target storage lock unavailable', 503);
      });
      if (result !== 0) throw new PushTargetError('Push target storage is busy; retry shortly', 503);
      return await fn();
    } finally {
      await handle.close();
    }
  }

  private async readStored(id: string): Promise<StoredPushTarget> {
    try {
      await assertPrivateDir(this.root);
      await assertPrivateDir(this.index);
      const value = storedTargetSchema.parse(JSON.parse(await readPrivate(this.path(id))));
      if (value.id !== id || new URL(value.url).origin !== value.approved_origin) {
        throw new PushTargetError('Invalid push target record', 500);
      }
      return value;
    } catch (error) {
      if (missing(error)) throw new PushTargetError('Push target not found', 404);
      throw error;
    }
  }

  private async readSecret(stored: StoredPushTarget): Promise<string | undefined> {
    if (stored.auth_mode === 'none' || !stored.credential_ref || !stored.backend) return undefined;
    if (stored.backend === 'file') {
      await assertPrivateDir(this.secrets);
      return pushSecretSchema.parse(await readPrivate(join(this.secrets, stored.credential_ref)));
    }
    return pushSecretSchema.parse(await secretChannel('lookup', stored.credential_ref));
  }

  private async putSecret(
    ref: string,
    secretValue: string,
    backend?: z.infer<typeof pushBackendSchema>,
  ): Promise<z.infer<typeof pushBackendSchema>> {
    if (
      backend === 'secret-service' ||
      (!backend && process.env.DBUS_SESSION_BUS_ADDRESS && process.env.CR_CREDENTIAL_STORAGE !== 'file')
    ) {
      try {
        await secretChannel('store', ref, secretValue);
        return 'secret-service';
      } catch {
        if (backend) throw new PushTargetError('OS credential store unavailable', 500);
      }
    }
    await privateDir(this.secrets);
    await atomicWrite(join(this.secrets, ref), secretValue);
    return 'file';
  }

  private async forgetSecret(stored: StoredPushTarget) {
    if (!stored.credential_ref || !stored.backend) return;
    if (stored.backend === 'file') {
      await assertPrivateDir(this.secrets).catch(error => { if (!missing(error)) throw error; });
      await rm(join(this.secrets, stored.credential_ref), { force: true });
    } else {
      await secretChannel('clear', stored.credential_ref);
    }
  }

  private async describe(stored: StoredPushTarget): Promise<PushTarget> {
    if (stored.auth_mode === 'none') return toPublicTarget(stored);
    const available = await this.readSecret(stored).then(() => true, () => false);
    return toPublicTarget(stored, available);
  }

  private async ids(): Promise<string[]> {
    try {
      await assertPrivateDir(this.root);
      await assertPrivateDir(this.index);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const names = await readdir(this.index).catch(error => {
      if (missing(error)) return [];
      throw error;
    });
    return names.sort().filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  }

  async get(id: string): Promise<PushTarget> {
    return this.describe(await this.readStored(id));
  }

  async list(): Promise<PushTarget[]> {
    const ids = await this.ids();
    const results: PushTarget[] = [];
    for (let i = 0; i < ids.length; i += 8) {
      const batch = await Promise.all(
        ids.slice(i, i + 8).map(id =>
          this.get(id).catch(error => {
            if (!(error instanceof PushTargetError) || error.status !== 404) throw error;
            return undefined;
          }),
        ),
      );
      for (const item of batch) if (item !== undefined) results.push(item);
    }
    return results;
  }

  create(rawInput: CreatePushTargetInput): Promise<PushTarget> {
    const input = createPushTargetSchema.parse(rawInput);
    return this.locked(async () => {
      const { secret, ...data } = input;
      const id = data.id ?? `push-${randomUUID()}`;
      if (secret !== undefined) checkPublicMetadata(secret, { id, label: data.label, url: data.url });

      await privateDir(this.index);
      try {
        await lstat(this.path(id));
        throw new PushTargetError('Push target already exists', 409);
      } catch (error) {
        if (!missing(error)) throw error;
      }

      const nowIso = new Date().toISOString();
      let credentialRef: string | undefined;
      let backend: z.infer<typeof pushBackendSchema> | undefined;
      if (data.auth_mode !== 'none') {
        credentialRef = randomUUID();
        backend = await this.putSecret(credentialRef, secret!);
      }

      const storedRecord: StoredPushTarget = storedTargetSchema.parse({
        id,
        label: data.label,
        url: data.url,
        approved_origin: new URL(data.url).origin,
        enabled: data.enabled,
        events: data.events,
        auth_mode: data.auth_mode,
        ...(credentialRef ? { credential_ref: credentialRef, backend } : {}),
        timeout_ms: data.timeout_ms,
        max_retries: data.max_retries,
        created_at: nowIso,
        updated_at: nowIso,
      });

      try {
        await atomicWrite(this.path(id), JSON.stringify(storedRecord), true);
      } catch (error) {
        await this.forgetSecret(storedRecord).catch(() => {});
        throw error;
      }
      return toPublicTarget(storedRecord, storedRecord.auth_mode === 'none' ? undefined : true);
    });
  }

  patch(id: string, rawPatch: PatchPushTargetInput): Promise<PushTarget> {
    const patch = patchPushTargetSchema.parse(rawPatch);
    return this.locked(async () => {
      const old = await this.readStored(id);
      if (patch.url && new URL(patch.url).origin !== old.approved_origin) {
        throw new PushTargetError('Create a new push target to authorize a different origin', 409);
      }
      const updated: StoredPushTarget = storedTargetSchema.parse({
        ...old,
        ...patch,
        updated_at: new Date().toISOString(),
      });
      if (old.auth_mode !== 'none') {
        const currentSecret = await this.readSecret(old).catch(() => undefined);
        if (currentSecret) checkPublicMetadata(currentSecret, updated);
      }
      await atomicWrite(this.path(id), JSON.stringify(updated));
      return this.describe(updated);
    });
  }

  rotate(id: string, input: string | RotatePushTargetInput): Promise<PushTarget> {
    const parsed = rotatePushTargetSchema.parse(typeof input === 'string' ? { secret: input } : input);
    return this.locked(async () => {
      const old = await this.readStored(id);
      const nextAuthMode = parsed.auth_mode ?? (old.auth_mode === 'none' ? undefined : old.auth_mode);
      if (!nextAuthMode) {
        throw new PushTargetError('Push target does not use authentication; specify auth_mode to enable credentials', 400);
      }
      checkPublicMetadata(parsed.secret, old);

      const ref = old.credential_ref ?? randomUUID();
      const backend = await this.putSecret(ref, parsed.secret, old.backend);
      const updated: StoredPushTarget = storedTargetSchema.parse({
        ...old,
        auth_mode: nextAuthMode,
        credential_ref: ref,
        backend,
        updated_at: new Date().toISOString(),
      });
      await atomicWrite(this.path(id), JSON.stringify(updated));
      return toPublicTarget(updated, true);
    });
  }

  remove(id: string): Promise<void> {
    return this.locked(async () => {
      const old = await this.readStored(id);
      await this.forgetSecret(old);
      await rm(this.path(id));
    });
  }

  async resolveForDelivery(id: string): Promise<{ target: PushTarget; secret?: string }> {
    const stored = await this.readStored(id);
    if (stored.auth_mode === 'none') {
      return { target: toPublicTarget(stored) };
    }
    let secretValue: string | undefined;
    try {
      secretValue = await this.readSecret(stored);
    } catch {
      throw new PushTargetError('Push target credential unavailable; rotate it before delivering', 500);
    }
    return { target: toPublicTarget(stored, true), secret: secretValue };
  }
}

export function signPushPayload(secret: string, body: string, timestamp: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${digest}`;
}

export function verifyPushSignature(
  secret: string,
  body: string,
  timestamp: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expected = signPushPayload(secret, body, timestamp);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(signal.reason ?? new Error('Aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sanitizeDeliveryError(message: string, secret?: string): string {
  let clean = message;
  if (secret && (clean === secret || secret.length >= 8)) {
    clean = clean.replaceAll(secret, '[REDACTED]');
  }
  clean = clean
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsha256=[a-f0-9]{16,}/gi, 'sha256=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 500) || 'Delivery failed';
}

function isRedirectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const causeMsg = error.cause instanceof Error ? error.cause.message : '';
  return /redirect/i.test(`${error.message} ${causeMsg}`);
}

export interface PushDispatcherOptions {
  deliveriesFile?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface DeliverOptions {
  targetIds?: string[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class PushDispatcher {
  readonly deliveriesFile: string;
  private readonly defaultFetch: typeof fetch;
  private readonly defaultSleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly targets: PushTargets, opts: PushDispatcherOptions = {}) {
    this.deliveriesFile = resolve(opts.deliveriesFile ?? join(targets.root, 'deliveries.jsonl'));
    this.defaultFetch = opts.fetchImpl ?? globalThis.fetch;
    this.defaultSleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
  }

  private async appendDelivery(record: PushDelivery, secret?: string) {
    await privateDir(dirname(this.deliveriesFile));
    const handle = await open(
      this.deliveriesFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
        throw new PushTargetError('Push delivery log has unsafe permissions', 500);
      }
      const line = credentialJson(record, secret) + '\n';
      await handle.write(Buffer.from(line, 'utf8'));
    } finally {
      await handle.close();
    }
  }

  private async deliverToTarget(
    targetId: string,
    eventType: PushDeliveryEvent,
    payload: unknown,
    opts: DeliverOptions,
  ): Promise<PushDelivery> {
    const fetchFn = opts.fetchImpl ?? this.defaultFetch;
    const sleepFn = opts.sleep ?? this.defaultSleep;
    const deliveryId = randomUUID();
    const startMs = this.now();
    const timestampIso = new Date(startMs).toISOString();
    const timestampHeader = String(Math.floor(startMs / 1000));

    let resolved: { target: PushTarget; secret?: string };
    try {
      resolved = await this.targets.resolveForDelivery(targetId);
    } catch (error) {
      const record = pushDeliverySchema.parse({
        delivery_id: deliveryId,
        target_id: pushTargetId.parse(targetId),
        event: eventType,
        status: 'failed',
        attempts: 1,
        duration_ms: Math.max(0, Math.floor(this.now() - startMs)),
        error: sanitizeDeliveryError(error instanceof Error ? error.message : 'Target resolution failed'),
        timestamp: timestampIso,
      });
      await this.appendDelivery(record);
      return record;
    }

    const { target, secret } = resolved;
    const body = JSON.stringify(payload ?? {});
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-CR-Event': eventType,
      'X-CR-Delivery-Id': deliveryId,
      'X-CR-Timestamp': timestampHeader,
    };
    if (target.auth_mode === 'bearer' && secret) {
      headers['Authorization'] = `Bearer ${secret}`;
    } else if (target.auth_mode === 'hmac-sha256' && secret) {
      headers['X-CR-Signature-256'] = signPushPayload(secret, body, timestampHeader);
    }

    const maxAttempts = 1 + target.max_retries;
    let attempts = 0;
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    let delivered = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.signal?.aborted) {
        lastError = 'Delivery aborted';
        break;
      }
      attempts = attempt;
      const attemptSignal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(target.timeout_ms)])
        : AbortSignal.timeout(target.timeout_ms);

      try {
        const response = await fetchFn(target.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: attemptSignal,
        });
        lastStatus = response.status;
        await response.body?.cancel().catch(() => {});

        if (response.status >= 200 && response.status < 300) {
          delivered = true;
          lastError = undefined;
          break;
        }

        lastError = `HTTP ${response.status}`;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= maxAttempts) break;
      } catch (error) {
        lastStatus = undefined;
        lastError = sanitizeDeliveryError(error instanceof Error ? error.message : 'Network error', secret);
        if (opts.signal?.aborted || isRedirectError(error) || attempt >= maxAttempts) break;
      }

      const backoffMs = Math.min(10_000, 250 * 2 ** (attempt - 1));
      try {
        await sleepFn(backoffMs, opts.signal);
      } catch {
        lastError = 'Delivery aborted';
        break;
      }
    }

    const record = pushDeliverySchema.parse({
      delivery_id: deliveryId,
      target_id: target.id,
      event: eventType,
      status: delivered ? 'delivered' : 'failed',
      ...(lastStatus !== undefined ? { http_status: lastStatus } : {}),
      attempts: Math.max(1, attempts),
      duration_ms: Math.max(0, Math.floor(this.now() - startMs)),
      ...(!delivered && lastError ? { error: sanitizeDeliveryError(lastError, secret) } : {}),
      timestamp: timestampIso,
    });
    await this.appendDelivery(record, secret);
    return record;
  }

  async deliver(
    eventType: PushEventType,
    payload: unknown,
    opts: DeliverOptions = {},
  ): Promise<PushDelivery[]> {
    const validEvent = pushEventTypeSchema.parse(eventType);
    let selectedIds: string[];
    if (opts.targetIds) {
      const uniqueIds = [...new Set(opts.targetIds.map(id => pushTargetId.parse(id)))];
      const targets = await Promise.all(
        uniqueIds.map(id =>
          this.targets.get(id).catch(error => {
            if (error instanceof PushTargetError && error.status === 404) return undefined;
            throw error;
          }),
        ),
      );
      selectedIds = targets
        .filter((t): t is PushTarget => t !== undefined && t.enabled && t.events.includes(validEvent))
        .map(t => t.id);
    } else {
      const all = await this.targets.list();
      selectedIds = all.filter(t => t.enabled && t.events.includes(validEvent)).map(t => t.id);
    }

    const results: PushDelivery[] = [];
    for (const id of selectedIds) {
      results.push(await this.deliverToTarget(id, validEvent, payload, opts));
    }
    return results;
  }

  async testTarget(id: string, opts: Omit<DeliverOptions, 'targetIds'> = {}): Promise<PushDelivery> {
    const validId = pushTargetId.parse(id);
    // Ensure target exists before dispatching ping (throws 404 PushTargetError if missing).
    await this.targets.get(validId);
    const payload = { type: 'ping', timestamp: new Date(this.now()).toISOString() };
    return this.deliverToTarget(validId, 'ping', payload, opts);
  }

  async listDeliveries(limit = 50, targetId?: string): Promise<PushDelivery[]> {
    const cappedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const filterId = targetId !== undefined ? pushTargetId.parse(targetId) : undefined;

    let handle;
    try {
      handle = await open(this.deliveriesFile, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }

    const records: PushDelivery[] = [];
    try {
      const info = await handle.stat();
      if (!info.isFile()) return [];
      const maxRead = 8 * 1024 * 1024;
      const startPos = info.size > maxRead ? info.size - maxRead : 0;
      const toRead = info.size - startPos;
      const buf = Buffer.allocUnsafe(toRead);
      let read = 0;
      while (read < toRead) {
        const res = await handle.read(buf, read, toRead - read, startPos + read);
        if (!res.bytesRead) break;
        read += res.bytesRead;
      }
      const text = buf.subarray(0, read).toString('utf8');
      const lines = text.split('\n');
      if (startPos > 0) lines.shift(); // Drop potentially truncated leading line.
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = pushDeliverySchema.safeParse(JSON.parse(trimmed));
          if (parsed.success && (!filterId || parsed.data.target_id === filterId)) {
            records.push(parsed.data);
          }
        } catch {
          // Ignore incomplete trailing line.
        }
      }
    } finally {
      await handle.close();
    }

    return records.slice(-cappedLimit).reverse();
  }
}
