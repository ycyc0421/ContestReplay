import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { agentKind, FieldError, manifestProvider, manifestSchema } from './agent-manifest.js';
import {
  agentDigests,
  agentSchema,
  contestSchema,
  id as idSchema,
  judgeSchema,
  resolveAgentManifest,
  resolveContest,
  sha256,
} from './config.js';
import { connectionProtocols, Connections } from './connections.js';
import {
  efforts,
  harnessCapabilities,
  serviceTiers,
  speedTiers,
  speedTierSchema,
} from './harnesses.js';
import {
  inferProblemMap,
  languagePresetsFor,
  listJudgeBackends,
  type ProblemMapInference,
} from './judges/index.js';
import { inspectPdf, synthesizeTextContestPdf, synthProblemSchema, type PdfInfo } from './pdf-synth.js';
import { planSchema, specSchema } from './plan.js';
import { protocolPresetNames, protocolPresets, resolveProtocolPreset, scoringModes } from './protocol.js';
import { resultSchema, resultsSchema } from './results.js';
import { documentFormat, formatSchema, parseDocumentText, serializeDocument, type Format } from './serialization.js';

export const schemaTargetSchema = z.enum(['all', 'agent', 'contest', 'batch', 'results']);
export type SchemaTarget = z.infer<typeof schemaTargetSchema>;

export const ifExistsSchema = z.enum(['skip', 'error', 'overwrite']);
export type IfExistsMode = z.infer<typeof ifExistsSchema>;

export interface AutomationIssue {
  index?: number;
  id?: string;
  path: string[];
  message: string;
  code: 'validation' | 'secret_rejected' | 'conflict' | 'path_error';
}

const SUPPORTED_CONTEST_MANIFEST_JUDGES = new Set<string>(['local', 'codeforces']);
const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_ATTACHMENT_BYTES = 16_000_000;
const MAX_TOTAL_ATTACHMENTS_BYTES = 32_000_000;
const MAX_JUDGE_FILE_BYTES = 4_000_000;
const MAX_NATIVE_CONFIG_BYTES = 64_000;
const MAX_EXISTING_DOC_BYTES = 1_048_576;

function normalizeKeyName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase();
}

const SAFE_TOKEN_METRIC_RE =
  /^(?:(?:max|min|input|output|prompt|completion|total|cached|reasoning|context|budget|used|remaining|spent|avg|mean|median|p\d+)(?:_(?:input|output|prompt|completion|context|reasoning|cached))?_tokens?|tokens?_(?:count|limit|budget|used|per_second|per_sec|rate))$/;

const ALWAYS_SECRET_RE =
  /(?:^|_)(?:secret|secrets|api_key|api_keys|apikey|access_key|access_keys|accesskey|private_key|private_keys|privatekey|authorization|bearer|bearertoken|credential|credentials|cookie|cookies|password|passwords|passwd|authtoken|accesstoken|refreshtoken)(?:$|_)/;

const AUTH_TOKEN_RE = /(?:^|_)tokens?(?:$|_)/;

/**
 * Checks whether a field name looks like a secret/credential key (handling snake_case,
 * kebab-case, and camelCase) while avoiding false positives on LLM token-count metrics
 * such as `max_tokens`, `max_output_tokens`, `input_tokens`, `output_tokens`, etc.
 */
export function isSecretKey(key: string): boolean {
  const norm = normalizeKeyName(key);
  if (ALWAYS_SECRET_RE.test(norm)) return true;
  if (AUTH_TOKEN_RE.test(norm)) {
    return !SAFE_TOKEN_METRIC_RE.test(norm);
  }
  return false;
}

/**
 * Recursively scans a JSON-like payload and rejects any secret-looking field names.
 * Automation APIs and Coding Agents may ONLY reference pre-registered provider / OJ account IDs.
 */
export function findSecretKeyPaths(value: unknown, path: string[] = []): string[][] {
  const hits: string[][] = [];
  if (!value || typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      hits.push(...findSecretKeyPaths(value[i], [...path, String(i)]));
    }
    return hits;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...path, key];
    if (isSecretKey(key)) {
      hits.push(nextPath);
    }
    hits.push(...findSecretKeyPaths(child, nextPath));
  }
  return hits;
}

function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

export function exportSchemas(rawTarget: SchemaTarget = 'all') {
  const target = schemaTargetSchema.parse(rawTarget);
  const allSchemas = {
    agent: toInputJsonSchema(manifestSchema),
    agent_legacy: toInputJsonSchema(agentSchema),
    contest: toInputJsonSchema(contestSchema),
    judge: toInputJsonSchema(judgeSchema),
    batch: toInputJsonSchema(specSchema),
    plan: toInputJsonSchema(planSchema),
    result: toInputJsonSchema(resultSchema),
    results: toInputJsonSchema(resultsSchema),
  };

  const schemas: Record<string, Record<string, unknown>> =
    target === 'all'
      ? allSchemas
      : target === 'agent'
        ? { agent: allSchemas.agent, agent_legacy: allSchemas.agent_legacy }
        : target === 'contest'
          ? { contest: allSchemas.contest, judge: allSchemas.judge }
          : target === 'batch'
            ? { batch: allSchemas.batch, plan: allSchemas.plan }
            : { results: allSchemas.results, result: allSchemas.result };

  const capabilities = {
    harnesses: harnessCapabilities(),
    protocol_presets: protocolPresets,
    protocol_preset_names: [...protocolPresetNames],
    scoring_modes: [...scoringModes],
    judge_backends: [
      {
        kind: 'local' as const,
        label: 'Local Answer Table',
        default_settlement_ms: 0,
        supports_partial_score: false,
        requires_base_url: false,
        contest_manifest_supported: true,
      },
      ...listJudgeBackends().map(backend => ({
        ...backend,
        contest_manifest_supported: SUPPORTED_CONTEST_MANIFEST_JUDGES.has(backend.kind),
      })),
    ],
    language_presets: {
      codeforces: languagePresetsFor('codeforces'),
      qoj: languagePresetsFor('qoj'),
      vjudge: languagePresetsFor('vjudge'),
      hydro: languagePresetsFor('hydro'),
    },
    manifest_formats: [...formatSchema.options],
    speed_tiers: [...speedTiers],
    service_tiers: [...serviceTiers],
    reasoning_efforts: [...efforts],
    connection_protocols: [...connectionProtocols],
  };

  return {
    schema_version: 1 as const,
    target,
    schemas,
    capabilities,
  };
}

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function isWithinDir(targetPath: string, dirPath: string): boolean {
  return targetPath === dirPath || targetPath.startsWith(dirPath + sep);
}

function hasAncestorDescendantCollision(pathA: string, pathB: string): boolean {
  return pathA.startsWith(pathB + sep) || pathB.startsWith(pathA + sep);
}

/**
 * Confines a path strictly inside `base`, supporting symlinked workspace bases
 * (e.g. macOS `/tmp` -> `/private/tmp`), while disallowing `..` traversal,
 * hidden segments (`.`-prefixed), null bytes, and symlinks anywhere inside `base`.
 */
export async function resolveConfinedPath(
  base: string,
  targetPath: string,
  fieldPath: string[] = ['file'],
): Promise<{ absPath: string; relPath: string }> {
  if (!targetPath || targetPath.includes('\0')) {
    throw new FieldError(fieldPath, 'Invalid file path');
  }
  const baseResolved = resolve(base);
  const baseReal = await realpath(baseResolved);

  let candidate: string;
  if (isAbsolute(targetPath)) {
    const absTarget = resolve(targetPath);
    if (isWithinDir(absTarget, baseReal)) {
      candidate = absTarget;
    } else if (baseResolved !== baseReal && isWithinDir(absTarget, baseResolved)) {
      // Rebase paths that used the symlinked base prefix (e.g. /tmp/ws/foo -> /private/tmp/ws/foo).
      const relFromResolved = relative(baseResolved, absTarget);
      candidate = resolve(baseReal, relFromResolved);
    } else {
      candidate = absTarget;
    }
  } else {
    candidate = resolve(baseReal, targetPath);
  }

  const rel = relative(baseReal, candidate);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FieldError(fieldPath, `Path must stay inside workspace base: ${targetPath}`);
  }
  const parts = rel.split(sep);
  if (parts.some(seg => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    throw new FieldError(fieldPath, `Hidden or invalid path segment is not allowed: ${targetPath}`);
  }

  let current = baseReal;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new FieldError(fieldPath, `Symlink is not allowed in confined path: ${rel}`);
      }
      if (i < parts.length - 1 && !info.isDirectory()) {
        throw new FieldError(fieldPath, `Parent path component is not a directory: ${rel}`);
      }
      if (i === parts.length - 1 && !info.isFile()) {
        throw new FieldError(fieldPath, `Target path exists and is not a regular file: ${rel}`);
      }
    } catch (error) {
      if (isEnoent(error)) {
        break;
      }
      throw error;
    }
  }

  return { absPath: join(baseReal, ...parts), relPath: parts.join('/') };
}

/**
 * Resolves a path strictly inside `baseReal` and reads it using `O_NOFOLLOW` to prevent
 * TOCTOU symlink swaps, verifying regular file type and byte limit.
 */
