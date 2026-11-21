import { lstat, mkdir, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { agentKind, FieldError, manifestProvider, nativeConfigSchema } from './agent-manifest.js';
import { persistAgentManifest } from './author.js';
import { agentCatalog, contestCatalog, evaluateMatrix } from './catalog.js';
import {
  agentDigests,
  file,
  id as identifierSchema,
  modelKey,
  resolveAgentManifest,
  resolveLoadedAgent,
  revisionFor,
  sha256,
  type AgentExternalFileReader,
} from './config.js';
import { connectionId, ConnectionError, createConnectionSchema, endpoint, patchConnectionSchema, rotateConnectionSchema, type Connections } from './connections.js';
import {
  assertAgentDocument,
  assertContestDocument,
  createContestDocument,
  existingWorkspaceFile,
  FORBIDDEN_WORKSPACE_DIRS,
  isForbiddenWorkspaceRelPath,
  isReservedNonManifestFilename,
  loadStudioContest,
  outputPath,
  readWorkspaceFileNoFollow,
  resolveRealPathOrAncestor,
  resolveStudioContestFromParsed,
  updateContestDocument,
  verifyManagedMaterialFile,
  verifyManagedMaterialsRoot,
  withWorkspaceLock,
} from './contest-author.js';
import { imageFor, inspectImage } from './docker.js';
import { efforts, harnessCapabilities, serviceTierSchema, speedTierSchema } from './harnesses.js';
import {
  createOjAccountSchema,
  defaultOriginFor,
  effectiveOriginFor,
  inferProblemMap,
  languagePresetsFor,
  listJudgeBackends,
  OjAccountError,
  ojAccountId,
  ojAccountResponseSchema,
  OjAccounts,
  ojAccountsResponseSchema,
  ojPlatformSchema,
  patchOjAccountSchema,
  previewContest as defaultPreviewContest,
  rotateOjAccountSchema,
  type OjAccount,
  type OjPlatform,
} from './judges/index.js';
import { uploadMaterial } from './materials.js';
import { checkPdfLimits, inspectPdf } from './pdf-synth.js';
import { assertCompatible, assertHarnessProtocolCompatible, checkOjReadiness } from './plan.js';
import { protocolDigest, protocolPresetNames, protocolPresets, resolveProtocolPreset, resolveScoringMode } from './protocol.js';
import { listBatches } from './queue.js';
import { documentFormat, formatSchema, parseDocumentText, serializeDocument } from './serialization.js';
import {
  capabilitiesSchema,
  effectiveConfigSchema,
  preflightReportSchema,
  providerResponseSchema,
  providersResponseSchema,
} from './studio-contract.js';

const agentRequest = z.strictObject({
  document: z.unknown(),
  format: formatSchema.optional(),
  file: z.string().min(1).max(4096).optional(),
  native_config: nativeConfigSchema.optional(),
});

const agentUpdateRequest = z.strictObject({
  path: z.string().min(1).max(4096),
  document: z.unknown(),
  format: formatSchema.optional(),
  native_config: nativeConfigSchema.optional(),
});

const agentCloneRequest = z.strictObject({
  source_path: z.string().min(1).max(4096),
  id: connectionId,
  name: z.string().trim().min(1).max(120).optional(),
  file: z.string().min(1).max(4096).optional(),
  format: formatSchema.optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
});

const agentVariantsRequest = z.strictObject({
  base_document: z.record(z.string(), z.unknown()),
  reasoning_efforts: z.array(z.enum(['default', ...efforts])).min(1).max(16).optional(),
  speed_tiers: z.array(speedTierSchema).min(1).max(8).optional(),
  service_tiers: z.array(serviceTierSchema).min(1).max(8).optional(),
  format: formatSchema.optional(),
  directory: z.string().min(1).max(256).optional(),
  dry_run: z.boolean().default(false),
});

const contestPreviewRequest = z.strictObject({
  platform: ojPlatformSchema,
  contest_id: z.union([z.number().int().positive(), z.string().trim().min(1).max(128)]),
  gym: z.boolean().optional(),
  base_url: endpoint.optional(),
  domain: z.string().trim().min(1).max(128).optional(),
  account_id: ojAccountId.optional(),
  local_problems: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  pdf_path: z.string().min(1).max(4096).optional(),
});

const preflightRequest = z.strictObject({
  agents: z.array(z.string().min(1).max(4096)).max(100).optional(),
  contests: z.array(z.string().min(1).max(4096)).max(100).optional(),
  cells: z.array(z.strictObject({
    agent: z.string().min(1).max(4096),
    contest: z.string().min(1).max(4096),
  })).max(1000).optional(),
});

const materialDeleteRequest = z.strictObject({
  path: z.string().min(1).max(4096).optional(),
  cleanup_orphans: z.boolean().optional(),
}).refine(v => Boolean(v.path) !== Boolean(v.cleanup_orphans), 'Specify either path or cleanup_orphans');

const capabilities = capabilitiesSchema.parse({
  schema_version: 1,
  features: {
    agent_vendor: true,
    agent_manifests: true,
    connections: true,
    native_overrides: true,
    contest_authoring: true,
    contest_upload: true,
    judge_authoring: true,
    oj_accounts: true,
    push_targets: true,
    live_progress: true,
    replay: true,
    preflight_doctor: true,
    variant_builder: true,
    parallel_batches: true,
  },
  manifest_formats: formatSchema.options,
  harnesses: harnessCapabilities(),
  judge_backends: [
    { kind: 'local', label: '本地精确答案', supports_authoring: true },
    ...listJudgeBackends().map(backend => ({
      kind: backend.kind,
      label: backend.label,
      supports_authoring: true,
      default_settlement_ms: backend.default_settlement_ms,
      supports_partial_score: backend.supports_partial_score,
      requires_base_url: backend.requires_base_url,
      ...(backend.supports_gym !== undefined ? { supports_gym: backend.supports_gym } : {}),
      ...(backend.supports_mixed_upstream !== undefined ? { supports_mixed_upstream: backend.supports_mixed_upstream } : {}),
      language_presets: languagePresetsFor(backend.kind),
    })),
  ],
  protocol_presets: protocolPresetNames.map(id => {
    const preset = protocolPresets[id];
    return {
      id,
      max_turns: preset.maxTurns,
      request_timeout_ms: preset.requestTimeoutMs,
      pdf_max_pages: preset.pdfMaxPages,
      pdf_max_bytes: preset.pdfMaxBytes,
      settlement_ms: preset.settlementMs,
    };
  }),
});

export function configError(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 400,
      error: 'Invalid configuration',
      issues: error.issues.map(issue => ({
        path: issue.path.map(String),
        code: issue.code,
        message: safeIssue(issue.code),
      })),
    };
  }
  if (error instanceof FieldError) {
    return {
      status: error.status,
      error: error.message,
      issues: [{ path: error.path, code: 'invalid_field', message: error.message }],
    };
  }
  if (error instanceof ConnectionError) return { status: error.status, error: error.message, issues: [] };
  if (error instanceof OjAccountError) return { status: error.status, error: error.message, issues: [] };
  if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
    return { status: 409, error: 'Output already exists', issues: [{ path: ['file'], code: 'conflict', message: 'Output already exists' }] };
  }
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return { status: 404, error: 'Resource not found', issues: [] };
  }
  return { status: 400, error: error instanceof Error ? error.message : 'Could not process configuration', issues: [] };
}
const ZodError = z.ZodError;
const safeIssue = (code: string) => code === 'unrecognized_keys' ? 'Contains unsupported fields' : 'Invalid or missing value';

const MANAGED_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANAGED_ASSET_EXT = /^\.[A-Za-z0-9]{1,12}$/;

function isWithinOrEqual(candidate: string, boundary: string): boolean {
  const rel = relative(boundary, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sanitizeStudioIssue(
  error: unknown,
  sensitivePaths: readonly (string | undefined)[],
  fallback = 'Invalid configuration',
): string {
  const raw = error instanceof Error ? error.message : fallback;
  let cleaned = raw;
  const uniquePaths = [...new Set(sensitivePaths.filter((p): p is string => Boolean(p)))].sort((a, b) => b.length - a.length);
  for (const p of uniquePaths) {
    if (cleaned.includes(p)) {
      cleaned = cleaned.replaceAll(p, '<workspace>');
    }
  }
  // Redact any remaining absolute Unix/Windows host paths while preserving http(s):// URLs.
  cleaned = cleaned.replace(/(^|[\s'"(=])(?:\/[^\s'"(),;]+|[A-Za-z]:\\[^\s'"(),;]+)/g, '$1<path>');
  return cleaned;
}

function makeStudioExternalReader(
  base: string,
  root: string,
  target: string,
  fieldName: string,
): AgentExternalFileReader {
  return async (refPath, expectedSha256, limit) => {
    if (!refPath || refPath.includes('\0')) {
      throw new FieldError([fieldName], 'Referenced file path is invalid');
    }
    const realBase = await realpath(base);
    const candidate = isAbsolute(refPath) ? resolve(refPath) : resolve(dirname(target), refPath);
    const relFromBase = relative(realBase, candidate);
    if (!relFromBase || relFromBase === '..' || relFromBase.startsWith(`..${sep}`) || isAbsolute(relFromBase)) {
      throw new FieldError([fieldName], 'Referenced file must be inside the Studio workspace');
    }
    const verified = await existingWorkspaceFile(base, relFromBase, fieldName, root);
    const bytes = await readWorkspaceFileNoFollow(verified, limit, fieldName);
    if (expectedSha256 && sha256(bytes) !== expectedSha256) {
      throw new FieldError([fieldName], 'Referenced file SHA-256 mismatch');
    }
    return bytes;
  };
}

async function readStudioAgentFile(base: string, root: string, relPath: string, fieldName = 'path') {
  const target = await existingWorkspaceFile(base, relPath, fieldName, root);
  let format;
  try { format = documentFormat(target); } catch { throw new FieldError([fieldName], 'Unsupported Agent manifest extension'); }
  const bytes = await readWorkspaceFileNoFollow(target, 1_000_000, fieldName);
  const parsed = parseDocumentText(bytes.toString('utf8'), format);
  assertAgentDocument(target, parsed, fieldName);
  return { target, format, bytes, parsed };
}

async function loadStudioAgent(base: string, root: string, relPath: string, store: Connections, fieldName = 'path') {
  const { target, format, bytes, parsed } = await readStudioAgentFile(base, root, relPath, fieldName);
  const loaded = await resolveLoadedAgent(
    parsed,
    bytes,
    target,
    store,
    makeStudioExternalReader(base, root, target, fieldName),
  );
  return { target, format, parsed, loaded };
}

async function scanWorkspaceConfigFiles(base: string, root: string, extensions: RegExp, limitError: () => Error) {
  const realBase = await realpath(base);
  const realExcludedRoot = await resolveRealPathOrAncestor(root);
  const found: string[] = [];
  const dirs = [realBase];
  let scanned = 0;
  while (dirs.length) {
    const dir = dirs.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++scanned > 10000) throw limitError();
      if (entry.name.startsWith('.') || FORBIDDEN_WORKSPACE_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      if (isForbiddenWorkspaceRelPath(relative(realBase, fullPath))) continue;
      if (isWithinOrEqual(fullPath, realExcludedRoot)) continue;
      if (entry.isDirectory()) { dirs.push(fullPath); continue; }
      if (!entry.isFile() || !extensions.test(entry.name)) continue;
      found.push(fullPath);
    }
  }
  return found;
}

async function workspaceReferences(base: string, root: string, id: string) {
  const files = await scanWorkspaceConfigFiles(
    base,
    root,
    /\.(toml|yaml|yml|json)$/i,
    () => new ConnectionError('Workspace too large to verify connection references', 409),
  );
  for (const path of files) {
    const raw = await file(path, 1_000_000).then(bytes => parseDocumentText(bytes.toString('utf8'), documentFormat(path))).catch(() => undefined);
    if (
      raw &&
      typeof raw === 'object' &&
      'kind' in raw &&
      raw.kind === agentKind &&
      (('provider' in raw && raw.provider === id) || ('connection' in raw && raw.connection === id))
    ) {
      return true;
    }
  }
  return false;
}

function judgeOriginFor(judge: Record<string, unknown>, platform: OjPlatform): string | undefined {
  if (typeof judge.base_url === 'string' && judge.base_url.trim()) {
    try {
      return new URL(judge.base_url.trim()).origin;
    } catch {
      return undefined;
    }
  }
  return defaultOriginFor(platform);
}

function contestJudgeReferencesAccount(
  judgeRaw: unknown,
  target: OjAccount,
  allAccounts: readonly OjAccount[],
  isActiveJob: boolean,
): boolean {
  if (!judgeRaw || typeof judgeRaw !== 'object' || Array.isArray(judgeRaw)) return false;
  const judge = judgeRaw as Record<string, unknown>;
  if (judge.account_id === target.id) return true;
  if (judge.kind !== target.platform) return false;
  const platform = target.platform;
  const targetOrigin = effectiveOriginFor(target);
  const contestOrigin = judgeOriginFor(judge, platform);
  const originMatches = !contestOrigin || !targetOrigin || targetOrigin === contestOrigin;
  if (!originMatches) return false;

  if (typeof judge.pool === 'string' && !judge.account_id) {
    if (target.pool !== judge.pool) return false;
    if (typeof judge.handle === 'string' && target.handle.toLowerCase() !== judge.handle.trim().toLowerCase()) return false;
    if (isActiveJob) return true;
    // Block deleting the last ready account serving a referenced pool.
    const hasReplacement = allAccounts.some(acc =>
      acc.id !== target.id &&
      acc.platform === platform &&
      acc.pool === judge.pool &&
      (typeof judge.handle !== 'string' || acc.handle.toLowerCase() === judge.handle.trim().toLowerCase()) &&
      acc.ready &&
      (!contestOrigin || effectiveOriginFor(acc) === contestOrigin),
    );
    return !hasReplacement;
  }

  if (typeof judge.handle === 'string' && !judge.account_id && !judge.pool) {
    return target.handle.toLowerCase() === judge.handle.trim().toLowerCase();
  }

  // Platform-default selection (no account_id/pool/handle):
  // - Active/queued jobs may lease any matching account.
  // - Saved workspace contests (QOJ/VJudge/Hydro) block deleting the last ready account matching (platform, contestOrigin).
  if (!judge.account_id && !judge.pool && !judge.handle) {
    if (isActiveJob) return true;
    const hasReplacement = allAccounts.some(acc =>
      acc.id !== target.id &&
      acc.platform === platform &&
      acc.ready &&
      (!contestOrigin || effectiveOriginFor(acc) === contestOrigin),
    );
    return !hasReplacement;
  }
  return false;
}

async function workspaceOjAccountReferences(base: string, root: string, ojAccounts: OjAccounts, id: string) {
  const target = await ojAccounts.get(id);
  const allAccounts = await ojAccounts.list();

  // 1. Check all workspace contest manifests
  const files = await scanWorkspaceConfigFiles(
    base,
    root,
    /\.json$/i,
    () => new OjAccountError('Workspace too large to verify OJ account references', 409),
  );
  for (const path of files) {
    const raw = await readWorkspaceFileNoFollow(path, 1_000_000)
      .then(bytes => JSON.parse(bytes.toString('utf8')) as unknown)
      .catch(() => undefined);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    if (!('contest_id' in obj) || 'run_id' in obj || !('judge' in obj)) continue;
    if (contestJudgeReferencesAccount(obj.judge, target, allAccounts, false)) return true;
  }

  // 2. Check all active (running) and queued batch jobs (both active run.json AND contest_path)
  const batches = await listBatches(root);
  const checkedContestPaths = new Map<string, boolean>();
  for (const batch of batches) {
    for (let i = 0; i < batch.jobs.length; i++) {
      const job = batch.jobs[i];
      const status = job?.status;
      if (status !== 'running' && status !== 'queued') continue;

      // Inspect active run.json so editing contest.json on disk mid-run cannot hide an in-use account.
      if (status === 'running' && job?.run_id) {
        const runJsonPath = join(root, job.run_id, 'run.json');
        let runMetaRaw: unknown;
        let runJsonExists = true;
        try {
          const bytes = await readWorkspaceFileNoFollow(runJsonPath, 1_000_000);
          runMetaRaw = JSON.parse(bytes.toString('utf8')) as unknown;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            runJsonExists = false;
          } else {
            // Fail closed if an active run.json exists but cannot be read/parsed.
            return true;
          }
        }
        if (runJsonExists) {
          if (!runMetaRaw || typeof runMetaRaw !== 'object' || Array.isArray(runMetaRaw)) {
            return true;
          }
          const runMeta = runMetaRaw as Record<string, unknown>;
          if (runMeta.oj_account_id === target.id) return true;
          if (runMeta.judge_selector && contestJudgeReferencesAccount(runMeta.judge_selector, target, allAccounts, true)) {
            return true;
          }
          if (!runMeta.judge_selector && runMeta.judge_kind === target.platform) {
            return true;
          }
        }
      }

      const contestPath = batch.plan.jobs[i]?.contest_path;
      if (!contestPath) continue;
      let referenced = checkedContestPaths.get(contestPath);
      if (referenced === undefined) {
        try {
          const raw = JSON.parse((await file(contestPath, 1_000_000)).toString('utf8')) as unknown;
          const judge = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).judge : undefined;
          referenced = contestJudgeReferencesAccount(judge, target, allAccounts, true);
        } catch {
          // Fail closed when an active/queued job's contest cannot be inspected.
          referenced = true;
        }
        checkedContestPaths.set(contestPath, referenced);
      }
      if (referenced) return true;
    }
  }
  return false;
}