export async function readConfinedRegularFile(
  baseReal: string,
  candidatePath: string,
  fieldPath: string[],
  maxBytes: number,
): Promise<{ absPath: string; relPath: string; bytes: Buffer; mode: number }> {
  const confined = await resolveConfinedPath(baseReal, candidatePath, fieldPath);
  const handle = await open(confined.absPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new FieldError(fieldPath, `Not a regular file: ${confined.relPath}`);
    }
    if (info.size > maxBytes) {
      throw new FieldError(fieldPath, `File exceeds ${maxBytes} bytes: ${confined.relPath}`);
    }
    const buf = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) {
      throw new FieldError(fieldPath, `File changed while reading: ${confined.relPath}`);
    }
    return {
      absPath: confined.absPath,
      relPath: confined.relPath,
      bytes: buf.subarray(0, offset),
      mode: info.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

async function resolveProtectedDirs(opts: {
  baseReal: string;
  baseResolved: string;
  root?: string;
  store?: Connections;
  credentialDirs?: string[];
}): Promise<string[]> {
  const rawDirs: string[] = [];
  if (opts.root) rawDirs.push(opts.root);
  if (opts.store?.root) rawDirs.push(opts.store.root);
  if (opts.credentialDirs) rawDirs.push(...opts.credentialDirs);
  if (process.env.CR_CONNECTIONS_DIR) rawDirs.push(process.env.CR_CONNECTIONS_DIR);
  if (process.env.CR_OJ_ACCOUNTS_DIR) rawDirs.push(process.env.CR_OJ_ACCOUNTS_DIR);
  if (process.env.CR_PUSH_TARGETS_DIR) rawDirs.push(process.env.CR_PUSH_TARGETS_DIR);
  const defaultConfigDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'contestreplay');
  rawDirs.push(defaultConfigDir);

  const out = new Set<string>();
  for (const dir of rawDirs) {
    const resolvedDir = resolve(dir);
    out.add(resolvedDir);
    if (opts.baseResolved !== opts.baseReal && isWithinDir(resolvedDir, opts.baseResolved)) {
      out.add(resolve(opts.baseReal, relative(opts.baseResolved, resolvedDir)));
    }
    const real = await realpath(resolvedDir).catch(() => undefined);
    if (real) out.add(real);
  }
  return [...out];
}

function assertNotInProtectedDirs(
  absPath: string,
  relPath: string,
  protectedDirs: readonly string[],
  fieldPath: string[],
  label: string,
): void {
  if (relPath === 'runs' || relPath.startsWith('runs/')) {
    throw new FieldError(fieldPath, `${label} cannot reside inside runs/: ${relPath}`);
  }
  for (const dir of protectedDirs) {
    if (isWithinDir(absPath, dir)) {
      throw new FieldError(fieldPath, `${label} cannot reside inside a protected workspace or credential directory: ${relPath}`);
    }
  }
}

function assertAllowedWritePrefix(
  relPath: string,
  allowedPrefixes: readonly string[] | undefined,
  fieldPath: string[],
): void {
  if (!allowedPrefixes?.length) return;
  const normalized = allowedPrefixes.map(p => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  if (!normalized.some(prefix => relPath.startsWith(`${prefix}/`))) {
    throw new FieldError(
      fieldPath,
      `Output path "${relPath}" must reside under an approved directory (${normalized.map(p => `${p}/`).join(', ')})`,
    );
  }
}

function assertNotForbiddenMaterialPath(
  absPath: string,
  relPath: string,
  protectedDirs: readonly string[],
  judgeAbsPath: string | undefined,
  fieldPath: string[],
): void {
  assertNotInProtectedDirs(absPath, relPath, protectedDirs, fieldPath, 'Contest material');
  if (basename(absPath).toLowerCase().endsWith('.judge.json')) {
    throw new FieldError(fieldPath, `Judge answer file cannot be exposed as contest material: ${relPath}`);
  }
  if (judgeAbsPath && absPath === judgeAbsPath) {
    throw new FieldError(fieldPath, `Contest judge answers file cannot be exposed as contest material: ${relPath}`);
  }
}

async function ensureConfinedParentDir(baseReal: string, absTarget: string): Promise<void> {
  const relParent = relative(baseReal, dirname(absTarget));
  if (!relParent || relParent === '.') return;
  const parts = relParent.split(sep);
  let current = baseReal;
  for (const part of parts) {
    if (!part || part.startsWith('.') || part === '..') {
      throw new FieldError(['file'], `Unsafe parent directory segment: ${part}`);
    }
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new FieldError(['file'], `Parent path is not a real directory: ${current}`);
      }
    } catch (error) {
      if (isEnoent(error)) {
        await mkdir(current, { mode: 0o700 });
      } else {
        throw error;
      }
    }
  }
}

async function fileExistsNoFollow(absPath: string): Promise<boolean> {
  try {
    const info = await lstat(absPath);
    if (info.isSymbolicLink()) {
      throw new FieldError(['file'], `Refusing to touch symlink: ${absPath}`);
    }
    if (!info.isFile()) {
      throw new FieldError(['file'], `Target path exists and is not a regular file: ${absPath}`);
    }
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isExistingAgentDocument(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if ('contest_id' in obj || 'run_id' in obj || 'accepted_answers' in obj) return false;
  if (obj.kind === agentKind) return typeof obj.id === 'string' && obj.harness !== undefined;
  if (
    typeof obj.agent_id === 'string' &&
    obj.harness &&
    typeof obj.harness === 'object' &&
    typeof obj.config === 'string'
  ) {
    return true;
  }
  return agentSchema.safeParse(obj).success;
}

function isExistingContestDocument(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if ('run_id' in obj || 'agent_id' in obj || 'accepted_answers' in obj) return false;
  if (typeof obj.contest_id !== 'string') return false;
  if (obj.schema_version === 2) return obj.materials !== undefined && obj.judge !== undefined;
  if (obj.schema_version === 1) return obj.statement !== undefined && obj.judge !== undefined;
  return false;
}

function isExistingLocalJudgeDocument(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return obj.schema_version === 1 && Array.isArray(obj.problems);
}

async function readExistingForOverwriteCheck(
  baseReal: string,
  absPath: string,
  relPath: string,
  kind: 'agent' | 'contest' | 'judge' | 'pdf',
  fieldPath: string[],
): Promise<{ backup: Buffer; mode: number }> {
  const nameLower = basename(absPath).toLowerCase();
  if (kind === 'agent' || kind === 'contest') {
    if (nameLower === 'package.json' || nameLower === 'run.json' || nameLower.endsWith('.judge.json')) {
      throw new FieldError(fieldPath, `Refusing to overwrite non-${kind} file: ${relPath}`);
    }
  }
  const maxBytes = kind === 'pdf' ? 128 * 1024 * 1024 : kind === 'judge' ? MAX_JUDGE_FILE_BYTES : MAX_EXISTING_DOC_BYTES;
  const loaded = await readConfinedRegularFile(baseReal, absPath, fieldPath, maxBytes);

  if (kind === 'pdf') {
    if (loaded.bytes.length < 5 || !loaded.bytes.subarray(0, 5).equals(PDF_MAGIC)) {
      throw new FieldError(fieldPath, `Refusing to overwrite non-PDF file: ${relPath}`);
    }
    return { backup: loaded.bytes, mode: loaded.mode };
  }

  let parsed: unknown;
  try {
    if (kind === 'agent') {
      parsed = parseDocumentText(loaded.bytes.toString('utf8'), documentFormat(absPath));
    } else {
      parsed = JSON.parse(loaded.bytes.toString('utf8'));
    }
  } catch {
    throw new FieldError(fieldPath, `Refusing to overwrite existing file that is not a valid ${kind} resource: ${relPath}`);
  }

  const ok =
    kind === 'agent'
      ? isExistingAgentDocument(parsed)
      : kind === 'contest'
        ? isExistingContestDocument(parsed)
        : isExistingLocalJudgeDocument(parsed);
  if (!ok) {
    throw new FieldError(fieldPath, `Refusing to overwrite existing file that is not a ${kind} manifest: ${relPath}`);
  }
  return { backup: loaded.bytes, mode: loaded.mode };
}

async function atomicWriteFile(absPath: string, content: string | Buffer, overwrite: boolean, mode = 0o600): Promise<void> {
  const temp = `${absPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode, flag: 'wx' });
    if (overwrite) {
      try {
        const info = await lstat(absPath);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new FieldError(['file'], `Refusing to overwrite non-regular file: ${absPath}`);
        }
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      await rename(temp, absPath);
    } else {
      await link(temp, absPath);
    }
  } finally {
    await rm(temp, { force: true });
  }
}

interface RollbackEntry {
  path: string;
  existed: boolean;
  backup?: Buffer;
  mode?: number;
}

async function rollbackWrites(entries: RollbackEntry[]): Promise<void> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    try {
      if (entry.existed && entry.backup !== undefined) {
        await atomicWriteFile(entry.path, entry.backup, true, entry.mode ?? 0o600);
      } else if (!entry.existed) {
        await rm(entry.path, { force: true });
      }
    } catch {
      // Best-effort rollback of remaining files.
    }
  }
}

export interface AgentDigestsSummary {
  source_sha256: string;
  profile_sha256: string;
  native_sha256?: string;
  effective_sha256: string;
}

export interface BatchAgentItemResult {
  id: string;
  name?: string;
  path: string;
  format: Format;
  action: 'create' | 'skip' | 'overwrite';
  digests?: AgentDigestsSummary;
}

export interface BatchApplyAgentsOptions {
  base: string;
  root?: string;
  store?: Connections;
  dryRun?: boolean;
  ifExists?: IfExistsMode;
  allowedPrefixes?: string[];
  credentialDirs?: string[];
}

export interface BatchApplyAgentsResult {
  ok: boolean;
  dry_run: boolean;
  created: number;
  skipped: number;
  overwritten: number;
  items: BatchAgentItemResult[];
  errors: AutomationIssue[];
}

const batchAgentItemSchema = z.strictObject({
  file: z.string().trim().min(1).max(4096).optional(),
  format: formatSchema.optional(),
  document: z.record(z.string(), z.unknown()),
});

export async function batchApplyAgents(
  rawItems: unknown,
  opts: BatchApplyAgentsOptions,
): Promise<BatchApplyAgentsResult> {
  const dryRun = opts.dryRun === true;
  const ifExists = ifExistsSchema.parse(opts.ifExists ?? 'error');
  const store = opts.store ?? new Connections();
  const baseResolved = resolve(opts.base);
  let baseReal: string;
  try {
    baseReal = await realpath(baseResolved);
  } catch {
    return {
      ok: false,
      dry_run: dryRun,
      created: 0,
      skipped: 0,
      overwritten: 0,
      items: [],
      errors: [{ path: ['base'], message: `Workspace base does not exist: ${opts.base}`, code: 'path_error' }],
    };
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return {
      ok: false,
      dry_run: dryRun,
      created: 0,
      skipped: 0,
      overwritten: 0,
      items: [],
      errors: [{ path: ['items'], message: 'Expected a non-empty array of agent items', code: 'validation' }],
    };
  }
  if (rawItems.length > 256) {
    return {
      ok: false,
      dry_run: dryRun,
      created: 0,
      skipped: 0,
      overwritten: 0,
      items: [],
      errors: [{ path: ['items'], message: 'Maximum 256 agent items per batch', code: 'validation' }],
    };
  }

  const protectedDirs = await resolveProtectedDirs({
    baseReal,
    baseResolved,
    root: opts.root,
    store,
    credentialDirs: opts.credentialDirs,
  });

  const errors: AutomationIssue[] = [];
  const planned: Array<{
    id: string;
    name?: string;
    absPath: string;
    relPath: string;
    format: Format;
    provider: string;
    serialized: string;
    action: 'create' | 'skip' | 'overwrite';
    backup?: Buffer;
    backupMode?: number;
    digests: AgentDigestsSummary;
  }> = [];
  const seenTargets = new Set<string>();
  const referencedInputs = new Set<string>();

  for (let i = 0; i < rawItems.length; i++) {
    const rawEntry = rawItems[i];
    const secretHits = findSecretKeyPaths(rawEntry);
    if (secretHits.length > 0) {
      for (const hit of secretHits) {
        errors.push({
          index: i,
          path: hit,
          message: `Embedded secret field "${hit.join('.')}" is forbidden; reference a saved provider ID instead`,
          code: 'secret_rejected',
        });
      }
      continue;
    }

    let normalized: { file?: string; format?: Format; document: Record<string, unknown> };
    if (
      rawEntry &&
      typeof rawEntry === 'object' &&
      !Array.isArray(rawEntry) &&
      'kind' in rawEntry &&
      !('document' in rawEntry)
    ) {
      normalized = { document: rawEntry as Record<string, unknown> };
    } else {
      const parsed = batchAgentItemSchema.safeParse(rawEntry);
      if (!parsed.success) {
        errors.push({
          index: i,
          path: parsed.error.issues[0]?.path.map(String) ?? [],
          message: parsed.error.issues.map(iss => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; '),
          code: 'validation',
        });
        continue;
      }
      normalized = parsed.data;
    }

    const doc = normalized.document;
    const rawId = typeof doc.id === 'string' ? doc.id : undefined;
    let format: Format;
    try {
      if (normalized.format) {
        format = normalized.format;
        if (normalized.file && documentFormat(normalized.file) !== format) {
          throw new FieldError(['file'], `File extension does not match format "${format}"`);
        }
      } else if (normalized.file) {
        format = documentFormat(normalized.file);
      } else {
        format = 'toml';
      }
    } catch (error) {
      errors.push({
        index: i,
        id: rawId,
        path: ['file'],
        message: error instanceof Error ? error.message : 'Invalid file format',
        code: 'validation',
      });
      continue;
    }

    const manifestCheck = manifestSchema.safeParse(doc);
    if (!manifestCheck.success) {
      errors.push({
        index: i,
        id: rawId,
        path: manifestCheck.error.issues[0]?.path.map(String) ?? ['document'],
        message: manifestCheck.error.issues.map(iss => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; '),
        code: 'validation',
      });
      continue;
    }

    const defaultFile = `agents/${manifestCheck.data.id}.${format}`;
    let confined: { absPath: string; relPath: string };
    try {
      confined = await resolveConfinedPath(baseResolved, normalized.file ?? defaultFile);
      assertNotInProtectedDirs(confined.absPath, confined.relPath, protectedDirs, ['file'], 'Agent output');
      assertAllowedWritePrefix(confined.relPath, opts.allowedPrefixes, ['file']);
    } catch (error) {
      errors.push({
        index: i,
        id: manifestCheck.data.id,
        path: error instanceof FieldError ? error.path : ['file'],
        message: error instanceof Error ? error.message : 'Invalid output path',
        code: 'path_error',
      });
      continue;
    }

    if (seenTargets.has(confined.absPath)) {
      errors.push({
        index: i,
        id: manifestCheck.data.id,
        path: ['file'],
        message: `Duplicate target path in batch: ${confined.relPath}`,
        code: 'conflict',
      });
      continue;
    }
    let parentCollision = false;
    for (const prevTarget of seenTargets) {
      if (hasAncestorDescendantCollision(confined.absPath, prevTarget)) {
        errors.push({
          index: i,
          id: manifestCheck.data.id,
          path: ['file'],
          message: `Target path collides with parent/descendant path in batch: ${confined.relPath}`,
          code: 'conflict',
        });
        parentCollision = true;
        break;
      }
    }
    if (parentCollision) continue;
    seenTargets.add(confined.absPath);

    // Confine transitive references (native_config.path and legacy config) via O_NOFOLLOW BEFORE resolving.
    const nativeCfg = manifestCheck.data.harness.native_config;
    if (nativeCfg && 'path' in nativeCfg) {
      try {
        const nativeCandidate = resolve(dirname(confined.absPath), nativeCfg.path);
        const nativeRead = await readConfinedRegularFile(
          baseResolved,
          nativeCandidate,
          ['document', 'harness', 'native_config', 'path'],
          MAX_NATIVE_CONFIG_BYTES,
        );
        referencedInputs.add(nativeRead.absPath);
      } catch (error) {
        errors.push({
          index: i,
          id: manifestCheck.data.id,
          path: error instanceof FieldError ? error.path : ['document', 'harness', 'native_config', 'path'],
          message: error instanceof Error ? error.message : 'Invalid native_config path',
          code: error instanceof FieldError ? 'path_error' : 'validation',
        });
        continue;
      }
    }
    if (typeof doc.config === 'string') {
      try {
        const legacyCandidate = resolve(dirname(confined.absPath), doc.config);
        const legacyRead = await readConfinedRegularFile(
          baseResolved,
          legacyCandidate,
          ['document', 'config'],
          MAX_NATIVE_CONFIG_BYTES,
        );
        referencedInputs.add(legacyRead.absPath);
      } catch (error) {
        errors.push({
          index: i,
          id: manifestCheck.data.id,
          path: error instanceof FieldError ? error.path : ['document', 'config'],
          message: error instanceof Error ? error.message : 'Invalid legacy config path',
          code: error instanceof FieldError ? 'path_error' : 'validation',
        });
        continue;
      }
    }

    let resolved;
    try {
      resolved = await resolveAgentManifest(doc, confined.absPath, store);
    } catch (error) {
      errors.push({
        index: i,
        id: manifestCheck.data.id,
        path: error instanceof FieldError ? error.path : ['document'],
        message: error instanceof Error ? error.message : 'Invalid agent manifest',
        code: 'validation',
      });
      continue;
    }

    let exists: boolean;
    try {
      exists = await fileExistsNoFollow(confined.absPath);
    } catch (error) {
      errors.push({
        index: i,
        id: resolved.manifest.id,
        path: ['file'],
        message: error instanceof Error ? error.message : 'Unsafe existing target path',
        code: 'path_error',
      });
      continue;
    }

    let action: 'create' | 'skip' | 'overwrite' = 'create';
    let backup: Buffer | undefined;
    let backupMode: number | undefined;
    if (exists) {
      if (ifExists === 'error') {
        errors.push({
          index: i,
          id: resolved.manifest.id,
          path: ['file'],
          message: `Agent file already exists: ${confined.relPath}`,
          code: 'conflict',
        });
        continue;
      }
      if (ifExists === 'skip') {
        action = 'skip';
      } else {
        try {
          const prev = await readExistingForOverwriteCheck(baseReal, confined.absPath, confined.relPath, 'agent', ['file']);
          backup = prev.backup;
          backupMode = prev.mode;
          action = 'overwrite';
        } catch (error) {
          errors.push({
            index: i,
            id: resolved.manifest.id,
            path: ['file'],
            message: error instanceof Error ? error.message : 'Refusing to overwrite non-agent file',
            code: 'conflict',
          });
          continue;
        }
      }
    }

    const serialized = serializeDocument(resolved.manifest, format);
    const digestsRaw = agentDigests(resolved.profile, resolved.native, resolved.nativeText, resolved.env);
    const digests: AgentDigestsSummary = {
      source_sha256: sha256(serialized),
      profile_sha256: digestsRaw.profileDigest,
      ...(digestsRaw.nativeDigest ? { native_sha256: digestsRaw.nativeDigest } : {}),
      effective_sha256: digestsRaw.effectiveDigest,
    };

    planned.push({
      id: resolved.manifest.id,
      ...(resolved.manifest.name ? { name: resolved.manifest.name } : {}),
      absPath: confined.absPath,
      relPath: confined.relPath,
      format,
      provider: manifestProvider(resolved.manifest),
      serialized,
      action,
      backup,
      backupMode,
      digests,
    });
  }

  // Reject any target that collides with a referenced input in the same batch.
  for (const item of planned) {
    if (referencedInputs.has(item.absPath)) {
      errors.push({
        id: item.id,
        path: ['file'],
        message: `Target output path collides with a referenced input file in the same batch: ${item.relPath}`,
        code: 'conflict',
      });
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      dry_run: dryRun,
      created: 0,
      skipped: 0,
      overwritten: 0,
      items: [],
      errors,
    };
  }

  let created = 0;
  let skipped = 0;
  let overwritten = 0;
  const results: BatchAgentItemResult[] = [];
  const rollbackLog: RollbackEntry[] = [];

  try {
    for (const planItem of planned) {
      if (planItem.action === 'skip') {
        skipped++;
      } else {
        if (!dryRun) {
          await ensureConfinedParentDir(baseReal, planItem.absPath);
          await store.register(planItem.provider, planItem.absPath, () =>
            atomicWriteFile(planItem.absPath, planItem.serialized, planItem.action === 'overwrite', 0o600),
          );
          rollbackLog.push({
            path: planItem.absPath,
            existed: planItem.action === 'overwrite',
            backup: planItem.backup,
            mode: planItem.backupMode,
          });
        }
        if (planItem.action === 'create') created++;
        else overwritten++;
      }

      results.push({
        id: planItem.id,
        ...(planItem.name ? { name: planItem.name } : {}),
        path: planItem.relPath,
        format: planItem.format,
        action: planItem.action,
        digests: planItem.digests,
      });
    }
  } catch (error) {
    await rollbackWrites(rollbackLog);
    throw error;
  }

  return {
    ok: true,
    dry_run: dryRun,
    created,
    skipped,
    overwritten,
    items: results,
    errors: [],
  };
}

export const variantMatrixSpecSchema = z.strictObject({
  base_document: z.record(z.string(), z.unknown()),
  reasoning_efforts: z.array(z.string().trim().min(1)).max(16).optional(),
  speed_tiers: z.array(speedTierSchema).max(8).optional(),
  service_tiers: z.array(z.string().trim().min(1)).max(8).optional(),
  id_template: z.string().trim().min(1).max(160).optional(),
  name_template: z.string().trim().min(1).max(160).optional(),
  format: formatSchema.default('toml'),
  out_dir: z.string().trim().min(1).max(256).default('agents'),
});
export type VariantMatrixSpec = z.input<typeof variantMatrixSpecSchema>;

export interface GenerateVariantsOptions {
  base: string;
  root?: string;
  store?: Connections;
  dryRun?: boolean;
  ifExists?: IfExistsMode;
  allowedPrefixes?: string[];
  credentialDirs?: string[];
}

export interface GenerateVariantsResult {
  ok: boolean;
  dry_run: boolean;
  total: number;
  created: number;
  skipped: number;
  overwritten: number;
  variants: BatchAgentItemResult[];
  errors: AutomationIssue[];
}

const ALLOWED_TEMPLATE_VARS = new Set([
  'id',
  'base_id',
  'name',
  'base_name',
  'model',
  'effort',
  'reasoning_effort',
  'speed_tier',
  'service_tier',
]);

function sanitizeIdPart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

function findUnknownTemplateVars(template: string): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    const key = match[1] ?? '';
    if (!ALLOWED_TEMPLATE_VARS.has(key)) {
      unknown.push(key);
    }
  }
  return [...new Set(unknown)];
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_m, key: string) => vars[key] ?? '');
}

export async function generateAgentVariants(
  rawSpec: VariantMatrixSpec | unknown,
  opts: GenerateVariantsOptions,
): Promise<GenerateVariantsResult> {
  const dryRun = opts.dryRun === true;
  const ifExists = ifExistsSchema.parse(opts.ifExists ?? 'error');

  const secretHits = findSecretKeyPaths(rawSpec);
  if (secretHits.length > 0) {
    return {
      ok: false,
      dry_run: dryRun,
      total: 0,
      created: 0,
      skipped: 0,
      overwritten: 0,
      variants: [],
      errors: secretHits.map(hit => ({
        path: hit,
        message: `Embedded secret field "${hit.join('.')}" is forbidden; reference a saved provider ID instead`,
        code: 'secret_rejected',
      })),
    };
  }

  const parsed = variantMatrixSpecSchema.safeParse(rawSpec);
  if (!parsed.success) {
    return {
      ok: false,
      dry_run: dryRun,
      total: 0,
      created: 0,
      skipped: 0,
      overwritten: 0,
      variants: [],
      errors: parsed.error.issues.map(iss => ({
        path: iss.path.map(String),
        message: iss.message,
        code: 'validation',
      })),
    };
  }

  const spec = parsed.data;
  const templateErrors: AutomationIssue[] = [];
  if (spec.id_template) {
    const bad = findUnknownTemplateVars(spec.id_template);
    if (bad.length > 0) {
      templateErrors.push({
        path: ['id_template'],
        message: `Unknown template placeholder(s) in id_template: ${bad.map(v => `{${v}}`).join(', ')}`,
        code: 'validation',
      });
    }
  }
  if (spec.name_template) {
    const bad = findUnknownTemplateVars(spec.name_template);
    if (bad.length > 0) {
      templateErrors.push({
        path: ['name_template'],
        message: `Unknown template placeholder(s) in name_template: ${bad.map(v => `{${v}}`).join(', ')}`,
        code: 'validation',
      });
    }
  }

  // Reject absolute out_dir (including "/") or unsafe relative segments explicitly.
  if (isAbsolute(spec.out_dir) || spec.out_dir.startsWith('/') || spec.out_dir.startsWith('\\') || spec.out_dir.includes('\0')) {
    templateErrors.push({
      path: ['out_dir'],
      message: `out_dir must be a relative workspace directory: ${spec.out_dir}`,
      code: 'path_error',
    });
  } else {
    const cleanOut = spec.out_dir.replace(/\/+$/g, '');
    const segs = cleanOut.split(/[\\/]/);
    if (!cleanOut || segs.some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) {
      templateErrors.push({
        path: ['out_dir'],
        message: `Invalid or hidden segment in out_dir: ${spec.out_dir}`,
        code: 'path_error',
      });
    }
  }

  if (templateErrors.length > 0) {
    return {
      ok: false,
      dry_run: dryRun,
      total: 0,
      created: 0,
      skipped: 0,
      overwritten: 0,
      variants: [],
      errors: templateErrors,
    };
  }

  const baseDoc = spec.base_document;
  const baseManifestCheck = manifestSchema.safeParse(baseDoc);
  if (!baseManifestCheck.success) {
    return {
      ok: false,
      dry_run: dryRun,
      total: 0,
      created: 0,
      skipped: 0,
      overwritten: 0,
      variants: [],
      errors: baseManifestCheck.error.issues.map(iss => ({
        path: ['base_document', ...iss.path.map(String)],
        message: iss.message,
        code: 'validation',
      })),
    };
  }

  const baseManifest = baseManifestCheck.data;
  const effortsAxis: Array<string | undefined> = spec.reasoning_efforts?.length ? spec.reasoning_efforts : [undefined];
  const speedAxis: Array<z.infer<typeof speedTierSchema> | undefined> = spec.speed_tiers?.length
    ? spec.speed_tiers
    : [undefined];
  const serviceAxis: Array<string | undefined> = spec.service_tiers?.length ? spec.service_tiers : [undefined];

  const total = effortsAxis.length * speedAxis.length * serviceAxis.length;
  if (total > 64) {
    return {
      ok: false,
      dry_run: dryRun,
      total,
      created: 0,
      skipped: 0,
      overwritten: 0,
      variants: [],
      errors: [
        {
          path: ['variants'],
          message: `Variant matrix expands to ${total} variants, exceeding maximum of 64 per call`,
          code: 'validation',
        },
      ],
    };
  }

  const batchItems: Array<{ file: string; format: Format; document: Record<string, unknown> }> = [];
  const baseOptions = { ...(baseManifest.harness.options ?? {}) };
  const cleanOutDir = spec.out_dir.replace(/\/+$/g, '');

  for (const effort of effortsAxis) {
    for (const speedTier of speedAxis) {
      for (const serviceTier of serviceAxis) {
        const nextOptions: Record<string, unknown> = { ...baseOptions };
        if (effort !== undefined) nextOptions.reasoning_effort = effort;
        if (serviceTier !== undefined) nextOptions.service_tier = serviceTier;

        const vars: Record<string, string> = {
          id: baseManifest.id,
          base_id: baseManifest.id,
          name: baseManifest.name ?? baseManifest.id,
          base_name: baseManifest.name ?? baseManifest.id,
          model: sanitizeIdPart(baseManifest.model),
          effort: effort ?? '',
          reasoning_effort: effort ?? '',
          speed_tier: speedTier ?? baseManifest.speed_tier ?? 'standard',
          service_tier: serviceTier ?? '',
        };

        let variantId: string;
        if (spec.id_template) {
          variantId = sanitizeIdPart(renderTemplate(spec.id_template, vars));
        } else {
          const suffixParts = [effort, speedTier, serviceTier]
            .filter((x): x is string => Boolean(x))
            .map(sanitizeIdPart)
            .filter(Boolean);
          variantId = suffixParts.length ? `${baseManifest.id}-${suffixParts.join('-')}` : baseManifest.id;
        }

        let variantName: string | undefined;
        if (spec.name_template) {
          const rendered = renderTemplate(spec.name_template, { ...vars, id: variantId }).trim();
          if (rendered) variantName = rendered;
        } else if (baseManifest.name) {
          const tags = [effort, speedTier, serviceTier].filter((x): x is string => Boolean(x));
          variantName = tags.length ? `${baseManifest.name} (${tags.join(' · ')})` : baseManifest.name;
        }

        const variantDoc: Record<string, unknown> = {
          kind: agentKind,
          schema_version: 1,
          id: variantId,
          ...(variantName ? { name: variantName } : {}),
          ...(baseManifest.vendor ? { vendor: baseManifest.vendor } : {}),
          model: baseManifest.model,
          ...(speedTier !== undefined
            ? { speed_tier: speedTier }
            : baseManifest.speed_tier !== undefined
              ? { speed_tier: baseManifest.speed_tier }
              : {}),
          ...(baseManifest.provider ? { provider: baseManifest.provider } : { connection: baseManifest.connection }),
          harness: {
            kind: baseManifest.harness.kind,
            version: baseManifest.harness.version,
            options: nextOptions,
            ...(baseManifest.harness.env ? { env: baseManifest.harness.env } : {}),
            ...(baseManifest.harness.native_config ? { native_config: baseManifest.harness.native_config } : {}),
          },
        };

        batchItems.push({
          file: `${cleanOutDir}/${variantId}.${spec.format}`,
          format: spec.format,
          document: variantDoc,
        });
      }
    }
  }

  const applied = await batchApplyAgents(batchItems, {
    base: opts.base,
    root: opts.root,
    store: opts.store,
    dryRun,
    ifExists,
    allowedPrefixes: opts.allowedPrefixes,
    credentialDirs: opts.credentialDirs,
  });

  return {
    ok: applied.ok,
    dry_run: applied.dry_run,
    total,
    created: applied.created,
    skipped: applied.skipped,
    overwritten: applied.overwritten,
    variants: applied.items,
    errors: applied.errors,
  };
}

export interface BatchContestItemResult {
  contest_id: string;
  path: string;
  judge_path?: string;
  pdf_path?: string;
  action: 'create' | 'skip' | 'overwrite';
  revision?: string;
  pdf_info?: Pick<PdfInfo, 'page_count' | 'size_bytes' | 'sha256' | 'problem_ids' | 'extractor'>;
  inferred_problem_map?: ProblemMapInference;
}

export interface BatchImportContestsOptions {
  root?: string;
  base: string;
  dryRun?: boolean;
  ifExists?: IfExistsMode;
  signal?: AbortSignal;
  useExternalPdfTools?: boolean;
  allowedPrefixes?: string[];
  credentialDirs?: string[];
}

export interface BatchImportContestsResult {
  ok: boolean;
  dry_run: boolean;
  created: number;
  skipped: number;
  overwritten: number;
  items: BatchContestItemResult[];
  errors: AutomationIssue[];
}

const batchContestItemSchema = z.strictObject({
  file: z.string().trim().min(1).max(4096).optional(),
  document: z.record(z.string(), z.unknown()),
  judge: judgeSchema.optional(),
  synth_problems: z.array(synthProblemSchema).min(1).max(100).optional(),
  synth_title: z.string().trim().min(1).max(200).optional(),
  synth_subtitle: z.string().trim().min(1).max(200).optional(),
  allow_ascii_fallback: z.boolean().optional(),
  auto_problem_map: z.boolean().optional(),
});

async function synthesizePdfToBuffer(
  problems: z.infer<typeof synthProblemSchema>[],
  opts: { title?: string; subtitle?: string; allowAsciiFallback: boolean },
): Promise<{
  bytes: Buffer;
  pdfInfo: Pick<PdfInfo, 'page_count' | 'size_bytes' | 'sha256' | 'problem_ids' | 'extractor'>;
}> {
  const stageDir = await mkdtemp(join(tmpdir(), 'cr-synth-stage-'));
  await chmod(stageDir, 0o700);
  try {
    const stagedPath = join(stageDir, 'staged.pdf');
    const synth = await synthesizeTextContestPdf(problems, stagedPath, {
      title: opts.title,
      subtitle: opts.subtitle,
      overwrite: true,
      allowAsciiFallback: opts.allowAsciiFallback,
    });
    const handle = await open(stagedPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      const buf = Buffer.allocUnsafe(info.size);
      let offset = 0;
      while (offset < info.size) {
        const { bytesRead } = await handle.read(buf, offset, info.size - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return {
        bytes: buf.subarray(0, offset),
        pdfInfo: {
          page_count: synth.page_count,
          size_bytes: synth.size_bytes,
          sha256: synth.sha256,
          problem_ids: synth.problem_ids,
          extractor: 'fallback',
        },
      };
    } finally {
      await handle.close();
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

export async function batchImportContests(
  rawItems: unknown,
  opts: BatchImportContestsOptions,
): Promise<BatchImportContestsResult> {
  const dryRun = opts.dryRun === true;
  const ifExists = ifExistsSchema.parse(opts.ifExists ?? 'error');
  const baseResolved = resolve(opts.base);
  let baseReal: string;
  try {
    baseReal = await realpath(baseResolved);
  } catch {
    return {
      ok: false,
      dry_run: dryRun,
      created: 0,
      skipped: 0,
      overwritten: 0,
      items: [],
      errors: [{ path: ['base'], message: `Workspace base does not exist: ${opts.base}`, code: 'path_error' }],
    };
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return {
      ok: false,
      dry_run: dryRun,
      created: 0,
      skipped: 0,
      overwritten: 0,
      items: [],
      errors: [{ path: ['items'], message: 'Expected a non-empty array of contest items', code: 'validation' }],
    };
  }
  if (rawItems.length > 256) {
    return {
      ok: false,
      dry_run: dryRun,
      created: 0,
      skipped: 0,
      overwritten: 0,
      items: [],
      errors: [{ path: ['items'], message: 'Maximum 256 contest items per batch', code: 'validation' }],
    };
  }

  const protectedDirs = await resolveProtectedDirs({
    baseReal,
    baseResolved,
    root: opts.root,
    credentialDirs: opts.credentialDirs,
  });

  const errors: AutomationIssue[] = [];
  const seenTargets = new Set<string>();
  const referencedInputs = new Set<string>();

  const reserveTarget = (
    absPath: string,
    relPath: string,
    index: number,
    contestId: string,
    fieldPath: string[],
  ): boolean => {
    if (seenTargets.has(absPath)) {
      errors.push({
        index,
        id: contestId,
        path: fieldPath,
        message: `Duplicate target path in batch: ${relPath}`,
        code: 'conflict',
      });
      return false;
    }
    for (const prevTarget of seenTargets) {
      if (hasAncestorDescendantCollision(absPath, prevTarget)) {
        errors.push({
          index,
          id: contestId,
          path: fieldPath,
          message: `Target path collides with parent/descendant path in batch: ${relPath}`,
          code: 'conflict',
        });
        return false;
      }
    }
    seenTargets.add(absPath);
    return true;
  };

  type PlannedContest = {
    contest_id: string;
    absPath: string;
    relPath: string;
    action: 'create' | 'skip' | 'overwrite';
    manifestExists: boolean;
    manifestBackup?: Buffer;
    manifestBackupMode?: number;
    manifestDraft: Record<string, unknown>;
    plannedRevision: string;
    judgeJsonBytes?: Buffer;
    judgeAbsPath?: string;
    judgeRelPath?: string;
    judgeExists: boolean;
    judgeBackup?: Buffer;
    judgeBackupMode?: number;
    synthPdfBytes?: Buffer;
    synthPdfAbsPath?: string;
    synthPdfRelPath?: string;
    synthPdfExists: boolean;
    synthPdfBackup?: Buffer;
    synthPdfBackupMode?: number;
    pdfInfo?: Pick<PdfInfo, 'page_count' | 'size_bytes' | 'sha256' | 'problem_ids' | 'extractor'>;
    inferredProblemMap?: ProblemMapInference;
    outputPaths: Array<{ absPath: string; relPath: string }>;
  };
  const planned: PlannedContest[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    opts.signal?.throwIfAborted();
    const rawEntry = rawItems[i];
    const secretHits = findSecretKeyPaths(rawEntry);
    if (secretHits.length > 0) {
      for (const hit of secretHits) {
        errors.push({
          index: i,
          path: hit,
          message: `Embedded secret field "${hit.join('.')}" is forbidden; reference a saved OJ account_id or pool instead`,
          code: 'secret_rejected',
        });
      }
      continue;
    }

    let normalized: z.infer<typeof batchContestItemSchema>;
    if (
      rawEntry &&
      typeof rawEntry === 'object' &&
      !Array.isArray(rawEntry) &&
      'contest_id' in rawEntry &&
      !('document' in rawEntry)
    ) {
      const parsed = batchContestItemSchema.safeParse({ document: rawEntry });
      if (!parsed.success) {
        errors.push({
          index: i,
          path: parsed.error.issues[0]?.path.map(String) ?? [],
          message: parsed.error.issues.map(iss => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; '),
          code: 'validation',
        });
        continue;
      }
      normalized = parsed.data;
    } else {
      const parsed = batchContestItemSchema.safeParse(rawEntry);
      if (!parsed.success) {
        errors.push({
          index: i,
          path: parsed.error.issues[0]?.path.map(String) ?? [],
          message: parsed.error.issues.map(iss => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; '),
          code: 'validation',
        });
        continue;
      }
      normalized = parsed.data;
    }

    const { kind: docKind, ...docFields } = normalized.document;
    if (docKind !== undefined && docKind !== 'contestreplay.dev/contest') {
      errors.push({
        index: i,
        path: ['document', 'kind'],
        message: 'Unsupported Contest manifest kind',
        code: 'validation',
      });
      continue;
    }

    const contestIdCheck = idSchema.safeParse(docFields.contest_id);
    if (!contestIdCheck.success) {
      errors.push({
        index: i,
        path: ['document', 'contest_id'],
        message: 'Invalid contest_id',
        code: 'validation',
      });
      continue;
    }
    const contestId = contestIdCheck.data;

    const targetFile = normalized.file ?? `contests/${contestId}.json`;
    if (extname(targetFile).toLowerCase() !== '.json') {
      errors.push({
        index: i,
        id: contestId,
        path: ['file'],
        message: 'Contest manifest path must end in .json',
        code: 'validation',
      });
      continue;
    }
    if (basename(targetFile).toLowerCase().endsWith('.judge.json')) {
      errors.push({
        index: i,
        id: contestId,
        path: ['file'],
        message: 'Contest manifest path cannot end in .judge.json',
        code: 'validation',
      });
      continue;
    }

    let confined: { absPath: string; relPath: string };
    try {
      confined = await resolveConfinedPath(baseResolved, targetFile);
      assertNotInProtectedDirs(confined.absPath, confined.relPath, protectedDirs, ['file'], 'Contest output');
      assertAllowedWritePrefix(confined.relPath, opts.allowedPrefixes, ['file']);
    } catch (error) {
      errors.push({
        index: i,
        id: contestId,
        path: ['file'],
        message: error instanceof Error ? error.message : 'Invalid contest path',
        code: 'path_error',
      });
      continue;
    }

    const itemOutputs: Array<{ absPath: string; relPath: string }> = [{ absPath: confined.absPath, relPath: confined.relPath }];
    if (!reserveTarget(confined.absPath, confined.relPath, i, contestId, ['file'])) continue;

    let manifestExists: boolean;
    try {
      manifestExists = await fileExistsNoFollow(confined.absPath);
    } catch (error) {
      errors.push({
        index: i,
        id: contestId,
        path: ['file'],
        message: error instanceof Error ? error.message : 'Unsafe target path',
        code: 'path_error',
      });
      continue;
    }

    // Prepare judge / answers.
    const rawJudge =
      docFields.judge && typeof docFields.judge === 'object' && !Array.isArray(docFields.judge)
        ? { ...(docFields.judge as Record<string, unknown>) }
        : undefined;
    if (!rawJudge || typeof rawJudge.kind !== 'string') {
      errors.push({
        index: i,
        id: contestId,
        path: ['document', 'judge'],
        message: 'Missing judge configuration',
        code: 'validation',
      });
      continue;
    }

    let answers: z.infer<typeof judgeSchema> | undefined;
    let judgeJsonBytes: Buffer | undefined;
    let judgeAbsPath: string | undefined;
    let judgeRelPath: string | undefined;
    let judgeExists = false;
    let existingAnswersAbsPath: string | undefined;
    let problems = docFields.problems;
    let resolvedJudge: Record<string, unknown> = rawJudge;

    if (rawJudge.kind === 'local') {
      const hasInlineJudgeProblems = Array.isArray(rawJudge.problems);
      const hasInlineDocProblems =
        Array.isArray(problems) &&
        problems.some(p => p && typeof p === 'object' && Object.hasOwn(p, 'accepted_answers'));
      if (normalized.judge && hasInlineJudgeProblems) {
        errors.push({
          index: i,
          id: contestId,
          path: ['judge'],
          message: 'Supply only one local answer table (either item.judge or document.judge.problems)',
          code: 'validation',
        });
        continue;
      }
      if (normalized.judge || hasInlineJudgeProblems || hasInlineDocProblems) {
        const answersCheck = judgeSchema.safeParse(
          normalized.judge ?? { schema_version: 1, problems: hasInlineJudgeProblems ? rawJudge.problems : problems },
        );
        if (!answersCheck.success) {
          errors.push({
            index: i,
            id: contestId,
            path: ['judge'],
            message: answersCheck.error.issues.map(iss => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; '),
            code: 'validation',
          });
          continue;
        }
        answers = answersCheck.data;
        judgeJsonBytes = Buffer.from(JSON.stringify(answers, null, 2) + '\n', 'utf8');
        if (!normalized.judge && !hasInlineJudgeProblems) problems = undefined;
        problems ??= answers.problems.map(({ id, max_points }) => ({ id, max_points }));

        const stem = basename(confined.absPath, '.json');
        const judgeFileRel = relative(baseReal, join(dirname(confined.absPath), `${stem}.judge.json`));
        try {
          const jConfined = await resolveConfinedPath(baseReal, judgeFileRel, ['judge']);
          assertNotInProtectedDirs(jConfined.absPath, jConfined.relPath, protectedDirs, ['judge'], 'Judge output');
          assertAllowedWritePrefix(jConfined.relPath, opts.allowedPrefixes, ['judge']);
          judgeAbsPath = jConfined.absPath;
          judgeRelPath = jConfined.relPath;
          judgeExists = await fileExistsNoFollow(judgeAbsPath);
        } catch (error) {
          errors.push({
            index: i,
            id: contestId,
            path: ['judge'],
            message: error instanceof Error ? error.message : 'Invalid judge file path',
            code: 'path_error',
          });
          continue;
        }
        if (!reserveTarget(judgeAbsPath, judgeRelPath, i, contestId, ['judge'])) continue;
        itemOutputs.push({ absPath: judgeAbsPath, relPath: judgeRelPath });
        resolvedJudge = {
          kind: 'local',
          answers: { path: `${stem}.judge.json`, redistribution: 'restricted' },
        };
      }
    } else if (normalized.judge) {
      errors.push({
        index: i,
        id: contestId,
        path: ['judge'],
        message: `Judge kind "${rawJudge.kind}" does not accept a local answer file`,
        code: 'validation',
      });
      continue;
    }

    // Prepare materials / PDF (staged synthesis or confined existing PDF).
    let synthPdfBytes: Buffer | undefined;
    let synthPdfAbsPath: string | undefined;
    let synthPdfRelPath: string | undefined;
    let synthPdfExists = false;
    let pdfInfo: Pick<PdfInfo, 'page_count' | 'size_bytes' | 'sha256' | 'problem_ids' | 'extractor'> | undefined;
    let entrypointHash: string | undefined;
    let entrypointBytesLen: number | undefined;
    let materials: Record<string, unknown>;

    const rawMats =
      docFields.materials && typeof docFields.materials === 'object' && !Array.isArray(docFields.materials)
        ? (docFields.materials as Record<string, unknown>)
        : undefined;
    const rawEntrypoint =
      rawMats?.entrypoint && typeof rawMats.entrypoint === 'object' && !Array.isArray(rawMats.entrypoint)
        ? (rawMats.entrypoint as Record<string, unknown>)
        : undefined;

    if (normalized.synth_problems) {
      const stem = basename(confined.absPath, '.json');
      const pdfFileRel = relative(baseReal, join(dirname(confined.absPath), `${stem}.pdf`));
      try {
        const pConfined = await resolveConfinedPath(baseReal, pdfFileRel, ['materials']);
        assertNotInProtectedDirs(pConfined.absPath, pConfined.relPath, protectedDirs, ['materials'], 'PDF output');
        assertAllowedWritePrefix(pConfined.relPath, opts.allowedPrefixes, ['materials']);
        synthPdfAbsPath = pConfined.absPath;
        synthPdfRelPath = pConfined.relPath;
        synthPdfExists = await fileExistsNoFollow(synthPdfAbsPath);
      } catch (error) {
        errors.push({
          index: i,
          id: contestId,
          path: ['materials'],
          message: error instanceof Error ? error.message : 'Invalid synthesized PDF path',
          code: 'path_error',
        });
        continue;
      }
      if (!reserveTarget(synthPdfAbsPath, synthPdfRelPath, i, contestId, ['materials'])) continue;
      itemOutputs.push({ absPath: synthPdfAbsPath, relPath: synthPdfRelPath });

      try {
        const staged = await synthesizePdfToBuffer(normalized.synth_problems, {
          title: normalized.synth_title ?? (typeof docFields.title === 'string' ? docFields.title : undefined),
          subtitle: normalized.synth_subtitle,
          allowAsciiFallback: normalized.allow_ascii_fallback === true,
        });
        synthPdfBytes = staged.bytes;
        pdfInfo = staged.pdfInfo;
        entrypointHash = staged.pdfInfo.sha256;
        entrypointBytesLen = staged.bytes.length;
      } catch (error) {
        errors.push({
          index: i,
          id: contestId,
          path: ['synth_problems'],
          message: error instanceof Error ? error.message : 'Failed to synthesize PDF',
          code: 'validation',
        });
        continue;
      }

      materials = {
        entrypoint: {
          kind: 'pdf',
          path: `${stem}.pdf`,
          sha256: entrypointHash,
          redistribution: 'allowed',
        },
        attachments: Array.isArray(rawMats?.attachments) ? rawMats.attachments : [],
      };
    } else {
      if (!rawEntrypoint || typeof rawEntrypoint.path !== 'string') {
        errors.push({
          index: i,
          id: contestId,
          path: ['document', 'materials', 'entrypoint'],
          message: 'Provide either materials.entrypoint.path or synth_problems',
          code: 'validation',
        });
        continue;
      }
      const candidatePdfPath = isAbsolute(rawEntrypoint.path)
        ? rawEntrypoint.path
        : resolve(dirname(confined.absPath), rawEntrypoint.path);
      try {
        const pdfConfined = await resolveConfinedPath(baseResolved, candidatePdfPath, [
          'document',
          'materials',
          'entrypoint',
          'path',
        ]);
        assertNotForbiddenMaterialPath(
          pdfConfined.absPath,
          pdfConfined.relPath,
          protectedDirs,
          judgeAbsPath,
          ['document', 'materials', 'entrypoint', 'path'],
        );
        // Verify regular file via O_NOFOLLOW before inspecting.
        const pdfFile = await readConfinedRegularFile(
          baseReal,
          pdfConfined.absPath,
          ['document', 'materials', 'entrypoint', 'path'],
          128 * 1024 * 1024,
        );
        if (pdfFile.bytes.length < 5 || !pdfFile.bytes.subarray(0, 5).equals(PDF_MAGIC)) {
          throw new FieldError(['document', 'materials', 'entrypoint', 'path'], `Missing PDF header: ${pdfConfined.relPath}`);
        }
        const computedHash = sha256(pdfFile.bytes);
        if (typeof rawEntrypoint.sha256 === 'string' && rawEntrypoint.sha256 !== computedHash) {
          throw new FieldError(['document', 'materials', 'entrypoint', 'sha256'], `Entrypoint PDF SHA-256 mismatch: ${pdfConfined.relPath}`);
        }
        referencedInputs.add(pdfConfined.absPath);
        entrypointHash = computedHash;
        entrypointBytesLen = pdfFile.bytes.length;

        const info = await inspectPdf(pdfConfined.absPath, {
          useExternalTools: opts.useExternalPdfTools ?? false,
        });
        pdfInfo = {
          page_count: info.page_count,
          size_bytes: info.size_bytes,
          sha256: info.sha256,
          problem_ids: info.problem_ids,
          extractor: info.extractor,
        };
      } catch (error) {
        errors.push({
          index: i,
          id: contestId,
          path: error instanceof FieldError ? error.path : ['document', 'materials', 'entrypoint', 'path'],
          message: error instanceof Error ? error.message : 'Could not inspect referenced PDF',
          code: error instanceof FieldError && error.path.includes('path') ? 'path_error' : 'validation',
        });
        continue;
      }
      materials = {
        entrypoint: { ...rawEntrypoint, kind: 'pdf' },
        attachments: Array.isArray(rawMats?.attachments) ? rawMats.attachments : [],
      };
    }

    // Optional auto problem_map inference for remote OJ judges.
    let inferredProblemMap: ProblemMapInference | undefined;
    const detectedProblemIds = normalized.synth_problems
      ? normalized.synth_problems.map(p => p.id)
      : pdfInfo?.problem_ids ?? [];
    if (rawJudge.kind !== 'local' && !rawJudge.problem_map && normalized.auto_problem_map !== false) {
      const validProblems = Array.isArray(problems)
        ? problems.filter(
            (p): p is { id: string; max_points: number } =>
              Boolean(
                p &&
                  typeof p === 'object' &&
                  typeof (p as { id?: unknown }).id === 'string' &&
                  typeof (p as { max_points?: unknown }).max_points === 'number',
              ),
          )
        : [];

      if (detectedProblemIds.length > 0 && validProblems.length > 0) {
        const remoteIds = validProblems.map(p => ({ remote_id: p.id }));
        inferredProblemMap = inferProblemMap(detectedProblemIds, remoteIds);
        const completeBijection =
          inferredProblemMap.unmapped_local.length === 0 &&
          inferredProblemMap.unmapped_remote.length === 0 &&
          Object.keys(inferredProblemMap.confirmed_map).length === detectedProblemIds.length;

        if (completeBijection) {
          const remoteById = new Map(validProblems.map(p => [p.id, p]));
          // Rewrite problems to carry local PDF IDs with matched remote max_points!
          problems = detectedProblemIds.map(localId => {
            const remoteId = inferredProblemMap!.confirmed_map[localId]!;
            const remoteProb = remoteById.get(remoteId)!;
            return { id: localId, max_points: remoteProb.max_points };
          });
          const hasDifference = Object.entries(inferredProblemMap.confirmed_map).some(([k, v]) => k !== v);
          if (hasDifference) {
            resolvedJudge = { ...resolvedJudge, problem_map: inferredProblemMap.confirmed_map };
          }
        } else {
          errors.push({
            index: i,
            id: contestId,
            path: ['document', 'judge', 'problem_map'],
            message: `Incomplete auto problem_map inference (unmapped local: [${inferredProblemMap.unmapped_local.join(', ')}], unmapped remote: [${inferredProblemMap.unmapped_remote.join(', ')}]); provide an explicit judge.problem_map or set auto_problem_map: false`,
            code: 'validation',
          });
          continue;
        }
      } else if (normalized.auto_problem_map === true) {
        errors.push({
          index: i,
          id: contestId,
          path: ['document', 'judge', 'problem_map'],
          message: 'auto_problem_map enabled but problem IDs could not be detected from PDF or contest problems',
          code: 'validation',
        });
        continue;
      }
    }

    const manifestDraft: Record<string, unknown> = {
      schema_version: 2,
      ...docFields,
      materials,
      ...(problems !== undefined ? { problems } : {}),
      judge: resolvedJudge,
    };

    const schemaCheck = contestSchema.safeParse(manifestDraft);
    if (!schemaCheck.success) {
      errors.push({
        index: i,
        id: contestId,
        path: ['document', ...(schemaCheck.error.issues[0]?.path.map(String) ?? [])],
        message: schemaCheck.error.issues.map(iss => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; '),
        code: 'validation',
      });
      continue;
    }

    const parsedContest = schemaCheck.data;

    // Validate PDF byte limit against resolved protocol preset (matching resolveContest).
    const preset = protocolPresets[resolveProtocolPreset(parsedContest.rules)];
    const maxPdfBytes = Math.max(40_000_000, preset.pdfMaxBytes);
    if (entrypointBytesLen !== undefined && entrypointBytesLen > maxPdfBytes) {
      errors.push({
        index: i,
        id: contestId,
        path: ['document', 'materials', 'entrypoint'],
        message: `Entrypoint PDF (${entrypointBytesLen} bytes) exceeds limit of ${maxPdfBytes} bytes`,
        code: 'validation',
      });
      continue;
    }

    // Validate local or remote judge invariants BEFORE touching disk (parity with resolveContest).
    let finalJudgeHash: string | undefined;
    let finalProblems = parsedContest.problems;

    if (parsedContest.judge.kind === 'local') {
      if (answers && judgeJsonBytes) {
        finalJudgeHash = sha256(judgeJsonBytes);
        if (
          finalProblems &&
          (finalProblems.length !== answers.problems.length ||
            finalProblems.some(p => !answers!.problems.some(q => q.id === p.id && q.max_points === p.max_points)))
        ) {
          errors.push({
            index: i,
            id: contestId,
            path: ['document', 'problems'],
            message: 'Contest problems do not match local answers file',
            code: 'validation',
          });
          continue;
        }
        finalProblems ??= answers.problems.map(({ id, max_points }) => ({ id, max_points }));
      } else {
        // External existing judge answers file: confine, O_NOFOLLOW, verify sha256, sanitize parse errors!
        const ansCandidate = resolve(dirname(confined.absPath), parsedContest.judge.answers.path);
        let ansConfined: { absPath: string; relPath: string };
        try {
          ansConfined = await resolveConfinedPath(baseResolved, ansCandidate, ['document', 'judge', 'answers', 'path']);
        } catch (error) {
          errors.push({
            index: i,
            id: contestId,
            path: ['document', 'judge', 'answers', 'path'],
            message: error instanceof Error ? error.message : 'Invalid local answers file path',
            code: 'path_error',
          });
          continue;
        }
        existingAnswersAbsPath = ansConfined.absPath;
        referencedInputs.add(ansConfined.absPath);

        let ansBytes: Buffer;
        try {
          const loaded = await readConfinedRegularFile(
            baseReal,
            ansConfined.absPath,
            ['document', 'judge', 'answers', 'path'],
            MAX_JUDGE_FILE_BYTES,
          );
          ansBytes = loaded.bytes;
        } catch {
          // Sanitized fixed public diagnostic message (never leaks raw fs/parse excerpts).
          errors.push({
            index: i,
            id: contestId,
            path: ['document', 'judge', 'answers', 'path'],
            message: 'Local answers file could not be read or exceeds size limit',
            code: 'validation',
          });
          continue;
        }

        const ansHash = sha256(ansBytes);
        if (parsedContest.judge.answers.sha256 && parsedContest.judge.answers.sha256 !== ansHash) {
          errors.push({
            index: i,
            id: contestId,
            path: ['document', 'judge', 'answers', 'sha256'],
            message: 'Local answers file SHA-256 mismatch',
            code: 'validation',
          });
          continue;
        }
        finalJudgeHash = ansHash;

        let parsedAnsJson: unknown;
        try {
          parsedAnsJson = JSON.parse(ansBytes.toString('utf8'));
        } catch {
          errors.push({
            index: i,
            id: contestId,
            path: ['document', 'judge', 'answers', 'path'],
            message: 'Local answers file is not valid JSON',
            code: 'validation',
          });
          continue;
        }

        const ansSchemaCheck = judgeSchema.safeParse(parsedAnsJson);
        if (!ansSchemaCheck.success) {
          errors.push({
            index: i,
            id: contestId,
            path: ['document', 'judge', 'answers', 'path'],
            message: 'Local answers file failed judge schema validation',
            code: 'validation',
          });
          continue;
        }

        const externalJudge = ansSchemaCheck.data;
        if (
          finalProblems &&
          (finalProblems.length !== externalJudge.problems.length ||
            finalProblems.some(p => !externalJudge.problems.some(q => q.id === p.id && q.max_points === p.max_points)))
        ) {
          errors.push({
            index: i,
            id: contestId,
            path: ['document', 'problems'],
            message: 'Contest problems do not match local answers file',
            code: 'validation',
          });
          continue;
        }
        finalProblems ??= externalJudge.problems.map(({ id, max_points }) => ({ id, max_points }));
      }
    } else {
      // Codeforces invariants (identical to resolveContest).
      if (!finalProblems || finalProblems.length === 0 || Object.keys(parsedContest.judge.languages).length === 0) {
        errors.push({
          index: i,
          id: contestId,
          path: ['document', 'judge'],
          message: 'Codeforces requires explicit non-empty problems and language IDs',
          code: 'validation',
        });
        continue;
      }
      const mapping = parsedContest.judge.problem_map ?? {};
      if (Object.keys(mapping).some(key => !finalProblems!.some(p => p.id === key))) {
        errors.push({
          index: i,
          id: contestId,
          path: ['document', 'judge', 'problem_map'],
          message: 'Unknown problem in Codeforces mapping',
          code: 'validation',
        });
        continue;
      }
      const targets = finalProblems.map(p => (Object.hasOwn(mapping, p.id) ? mapping[p.id]! : p.id));
      if (new Set(targets).size !== targets.length || targets.some(t => !/^[A-Za-z0-9]{1,12}$/.test(t))) {
        errors.push({
          index: i,
          id: contestId,
          path: ['document', 'judge', 'problem_map'],
          message: 'Invalid or duplicate Codeforces target',
          code: 'validation',
        });
        continue;
      }
    }

    // Re-check entrypoint against external existingAnswersAbsPath now that it is known.
    if (!normalized.synth_problems && rawEntrypoint && typeof rawEntrypoint.path === 'string' && existingAnswersAbsPath) {
      const candidatePdfPath = isAbsolute(rawEntrypoint.path)
        ? rawEntrypoint.path
        : resolve(dirname(confined.absPath), rawEntrypoint.path);
      const pdfConfined = await resolveConfinedPath(baseResolved, candidatePdfPath);
      if (pdfConfined.absPath === existingAnswersAbsPath) {
        errors.push({
          index: i,
          id: contestId,
          path: ['document', 'materials', 'entrypoint', 'path'],
          message: `Contest judge answers file cannot be exposed as contest material: ${pdfConfined.relPath}`,
          code: 'path_error',
        });
        continue;
      }
    }

    // Confine and validate EVERY materials.attachments[] entry (O_NOFOLLOW, size limits, duplicates, sha256, forbidden files).
    let attachmentsFailed = false;
    const attachmentNames = new Set<string>();
    let totalAttachmentBytes = 0;
    const attachmentHashes: Array<[string, string]> = [];
    const effectiveJudgeAbsPath = judgeAbsPath ?? existingAnswersAbsPath;

    for (let aIdx = 0; aIdx < parsedContest.materials.attachments.length; aIdx++) {
      const att = parsedContest.materials.attachments[aIdx]!;
      const fieldPath = ['document', 'materials', 'attachments', String(aIdx)];
      if (attachmentNames.has(att.name)) {
        errors.push({
          index: i,
          id: contestId,
          path: [...fieldPath, 'name'],
          message: `Duplicate attachment name: ${att.name}`,
          code: 'validation',
        });
        attachmentsFailed = true;
        break;
      }
      attachmentNames.add(att.name);

      const attCandidate = isAbsolute(att.path) ? att.path : resolve(dirname(confined.absPath), att.path);
      try {
        const attConfined = await resolveConfinedPath(baseResolved, attCandidate, [...fieldPath, 'path']);
        assertNotForbiddenMaterialPath(
          attConfined.absPath,
          attConfined.relPath,
          protectedDirs,
          effectiveJudgeAbsPath,
          [...fieldPath, 'path'],
        );
        const attFile = await readConfinedRegularFile(baseReal, attConfined.absPath, [...fieldPath, 'path'], MAX_ATTACHMENT_BYTES);
        totalAttachmentBytes += attFile.bytes.length;
        if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
          throw new FieldError(['document', 'materials', 'attachments'], 'Attachments exceed 32 MB');
        }
        const attHash = sha256(attFile.bytes);
        if (att.sha256 && att.sha256 !== attHash) {
          throw new FieldError([...fieldPath, 'sha256'], `Attachment SHA-256 mismatch: ${attConfined.relPath}`);
        }
        referencedInputs.add(attConfined.absPath);
        attachmentHashes.push([att.name, attHash]);
      } catch (error) {
        errors.push({
          index: i,
          id: contestId,
          path: error instanceof FieldError ? error.path : [...fieldPath, 'path'],
          message: error instanceof Error ? error.message : 'Invalid attachment file',
          code: error instanceof FieldError && error.path.includes('path') ? 'path_error' : 'validation',
        });
        attachmentsFailed = true;
        break;
      }
    }
    if (attachmentsFailed) continue;

    // Handle pre-existing manifest and auxiliary (.pdf / .judge.json) files for error, skip, and overwrite!
    const anyExists = manifestExists || judgeExists || synthPdfExists;
    let action: 'create' | 'skip' | 'overwrite' = 'create';
    let manifestBackup: Buffer | undefined;
    let manifestBackupMode: number | undefined;
    let judgeBackup: Buffer | undefined;
    let judgeBackupMode: number | undefined;
    let synthPdfBackup: Buffer | undefined;
    let synthPdfBackupMode: number | undefined;

    if (anyExists) {
      if (ifExists === 'error') {
        const existingRel = manifestExists
          ? confined.relPath
          : judgeExists
            ? judgeRelPath!
            : synthPdfRelPath!;
        const conflictPath = manifestExists ? ['file'] : judgeExists ? ['judge'] : ['materials'];
        errors.push({
          index: i,
          id: contestId,
          path: conflictPath,
          message: `Contest output file already exists: ${existingRel}`,
          code: 'conflict',
        });
        continue;
      }
      if (ifExists === 'skip') {
        action = 'skip';
      } else {
        // ifExists === 'overwrite': verify identity of EVERY pre-existing target file before overwriting!
        try {
          if (manifestExists) {
            const prev = await readExistingForOverwriteCheck(baseReal, confined.absPath, confined.relPath, 'contest', ['file']);
            manifestBackup = prev.backup;
            manifestBackupMode = prev.mode;
          }
          if (judgeExists && judgeAbsPath && judgeRelPath) {
            const prev = await readExistingForOverwriteCheck(baseReal, judgeAbsPath, judgeRelPath, 'judge', ['judge']);
            judgeBackup = prev.backup;
            judgeBackupMode = prev.mode;
          }
          if (synthPdfExists && synthPdfAbsPath && synthPdfRelPath) {
            const prev = await readExistingForOverwriteCheck(baseReal, synthPdfAbsPath, synthPdfRelPath, 'pdf', ['materials']);
            synthPdfBackup = prev.backup;
            synthPdfBackupMode = prev.mode;
          }
          action = manifestExists ? 'overwrite' : 'create';
        } catch (error) {
          errors.push({
            index: i,
            id: contestId,
            path: error instanceof FieldError ? error.path : ['file'],
            message: error instanceof Error ? error.message : 'Refusing to overwrite unrelated existing file',
            code: 'conflict',
          });
          continue;
        }
      }
    }

    // Compute planned contestRevision matching resolveContest.
    const cf = parsedContest.judge.kind === 'codeforces' ? parsedContest.judge : undefined;
    const judgeDefinition =
      parsedContest.judge.kind === 'local'
        ? { kind: 'local', sha256: finalJudgeHash }
        : {
            kind: parsedContest.judge.kind,
            contest_id: parsedContest.judge.contest_id,
            problem_map: finalProblems!.map(p => [p.id, Object.hasOwn(cf?.problem_map ?? {}, p.id) ? cf!.problem_map![p.id] : p.id]),
            languages: Object.entries(parsedContest.judge.languages).sort(([a], [b]) => a.localeCompare(b)),
          };
    const plannedRevision = sha256(
      JSON.stringify({
        materials: [entrypointHash, ...attachmentHashes],
        problems: finalProblems,
        rules: parsedContest.rules,
        judge: judgeDefinition,
      }),
    );

    planned.push({
      contest_id: contestId,
      absPath: confined.absPath,
      relPath: confined.relPath,
      action,
      manifestExists,
      manifestBackup,
      manifestBackupMode,
      manifestDraft,
      plannedRevision,
      judgeJsonBytes,
      judgeAbsPath,
      judgeRelPath,
      judgeExists,
      judgeBackup,
      judgeBackupMode,
      synthPdfBytes,
      synthPdfAbsPath,
      synthPdfRelPath,
      synthPdfExists,
      synthPdfBackup,
      synthPdfBackupMode,
      pdfInfo,
      inferredProblemMap,
      outputPaths: itemOutputs,
    });
  }

  // Reject any output path colliding with any referenced input path in the same batch.
  for (const item of planned) {
    for (const out of item.outputPaths) {
      if (referencedInputs.has(out.absPath)) {
        errors.push({
          id: item.contest_id,
          path: ['file'],
          message: `Target output path collides with a referenced input file in the same batch: ${out.relPath}`,
          code: 'conflict',
        });
      }
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      dry_run: dryRun,
      created: 0,
      skipped: 0,
      overwritten: 0,
      items: [],
      errors,
    };
  }

  let created = 0;
  let skipped = 0;
  let overwritten = 0;
  const results: BatchContestItemResult[] = [];
  const rollbackLog: RollbackEntry[] = [];

  try {
    for (const item of planned) {
      if (item.action === 'skip') {
        skipped++;
        results.push({
          contest_id: item.contest_id,
          path: item.relPath,
          ...(item.judgeRelPath ? { judge_path: item.judgeRelPath } : {}),
          ...(item.synthPdfRelPath ? { pdf_path: item.synthPdfRelPath } : {}),
          action: 'skip',
          ...(item.pdfInfo ? { pdf_info: item.pdfInfo } : {}),
          ...(item.inferredProblemMap ? { inferred_problem_map: item.inferredProblemMap } : {}),
        });
        continue;
      }

      let revision: string | undefined = dryRun ? item.plannedRevision : undefined;

      if (!dryRun) {
        await ensureConfinedParentDir(baseReal, item.absPath);

        if (item.synthPdfBytes && item.synthPdfAbsPath) {
          await atomicWriteFile(item.synthPdfAbsPath, item.synthPdfBytes, item.synthPdfExists, 0o600);
          rollbackLog.push({
            path: item.synthPdfAbsPath,
            existed: item.synthPdfExists,
            backup: item.synthPdfBackup,
            mode: item.synthPdfBackupMode,
          });
        }

        if (item.judgeJsonBytes && item.judgeAbsPath) {
          await atomicWriteFile(item.judgeAbsPath, item.judgeJsonBytes, item.judgeExists, 0o600);
          rollbackLog.push({
            path: item.judgeAbsPath,
            existed: item.judgeExists,
            backup: item.judgeBackup,
            mode: item.judgeBackupMode,
          });
        }

        let resolved;
        try {
          resolved = await resolveContest(item.manifestDraft, item.absPath);
        } catch (error) {
          // Sanitize any unexpected private judge parse error.
          const msg = error instanceof Error ? error.message : 'Contest validation failed';
          if (msg.includes('Invalid JSON') && item.manifestDraft.judge && (item.manifestDraft.judge as { kind?: string }).kind === 'local') {
            throw new Error('Local answers file is not valid JSON');
          }
          throw error;
        }
        const { statement: _statement, ...finalDocument } = resolved.contest;
        revision = resolved.contestRevision;
        await atomicWriteFile(item.absPath, JSON.stringify(finalDocument, null, 2) + '\n', item.manifestExists, 0o600);
        rollbackLog.push({
          path: item.absPath,
          existed: item.manifestExists,
          backup: item.manifestBackup,
          mode: item.manifestBackupMode,
        });
      }

      if (item.action === 'create') created++;
      else overwritten++;

      results.push({
        contest_id: item.contest_id,
        path: item.relPath,
        ...(item.judgeRelPath ? { judge_path: item.judgeRelPath } : {}),
        ...(item.synthPdfRelPath ? { pdf_path: item.synthPdfRelPath } : {}),
        action: item.action,
        ...(revision ? { revision } : {}),
        ...(item.pdfInfo ? { pdf_info: item.pdfInfo } : {}),
        ...(item.inferredProblemMap ? { inferred_problem_map: item.inferredProblemMap } : {}),
      });
    }
  } catch (error) {
    await rollbackWrites(rollbackLog);
    throw error;
  }

  return {
    ok: true,
    dry_run: dryRun,
    created,
    skipped,
    overwritten,
    items: results,
    errors: [],
  };
}