async function pruneEmptyDirs(dir: string, stopAt: string) {
  let current = resolve(dir);
  const boundary = resolve(stopAt);
  while (current !== boundary && current.startsWith(boundary + sep)) {
    try {
      await rmdir(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') break;
      throw error;
    }
    current = dirname(current);
  }
}

async function collectReferencedManagedMaterials(
  base: string,
  root: string,
  realMaterialsRoot: string,
  fieldName: string,
): Promise<Set<string>> {
  const referenced = new Set<string>();

  const collectFromRawContest = async (contestFile: string, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    if (!('contest_id' in obj) || 'run_id' in obj) return;

    const candidates: string[] = [];
    // v1 contest manifest: statement.path
    if (obj.statement && typeof obj.statement === 'object' && !Array.isArray(obj.statement)) {
      const stPath = (obj.statement as { path?: unknown }).path;
      if (typeof stPath === 'string') candidates.push(stPath);
    }
    // v2 contest manifest: materials.entrypoint.path & materials.attachments[].path
    if (obj.materials && typeof obj.materials === 'object' && !Array.isArray(obj.materials)) {
      const matRec = obj.materials as { entrypoint?: { path?: unknown }; attachments?: Array<{ path?: unknown }> };
      if (typeof matRec.entrypoint?.path === 'string') candidates.push(matRec.entrypoint.path);
      if (Array.isArray(matRec.attachments)) {
        for (const att of matRec.attachments) {
          if (typeof att?.path === 'string') candidates.push(att.path);
        }
      }
    }
    for (const rel of candidates) {
      if (rel.startsWith('managed/')) {
        const parts = rel.split('/');
        if (parts.length === 4) {
          const direct = join(realMaterialsRoot, parts[1]!, parts[2]!, parts[3]!);
          const real = await realpath(direct).catch(() => undefined);
          if (real && isWithinOrEqual(real, realMaterialsRoot) && real !== realMaterialsRoot) {
            referenced.add(real);
          }
        }
        continue;
      }
      const resolved = resolve(dirname(contestFile), rel);
      const real = await realpath(resolved).catch(() => undefined);
      if (real && isWithinOrEqual(real, realMaterialsRoot) && real !== realMaterialsRoot) {
        referenced.add(real);
      }
    }
  };

  // 1. Scan all workspace JSON files
  const files = await scanWorkspaceConfigFiles(
    base,
    root,
    /\.json$/i,
    () => new FieldError([fieldName], 'Workspace too large to scan material references', 409),
  );
  for (const contestFile of files) {
    let bytes: Buffer;
    try {
      bytes = await readWorkspaceFileNoFollow(contestFile, 1_000_000, fieldName);
    } catch {
      throw new FieldError([fieldName], 'Could not read workspace JSON while scanning material references', 409);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new FieldError([fieldName], 'Could not parse workspace JSON while scanning material references', 409);
    }
    await collectFromRawContest(contestFile, raw);
  }

  // 2. Also inspect contest_path for all running and queued batch jobs (fail closed with 409 on read/parse error)
  let batches;
  try {
    batches = await listBatches(root);
  } catch {
    throw new FieldError([fieldName], 'Could not inspect active batches while scanning material references', 409);
  }
  const checkedBatchContests = new Set<string>();
  for (const batch of batches) {
    for (let i = 0; i < batch.jobs.length; i++) {
      const status = batch.jobs[i]?.status;
      if (status !== 'running' && status !== 'queued') continue;
      const contestPath = batch.plan.jobs[i]?.contest_path;
      if (!contestPath || checkedBatchContests.has(contestPath)) continue;
      checkedBatchContests.add(contestPath);
      let bytes: Buffer;
      try {
        bytes = await readWorkspaceFileNoFollow(contestPath, 1_000_000, fieldName);
      } catch {
        throw new FieldError([fieldName], 'Could not read active batch contest while scanning material references', 409);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new FieldError([fieldName], 'Could not parse active batch contest while scanning material references', 409);
      }
      await collectFromRawContest(contestPath, raw);
    }
  }
  return referenced;
}

async function deleteManagedMaterial(root: string, base: string, ref: string): Promise<string[]> {
  const { fullPath, realMaterials } = await verifyManagedMaterialFile(root, ref, undefined, 'path');
  const referenced = await collectReferencedManagedMaterials(base, root, realMaterials, 'path');
  if (referenced.has(fullPath)) {
    throw new FieldError(['path'], 'Material is referenced by a Contest manifest', 409);
  }
  await rm(fullPath);
  await pruneEmptyDirs(dirname(fullPath), realMaterials);
  return [ref];
}

async function cleanupOrphanMaterials(root: string, base: string): Promise<string[]> {
  const realMaterialsRoot = await verifyManagedMaterialsRoot(root);
  if (!realMaterialsRoot) return [];

  // Scan ALL workspace manifests first; any scan/read/parse failure aborts cleanup with 0 deletions.
  const referenced = await collectReferencedManagedMaterials(base, root, realMaterialsRoot, 'cleanup_orphans');

  // Only inspect and delete recognized managed upload files in .materials/<contestId>/(entrypoint|attachment)/<assetName>.
  const deleted: string[] = [];
  const contestEntries = await readdir(realMaterialsRoot, { withFileTypes: true });
  for (const contestEntry of contestEntries) {
    if (contestEntry.name.startsWith('.') || !identifierSchema.safeParse(contestEntry.name).success) continue;
    const contestDir = join(realMaterialsRoot, contestEntry.name);
    const contestInfo = await lstat(contestDir).catch(() => undefined);
    if (!contestInfo || contestInfo.isSymbolicLink() || !contestInfo.isDirectory()) continue;

    const kindEntries = await readdir(contestDir, { withFileTypes: true }).catch(() => []);
    for (const kindEntry of kindEntries) {
      if (kindEntry.name !== 'entrypoint' && kindEntry.name !== 'attachment') continue;
      const kindDir = join(contestDir, kindEntry.name);
      const kindInfo = await lstat(kindDir).catch(() => undefined);
      if (!kindInfo || kindInfo.isSymbolicLink() || !kindInfo.isDirectory()) continue;

      const fileEntries = await readdir(kindDir, { withFileTypes: true }).catch(() => []);
      for (const fileEntry of fileEntries) {
        if (
          fileEntry.name.startsWith('.') ||
          !MANAGED_ASSET_NAME.test(fileEntry.name) ||
          !MANAGED_ASSET_EXT.test(extname(fileEntry.name))
        ) {
          continue;
        }
        const fullPath = join(kindDir, fileEntry.name);
        const fileInfo = await lstat(fullPath).catch(() => undefined);
        if (!fileInfo || fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
        const real = await realpath(fullPath).catch(() => undefined);
        if (!real || !isWithinOrEqual(real, realMaterialsRoot) || real === realMaterialsRoot) continue;
        if (!referenced.has(real)) {
          await rm(fullPath);
          deleted.push(`managed/${contestEntry.name}/${kindEntry.name}/${fileEntry.name}`);
        }
      }
      await pruneEmptyDirs(kindDir, realMaterialsRoot);
    }
    await pruneEmptyDirs(contestDir, realMaterialsRoot);
  }
  return deleted.sort();
}

interface CookieRedactionRules {
  exact: string[];
  wordBoundary: string[];
}

function extractCookieSecrets(cookie: string | undefined): CookieRedactionRules {
  const exact = new Set<string>();
  const wordBoundary = new Set<string>();
  if (!cookie) return { exact: [], wordBoundary: [] };
  const trimmed = cookie.trim();
  if (trimmed.length >= 2) exact.add(trimmed);
  else if (trimmed.length === 1) wordBoundary.add(trimmed);
  for (const rawPart of trimmed.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.length >= 2) exact.add(part);
    else wordBoundary.add(part);
    const eq = part.indexOf('=');
    if (eq >= 0) {
      const val = part.slice(eq + 1).trim();
      if (val.length >= 2) exact.add(val);
      else if (val.length === 1) wordBoundary.add(val);
    }
  }
  return {
    exact: [...exact].sort((a, b) => b.length - a.length),
    wordBoundary: [...wordBoundary],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSecretText(text: string, rules: CookieRedactionRules): string {
  let out = text;
  for (const secret of rules.exact) {
    if (secret && out.includes(secret)) {
      out = out.replaceAll(secret, '[REDACTED]');
    }
  }
  for (const token of rules.wordBoundary) {
    if (!token) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}(?=$|[^A-Za-z0-9_])`, 'g');
    out = out.replace(re, '$1[REDACTED]');
  }
  return out;
}

function redactSecretsDeep<T>(value: T, rules: CookieRedactionRules): T {
  if (!rules.exact.length && !rules.wordBoundary.length) return value;
  if (typeof value === 'string') return redactSecretText(value, rules) as T;
  if (Array.isArray(value)) return value.map(item => redactSecretsDeep(item, rules)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecretsDeep(v, rules);
    }
    return out as T;
  }
  return value;
}

async function validateVariantDirectory(base: string, root: string, dirRel: string): Promise<string> {
  if (!dirRel || dirRel.includes('\0') || isAbsolute(dirRel)) {
    throw new FieldError(['directory'], 'Variant directory must be a relative path inside the Studio workspace');
  }
  const realBase = await realpath(base);
  const realExcludedRoot = await resolveRealPathOrAncestor(root);
  const candidate = resolve(realBase, dirRel);
  const relDir = relative(realBase, candidate);
  if (relDir === '..' || relDir.startsWith(`..${sep}`) || isAbsolute(relDir) || isForbiddenWorkspaceRelPath(relDir)) {
    throw new FieldError(['directory'], 'Variant directory must be inside the Studio workspace');
  }
  const parts = relDir ? relDir.split(sep) : [];
  if (isWithinOrEqual(candidate, realExcludedRoot)) {
    throw new FieldError(['directory'], 'Variant directory cannot be inside the configured run root');
  }
  // Verify no existing prefix along the directory path is a symlink or non-directory BEFORE mkdir.
  let cursor = realBase;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new FieldError(['directory'], 'Variant directory traverses a symlink or non-directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') break;
      throw error;
    }
  }
  return candidate;
}

function mergeCloneDocument(source: Record<string, unknown>, id: string, name?: string, overrides?: Record<string, unknown>) {
  const cloned: Record<string, unknown> = structuredClone(source);
  cloned.id = id;
  if (name !== undefined) cloned.name = name;
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'harness' && value && typeof value === 'object' && !Array.isArray(value) && cloned.harness && typeof cloned.harness === 'object') {
        const prevHarness = cloned.harness as Record<string, unknown>;
        const nextHarness = { ...prevHarness, ...(value as Record<string, unknown>) };
        if (
          'options' in value &&
          value.options &&
          typeof value.options === 'object' &&
          !Array.isArray(value.options) &&
          prevHarness.options &&
          typeof prevHarness.options === 'object'
        ) {
          nextHarness.options = { ...(prevHarness.options as Record<string, unknown>), ...(value.options as Record<string, unknown>) };
        }
        cloned.harness = nextHarness;
      } else {
        cloned[key] = value;
      }
    }
  }
  return cloned;
}

export type StudioConfigOptions = {
  root: string;
  base: string;
  store: Connections;
  ojAccounts?: OjAccounts;
  signal: AbortSignal;
  getImage?: typeof inspectImage;
  previewContest?: typeof defaultPreviewContest;
};

export function isConfigRoute(path: string) {
  return /^\/api\/(?:capabilities|agents|providers|connections|contests|catalog|matrix|oj-accounts|preflight)(?:\/|$)/.test(path);
}

async function resolveAgentForWrite(
  raw: Record<string, unknown>,
  target: string,
  base: string,
  root: string,
  format: z.infer<typeof formatSchema> | undefined,
  nativeConfig: z.infer<typeof nativeConfigSchema> | undefined,
  store: Connections,
  getImage: typeof inspectImage,
  validating: boolean,
  hasFile: boolean,
) {
  if (nativeConfig) {
    const h = z.record(z.string(), z.unknown()).parse(raw.harness);
    if (h.native_config) throw new FieldError(['harness', 'native_config'], 'Only one native override may be supplied');
    raw.harness = { ...h, native_config: nativeConfig };
  }
  const override = raw.harness && typeof raw.harness === 'object' && 'native_config' in raw.harness
    ? nativeConfigSchema.safeParse(raw.harness.native_config).data : undefined;
  if (!hasFile && override && 'path' in override) {
    throw new FieldError(['file'], 'Manifest path is required to resolve an external override');
  }
  const agent = await resolveAgentManifest(
    raw,
    target,
    store,
    makeStudioExternalReader(base, root, target, 'harness.native_config.path'),
  );
  const { profileDigest, nativeDigest, effectiveDigest } = agentDigests(agent.profile, agent.native, agent.nativeText, agent.env);
  const warnings: string[] = [];
  const image = validating ? undefined : await getImage(imageFor(agent.profile.harness)).catch(() => {
    warnings.push('Harness image unavailable; the exact run revision will be computed when planning');
    return undefined;
  });
  const revision = image ? revisionFor(agent.profile, effectiveDigest, image, protocolDigest) : undefined;
  const manifest = agent.manifest;
  const serialized = format ? serializeDocument(manifest, format) : undefined;
  const digests = {
    source_sha256: serialized === undefined ? undefined : sha256(serialized),
    profile_sha256: profileDigest,
    native_sha256: nativeDigest,
    effective_sha256: effectiveDigest,
  };
  return { agent, manifest, serialized, revision, digests, warnings };
}

export async function configRoute(path: string, req: IncomingMessage, opts: StudioConfigOptions, body: () => Promise<unknown>) {
  const { root, base, store, signal } = opts;
  const ojAccounts = opts.ojAccounts ?? new OjAccounts();
  const getImage = opts.getImage ?? inspectImage;
  const previewFn = opts.previewContest ?? defaultPreviewContest;
  const method = req.method;
  const url = new URL(req.url ?? path, 'http://127.0.0.1');

  if (method === 'GET' && path === '/api/capabilities') return { data: capabilities };
  if (method === 'GET' && path === '/api/catalog/agents') return { data: { agents: await agentCatalog(base, store) } };
  if (method === 'GET' && path === '/api/catalog/contests') return { data: { contests: await contestCatalog(base) } };
  if (method === 'POST' && path === '/api/matrix') return { data: await evaluateMatrix(await body(), base, store) };

  // Providers / legacy Connections CRUD
  const match = path.match(/^\/api\/(providers|connections)(?:\/([^/]+)(\/rotate)?)?$/);
  if (match) {
    const modern = match[1] === 'providers';
    const describe = async (value: Awaited<ReturnType<Connections['get']>>) => modern
      ? providerResponseSchema.parse(await store.provider(value.id)) : value;
    if (!match[2]) {
      if (method === 'GET') return { data: modern ? providersResponseSchema.parse({ providers: await store.listProviders() }) : { connections: await store.list() } };
      if (modern && method === 'POST') return { status: 201, data: await describe(await store.create(createConnectionSchema.parse(await body()))) };
    } else {
      const id = connectionId.parse(match[2]);
      if (match[3]) {
        if (modern && method === 'POST') return { data: await describe(await store.rotate(id, rotateConnectionSchema.parse(await body()).secret)) };
      } else {
        if (method === 'PATCH') return { data: await describe(await store.patch(id, patchConnectionSchema.parse(await body()))) };
        if (method === 'DELETE') {
          await store.remove(id, key => workspaceReferences(base, root, key));
          return { data: { deleted: true } };
        }
      }
    }
  }

  // OJ Accounts CRUD (write-only secrets; never echoed)
  const ojMatch = path.match(/^\/api\/oj-accounts(?:\/([^/]+)(\/rotate)?)?$/);
  if (ojMatch) {
    if (!ojMatch[1]) {
      if (method === 'GET') return { data: ojAccountsResponseSchema.parse({ accounts: await ojAccounts.list() }) };
      if (method === 'POST') {
        const created = await ojAccounts.create(createOjAccountSchema.parse(await body()));
        return { status: 201, data: ojAccountResponseSchema.parse(created) };
      }
    } else {
      const id = ojAccountId.parse(ojMatch[1]);
      if (ojMatch[2]) {
        if (method === 'POST') {
          const rotated = await ojAccounts.rotate(id, rotateOjAccountSchema.parse(await body()));
          return { data: ojAccountResponseSchema.parse(rotated) };
        }
      } else {
        if (method === 'PATCH') {
          const updated = await ojAccounts.patch(id, patchOjAccountSchema.parse(await body()));
          return { data: ojAccountResponseSchema.parse(updated) };
        }
        if (method === 'DELETE') {
          await ojAccounts.remove(id, key => workspaceOjAccountReferences(base, root, ojAccounts, key));
          return { data: { deleted: true } };
        }
      }
    }
  }

  // Agent item read / update / delete
  if (path === '/api/agents/item') {
    if (method === 'GET') {
      const relPath = url.searchParams.get('path');
      if (!relPath) throw new FieldError(['path'], 'Query parameter path is required');
      const { target, format, bytes, parsed } = await readStudioAgentFile(base, root, relPath, 'path');
      const realBase = await realpath(base);
      const realRoot = await resolveRealPathOrAncestor(root);
      const loaded = await resolveLoadedAgent(
        parsed,
        bytes,
        target,
        store,
        makeStudioExternalReader(base, root, target, 'path'),
      ).then(value => ({ value }), error => ({ error }));
      return {
        data: {
          path: relative(realBase, target),
          format,
          document: parsed,
          valid: 'value' in loaded,
          issues: 'error' in loaded ? [sanitizeStudioIssue(loaded.error, [target, realBase, base, realRoot, root], 'Invalid Agent')] : [],
          ...('value' in loaded ? {
            id: loaded.value.agent.agent_id,
            ...(loaded.value.agentName ? { name: loaded.value.agentName } : {}),
            model: loaded.value.profile.model,
            ...(loaded.value.vendor ? { vendor: loaded.value.vendor } : {}),
            harness: loaded.value.profile.harness,
            ...(loaded.value.connection ? { provider: loaded.value.connection } : {}),
            speed_tier: loaded.value.speedTier,
            digests: {
              source_sha256: loaded.value.agentDigest,
              profile_sha256: loaded.value.profileDigest,
              native_sha256: loaded.value.nativeDigest,
              effective_sha256: loaded.value.effectiveDigest,
            },
          } : {}),
        },
      };
    }
    if (method === 'PUT') {
      const input = agentUpdateRequest.parse(await body());
      const { target, format: detected } = await readStudioAgentFile(base, root, input.path, 'path');
      const format = input.format ?? detected;
      if (detected !== format) throw new FieldError(['format'], 'File extension does not match selected manifest format');
      const raw = z.record(z.string(), z.unknown()).parse(input.document);
      const resolved = await resolveAgentForWrite(raw, target, base, root, format, input.native_config, store, getImage, false, true);
      await persistAgentManifest(target, manifestProvider(resolved.manifest), resolved.serialized!, store, true);
      const realBase = await realpath(base);
      return {
        data: {
          path: relative(realBase, target),
          format,
          manifest: resolved.manifest,
          revision: resolved.revision,
          digests: resolved.digests,
          warnings: resolved.warnings,
        },
      };
    }
    if (method === 'DELETE') {
      const relPath = url.searchParams.get('path');
      if (!relPath) throw new FieldError(['path'], 'Query parameter path is required');
      const { target } = await readStudioAgentFile(base, root, relPath, 'path');
      const realBase = await realpath(base);
      await store.unregisterAndDelete(target, () => rm(target));
      return { data: { deleted: true, path: relative(realBase, target) } };
    }
  }

  // Clone Agent
  if (method === 'POST' && path === '/api/agents/clone') {
    const input = agentCloneRequest.parse(await body());
    const { format: sourceFormat, parsed } = await readStudioAgentFile(base, root, input.source_path, 'source_path');
    const sourceDoc = z.record(z.string(), z.unknown()).parse(parsed);
    const clonedDoc = mergeCloneDocument(sourceDoc, input.id, input.name, input.overrides);
    const format = input.format ?? (input.file ? (() => {
      try { return documentFormat(input.file); } catch { throw new FieldError(['file'], 'Unsupported manifest extension'); }
    })() : sourceFormat);
    const fileRel = input.file ?? `agents/${input.id}.${format}`;
    if (!input.file) await mkdir(join(base, 'agents'), { recursive: true });
    const target = await outputPath(base, fileRel, root);
    let detected;
    try { detected = documentFormat(target); } catch { throw new FieldError(['file'], 'Unsupported manifest extension'); }
    if (detected !== format) throw new FieldError(['file'], 'File extension does not match selected manifest format');
    const resolved = await resolveAgentForWrite(clonedDoc, target, base, root, format, undefined, store, getImage, false, true);
    await persistAgentManifest(target, manifestProvider(resolved.manifest), resolved.serialized!, store, false);
    return {
      status: 201,
      data: {
        path: target,
        format,
        manifest: resolved.manifest,
        revision: resolved.revision,
        digests: resolved.digests,
        warnings: resolved.warnings,
      },
    };
  }

  // Variant Matrix Builder
  if (method === 'POST' && path === '/api/agents/variants') {
    const input = agentVariantsRequest.parse(await body());
    const baseId = connectionId.parse(input.base_document.id);
    const baseName = typeof input.base_document.name === 'string' && input.base_document.name.trim()
      ? input.base_document.name.trim() : undefined;
    const format = input.format ?? 'toml';
    const dirRel = input.directory ?? 'agents';
    const effortValues = input.reasoning_efforts ?? [undefined];
    const speedValues = input.speed_tiers ?? [undefined];
    const serviceValues = input.service_tiers ?? [undefined];

    const totalCount = effortValues.length * speedValues.length * serviceValues.length;
    if (totalCount > 64) throw new FieldError(['base_document'], 'Variant matrix exceeds maximum of 64 variants');

    // Validate variant directory confinement and symlinks BEFORE any mkdir!
    const validatedDir = await validateVariantDirectory(base, root, dirRel);
    if (!input.dry_run) {
      await mkdir(validatedDir, { recursive: true });
    }
    const realBase = await realpath(base);
    const realExcludedRoot = await resolveRealPathOrAncestor(root);
    const baseDirResolved = input.dry_run ? validatedDir : await realpath(validatedDir);
    const relDir = relative(realBase, baseDirResolved);
    if (
      relDir === '..' ||
      relDir.startsWith(`..${sep}`) ||
      isAbsolute(relDir) ||
      relDir.split(sep).some(p => p.startsWith('.')) ||
      isWithinOrEqual(baseDirResolved, realExcludedRoot)
    ) {
      throw new FieldError(['directory'], 'Variant directory must be inside the Studio workspace');
    }

    const prepared: Array<{
      id: string;
      path: string;
      format: z.infer<typeof formatSchema>;
      manifest: Awaited<ReturnType<typeof resolveAgentForWrite>>['manifest'];
      serialized: string;
      revision?: string;
      digests: Awaited<ReturnType<typeof resolveAgentForWrite>>['digests'];
      warnings: string[];
    }> = [];
    const seenIds = new Set<string>();

    for (const effort of effortValues) {
      for (const speed of speedValues) {
        for (const service of serviceValues) {
          const slugParts = [baseId];
          const labelParts = [baseName ?? baseId];
          if (effort !== undefined && effort !== 'default') { slugParts.push(effort); labelParts.push(effort); }
          if (speed !== undefined && speed !== 'standard') { slugParts.push(speed); labelParts.push(speed); }
          else if (speed !== undefined && input.speed_tiers && input.speed_tiers.length > 1) { slugParts.push(speed); labelParts.push(speed); }
          if (service !== undefined && service !== 'default') { slugParts.push(service); labelParts.push(service); }
          const variantId = connectionId.parse(slugParts.join('-'));
          if (seenIds.has(variantId)) continue;
          seenIds.add(variantId);

          const doc: Record<string, unknown> = structuredClone(input.base_document);
          doc.id = variantId;
          if (labelParts.length > 1 || baseName) doc.name = labelParts.join(' / ');
          if (speed !== undefined) doc.speed_tier = speed;
          if (doc.harness && typeof doc.harness === 'object' && !Array.isArray(doc.harness)) {
            const h = { ...(doc.harness as Record<string, unknown>) };
            const optsObj = h.options && typeof h.options === 'object' && !Array.isArray(h.options)
              ? { ...(h.options as Record<string, unknown>) } : {};
            if (effort !== undefined) {
              if (effort === 'default') delete optsObj.reasoning_effort;
              else optsObj.reasoning_effort = effort;
            }
            if (service !== undefined) {
              if (service === 'default') delete optsObj.service_tier;
              else optsObj.service_tier = service;
            }
            h.options = optsObj;
            doc.harness = h;
          }

          const target = input.dry_run
            ? resolve(baseDirResolved, `${variantId}.${format}`)
            : await outputPath(base, join(dirRel, `${variantId}.${format}`), root);
          if (isReservedNonManifestFilename(target)) {
            throw new FieldError(['base_document', 'id'], 'Output filename is reserved');
          }
          const resolved = await resolveAgentForWrite(doc, target, base, root, format, undefined, store, getImage, false, true);
          prepared.push({
            id: variantId,
            path: target,
            format,
            manifest: resolved.manifest,
            serialized: resolved.serialized!,
            revision: resolved.revision,
            digests: resolved.digests,
            warnings: resolved.warnings,
          });
        }
      }
    }

    if (input.dry_run) {
      return {
        data: {
          dry_run: true,
          variants: prepared.map(({ serialized: _s, ...item }) => item),
        },
      };
    }

    const writtenPaths: string[] = [];
    try {
      for (const item of prepared) {
        await persistAgentManifest(item.path, manifestProvider(item.manifest), item.serialized, store, false);
        writtenPaths.push(item.path);
      }
    } catch (error) {
      for (const p of writtenPaths) {
        await store.unregisterAndDelete(p, () => rm(p, { force: true })).catch(() => {});
      }
      throw error;
    }

    return {
      status: 201,
      data: {
        dry_run: false,
        variants: prepared.map(({ serialized: _s, ...item }) => item),
      },
    };
  }

  // Agent create / preview / validate (existing)
  if (method === 'POST' && ['/api/agents', '/api/agents/preview', '/api/agents/validate'].includes(path)) {
    const input = agentRequest.parse(await body());
    const saving = path === '/api/agents';
    const validating = path.endsWith('/validate');
    const raw = z.record(z.string(), z.unknown()).parse(input.document);
    const managed = saving && !input.file;
    if (managed) { connectionId.parse(raw.id); await mkdir(join(base, 'agents'), { recursive: true }); }
    const fileRef = input.file ?? (managed ? `agents/${String(raw.id)}.toml` : undefined);
    const format = input.format ?? (managed ? 'toml' as const : undefined);
    if (saving && (!fileRef || !format)) throw new FieldError(['file'], 'File and manifest format are required');
    const target = fileRef ? await outputPath(base, fileRef, root) : resolve(base, 'agent.toml');
    if (fileRef) {
      let detected;
      try { detected = documentFormat(target); } catch { throw new FieldError(['file'], 'Unsupported manifest extension'); }
      if (format && detected !== format) throw new FieldError(['file'], 'File extension does not match selected manifest format');
    }
    const { agent, manifest, serialized, revision, digests, warnings } = await resolveAgentForWrite(
      raw,
      target,
      base,
      root,
      format,
      input.native_config,
      store,
      getImage,
      validating,
      Boolean(fileRef),
    );
    if (saving) {
      await persistAgentManifest(target, manifestProvider(manifest), serialized!, store, false);
      return { status: 201, data: { path: target, format, manifest, revision, digests, warnings } };
    }
    if (validating) return { data: { valid: true, issues: [], warnings, manifest, digests } };
    // Preview only the validated override semantics, not arbitrary file comments.
    const native = manifest.harness.native_config;
    const normalized = native && 'content' in native
      ? {
          ...manifest,
          harness: {
            ...manifest.harness,
            native_config: { ...native, content: serializeDocument(agent.native ?? {}, native.format) },
          },
        }
      : manifest;
    return {
      data: effectiveConfigSchema.parse({
        content: agent.effective.content,
        format: agent.effective.format,
        manifest: normalized,
        connection: agent.connection,
        revision,
        digests,
        warnings,
        env: agent.env,
        rejected_overrides: [],
      }),
    };
  }

  // Contest item read / update / delete
  if (path === '/api/contests/item') {
    if (method === 'GET') {
      const relPath = url.searchParams.get('path');
      if (!relPath) throw new FieldError(['path'], 'Query parameter path is required');
      const target = await existingWorkspaceFile(base, relPath, 'path', root);
      if (extname(target) !== '.json') throw new FieldError(['path'], 'Contest manifest must end in .json');
      const bytes = await readWorkspaceFileNoFollow(target);
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); }
      catch { throw new FieldError(['path'], 'Invalid contest JSON'); }
      assertContestDocument(target, parsed, 'path');
      const realBase = await realpath(base);
      const realRoot = await resolveRealPathOrAncestor(root);
      const loaded = await resolveStudioContestFromParsed(root, base, target, parsed, 'path')
        .then(value => ({ value }), error => ({ error }));
      const includeLocalJudge =
        'value' in loaded &&
        loaded.value.contest.judge.kind === 'local' &&
        (url.searchParams.get('include_judge') === '1' || req.headers['x-cr-studio'] === '1');
      return {
        data: {
          path: relative(realBase, target),
          document: parsed,
          valid: 'value' in loaded,
          issues: 'error' in loaded ? [sanitizeStudioIssue(loaded.error, [target, realBase, base, realRoot, root], 'Invalid Contest')] : [],
          ...('value' in loaded ? {
            contest_id: loaded.value.contest.contest_id,
            contest_revision: loaded.value.contestRevision,
            judge_kind: loaded.value.contest.judge.kind,
            protocol_preset: resolveProtocolPreset(loaded.value.contest.rules),
            scoring_mode: resolveScoringMode(loaded.value.contest.rules),
          } : {}),
          ...(includeLocalJudge ? { judge: loaded.value.judge } : {}),
        },
      };
    }
    if (method === 'PUT') {
      return { data: await updateContestDocument(root, base, await body(), signal) };
    }
    if (method === 'DELETE') {
      const relPath = url.searchParams.get('path');
      if (!relPath) throw new FieldError(['path'], 'Query parameter path is required');
      return withWorkspaceLock(base, root, async () => {
        const target = await existingWorkspaceFile(base, relPath, 'path', root);
        if (extname(target) !== '.json') throw new FieldError(['path'], 'Contest manifest must end in .json');
        const bytes = await readWorkspaceFileNoFollow(target);
        let parsed: unknown;
        try { parsed = JSON.parse(bytes.toString('utf8')); }
        catch { throw new FieldError(['path'], 'Target file is not a valid Contest manifest'); }
        assertContestDocument(target, parsed, 'path');
        const realBase = await realpath(base);
        await rm(target);
        return { data: { deleted: true, path: relative(realBase, target) } };
      });
    }
  }

  // Contest materials upload / delete / orphan cleanup
  if (path === '/api/contests/materials') {
    if (method === 'POST') return { status: 201, data: await uploadMaterial(root, req) };
    if (method === 'DELETE') {
      let rawInput: unknown;
      if (req.headers['content-type']?.split(';')[0] === 'application/json') {
        rawInput = await body();
      } else {
        const qPath = url.searchParams.get('path') ?? undefined;
        const qOrphans = url.searchParams.get('cleanup_orphans');
        rawInput = {
          ...(qPath ? { path: qPath } : {}),
          ...(qOrphans === '1' || qOrphans === 'true' ? { cleanup_orphans: true } : {}),
        };
      }
      const parsed = materialDeleteRequest.parse(rawInput);
      const deleted = await withWorkspaceLock(base, root, () =>
        parsed.path
          ? deleteManagedMaterial(root, base, parsed.path)
          : cleanupOrphanMaterials(root, base),
      );
      return { data: { deleted, count: deleted.length } };
    }
  }

  // Contest preview + auto problem_map suggestion
  if (method === 'POST' && path === '/api/contests/preview') {
    const input = contestPreviewRequest.parse(await body());
    let cookie: string | undefined;
    if (input.account_id) {
      const targetOrigin = input.base_url ? new URL(input.base_url).origin : defaultOriginFor(input.platform);
      if (!targetOrigin) throw new FieldError(['base_url'], `${input.platform} preview requires base_url`);
      const acc = await ojAccounts.get(input.account_id);
      if (acc.transport === 'cookie') {
        cookie = await ojAccounts.resolveSecret(input.account_id, { platform: input.platform, origin: targetOrigin });
      }
    }
    const cookieSecrets = extractCookieSecrets(cookie);
    let rawPreview: Awaited<ReturnType<typeof defaultPreviewContest>>;
    try {
      rawPreview = await previewFn(input.platform, input.contest_id, {
        gym: input.gym,
        baseUrl: input.base_url,
        domain: input.domain,
        cookie,
        signal,
      });
    } catch (error) {
      if (cookie !== undefined) {
        throw new FieldError(
          ['contest_id'],
          'Contest preview failed; verify the contest reference and OJ account credentials',
          400,
        );
      }
      throw error;
    }
    const preview = redactSecretsDeep(rawPreview, cookieSecrets);
    let pdfInfo: Awaited<ReturnType<typeof inspectPdf>> | undefined;
    if (input.pdf_path) {
      let pdfFile: string;
      if (input.pdf_path.startsWith('managed/')) {
        const managed = await verifyManagedMaterialFile(root, input.pdf_path, undefined, 'pdf_path');
        pdfFile = managed.fullPath;
      } else {
        pdfFile = await existingWorkspaceFile(base, input.pdf_path, 'pdf_path', root);
      }
      pdfInfo = await inspectPdf(pdfFile);
    }
    const localProblems = input.local_problems ?? pdfInfo?.problem_ids ?? [];
    const problemMapSuggestion = localProblems.length > 0
      ? redactSecretsDeep(inferProblemMap(localProblems, preview.problems), cookieSecrets)
      : undefined;
    return {
      data: {
        preview,
        language_presets: languagePresetsFor(input.platform),
        ...(problemMapSuggestion ? { problem_map_suggestion: problemMapSuggestion } : {}),
        ...(pdfInfo ? { pdf_info: { ...pdfInfo, path: input.pdf_path! } } : {}),
      },
    };
  }

  if (method === 'POST' && path === '/api/contests') {
    return { status: 201, data: await createContestDocument(root, base, await body(), signal) };
  }

  // Preflight Doctor
  if (method === 'POST' && path === '/api/preflight') {
    const input = preflightRequest.parse(await body());
    if (!input.agents?.length && !input.contests?.length && !input.cells?.length) {
      throw new FieldError(['agents'], 'Select at least one agent, contest, or cell to run preflight', 400);
    }
    const realBase = await realpath(base);
    const realRoot = await resolveRealPathOrAncestor(root);
    const baseSensitive = [realBase, base, realRoot, root];
    const agentPaths = new Set<string>(input.agents ?? []);
    const contestPaths = new Set<string>(input.contests ?? []);
    const cellPairs: Array<{ agent: string; contest: string }> = [];

    if (input.cells?.length) {
      for (const cell of input.cells) {
        agentPaths.add(cell.agent);
        contestPaths.add(cell.contest);
        cellPairs.push(cell);
      }
    } else {
      for (const a of agentPaths) {
        for (const c of contestPaths) cellPairs.push({ agent: a, contest: c });
      }
    }

    const loadedAgents = new Map<string, Awaited<ReturnType<typeof resolveLoadedAgent>>>();
    const requiredHarnesses = new Set<'codex' | 'builtin-responses'>();
    const agentChecks: z.infer<typeof preflightReportSchema>['agents'] = [];

    for (const relPath of agentPaths) {
      const issues: string[] = [];
      let agentId: string | undefined;
      let harnessKindVal: string | undefined;
      let credentialOk = false;
      let resolvedPath: string | undefined;
      try {
        const result = await loadStudioAgent(base, root, relPath, store, 'agents');
        resolvedPath = result.target;
        const loaded = result.loaded;
        loadedAgents.set(relPath, loaded);
        agentId = loaded.agent.agent_id;
        harnessKindVal = loaded.profile.harness;
        requiredHarnesses.add(loaded.profile.harness);
        try {
          assertHarnessProtocolCompatible(loaded.profile);
        } catch (err) {
          issues.push(sanitizeStudioIssue(err, [...baseSensitive, resolvedPath], 'Incompatible harness protocol'));
        }
        try {
          await modelKey(loaded, store);
          credentialOk = true;
        } catch (err) {
          issues.push(sanitizeStudioIssue(err, [...baseSensitive, resolvedPath], 'Model credential unavailable'));
        }
      } catch (err) {
        issues.push(sanitizeStudioIssue(err, [...baseSensitive, ...(resolvedPath ? [resolvedPath] : [])], 'Could not load Agent'));
      }
      agentChecks.push({
        path: relPath,
        ...(agentId ? { id: agentId } : {}),
        ...(harnessKindVal ? { harness: harnessKindVal } : {}),
        ok: issues.length === 0,
        credential_ok: credentialOk,
        issues,
      });
    }

    const imageChecks: z.infer<typeof preflightReportSchema>['images'] = [];
    for (const h of requiredHarnesses) {
      const img = imageFor(h);
      try {
        const digest = await getImage(img);
        imageChecks.push({ harness: h, image: img, ok: true, digest });
      } catch (err) {
        imageChecks.push({
          harness: h,
          image: img,
          ok: false,
          error: sanitizeStudioIssue(err, baseSensitive, 'Docker image unavailable'),
        });
      }
    }

    const loadedContests = new Map<string, Awaited<ReturnType<typeof loadStudioContest>>>();
    const contestChecks: z.infer<typeof preflightReportSchema>['contests'] = [];

    for (const relPath of contestPaths) {
      const issues: string[] = [];
      let contestId: string | undefined;
      let judgeKind: string | undefined;
      let presetName: z.infer<typeof preflightReportSchema>['contests'][number]['protocol_preset'];
      let ojReady = true;
      let pdfCheck: z.infer<typeof preflightReportSchema>['contests'][number]['pdf'];
      let resolvedPath: string | undefined;
      try {
        const loaded = await loadStudioContest(root, base, relPath, 'contests');
        resolvedPath = loaded.target;
        loadedContests.set(relPath, loaded);
        contestId = loaded.contest.contest_id;
        judgeKind = loaded.contest.judge.kind;
        presetName = resolveProtocolPreset(loaded.contest.rules);
        const preset = protocolPresets[presetName];

        try {
          const pdfInfo = await inspectPdf(loaded.pdfPath);
          const limits = checkPdfLimits(pdfInfo, { maxPages: preset.pdfMaxPages, maxBytes: preset.pdfMaxBytes });
          const cleanPdfIssues = limits.issues.map(msg =>
            sanitizeStudioIssue(new Error(msg), [...baseSensitive, resolvedPath, loaded.pdfPath], 'PDF limit exceeded'),
          );
          pdfCheck = {
            page_count: pdfInfo.page_count,
            size_bytes: pdfInfo.size_bytes,
            ok: limits.ok,
            issues: cleanPdfIssues,
          };
          if (!limits.ok) issues.push(...cleanPdfIssues);
        } catch (err) {
          const msg = sanitizeStudioIssue(err, [...baseSensitive, resolvedPath, loaded.pdfPath], 'PDF inspection failed');
          pdfCheck = { page_count: 0, size_bytes: 0, ok: false, issues: [msg] };
          issues.push(msg);
        }

        if (loaded.contest.judge.kind !== 'local') {
          try {
            await checkOjReadiness(loaded.contest.judge, ojAccounts);
          } catch (err) {
            ojReady = false;
            issues.push(sanitizeStudioIssue(err, [...baseSensitive, resolvedPath], 'OJ account not ready'));
          }
        }
      } catch (err) {
        ojReady = false;
        issues.push(sanitizeStudioIssue(err, [...baseSensitive, ...(resolvedPath ? [resolvedPath] : [])], 'Could not load Contest'));
      }
      contestChecks.push({
        path: relPath,
        ...(contestId ? { id: contestId } : {}),
        ...(judgeKind ? { judge_kind: judgeKind } : {}),
        ...(presetName ? { protocol_preset: presetName } : {}),
        ok: issues.length === 0,
        oj_ready: ojReady,
        ...(pdfCheck ? { pdf: pdfCheck } : {}),
        issues,
      });
    }

    const compatibilityChecks: z.infer<typeof preflightReportSchema>['compatibility'] = [];
    for (const pair of cellPairs) {
      const a = loadedAgents.get(pair.agent);
      const c = loadedContests.get(pair.contest);
      if (!a || !c) {
        compatibilityChecks.push({
          agent: pair.agent,
          contest: pair.contest,
          compatible: false,
          reason: !a ? 'Agent failed to load' : 'Contest failed to load',
        });
        continue;
      }
      try {
        assertCompatible(a.profile.harness, c.contest, a.agent.agent_id);
        compatibilityChecks.push({ agent: pair.agent, contest: pair.contest, compatible: true });
      } catch (err) {
        compatibilityChecks.push({
          agent: pair.agent,
          contest: pair.contest,
          compatible: false,
          reason: sanitizeStudioIssue(err, baseSensitive, 'Incompatible cell'),
        });
      }
    }

    const ok =
      imageChecks.every(i => i.ok) &&
      agentChecks.every(a => a.ok) &&
      contestChecks.every(c => c.ok) &&
      compatibilityChecks.every(c => c.compatible);

    return {
      data: preflightReportSchema.parse({
        ok,
        checked_at: new Date().toISOString(),
        images: imageChecks,
        agents: agentChecks,
        contests: contestChecks,
        compatibility: compatibilityChecks,
      }),
    };
  }

  return { status: 404, data: { error: 'Not found', issues: [] } };
}
