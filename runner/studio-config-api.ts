import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { agentKind, FieldError, manifestProvider, nativeConfigSchema } from './agent-manifest.js';
import { persistAgentManifest } from './author.js';
import { agentCatalog, contestCatalog, evaluateMatrix } from './catalog.js';
import { agentDigests, file, id as identifierSchema, loadAgent, loadContest, modelKey, resolveAgentManifest, revisionFor, sha256 } from './config.js';
import { connectionId, ConnectionError, createConnectionSchema, endpoint, patchConnectionSchema, rotateConnectionSchema, type Connections } from './connections.js';
import { createContestDocument, existingWorkspaceFile, outputPath, readWorkspaceFileNoFollow, updateContestDocument } from './contest-author.js';
import { imageFor, inspectImage } from './docker.js';
import { efforts, harnessCapabilities, serviceTierSchema, speedTierSchema } from './harnesses.js';
import {
  createOjAccountSchema,
  defaultOriginFor,
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
} from './judges/index.js';
import { managedMaterial, uploadMaterial } from './materials.js';
import { checkPdfLimits, inspectPdf } from './pdf-synth.js';
import { assertCompatible, checkOjReadiness } from './plan.js';
import { protocolDigest, protocolPresetNames, protocolPresets, resolveProtocolPreset, resolveScoringMode } from './protocol.js';
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

async function scanWorkspaceConfigFiles(base: string, extensions: RegExp, limitError: () => Error) {
  const found: string[] = [];
  const dirs = [base];
  let scanned = 0;
  while (dirs.length) {
    for (const entry of await readdir(dirs.pop()!, { withFileTypes: true })) {
      if (++scanned > 10000) throw limitError();
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'coverage', 'runs'].includes(entry.name)) continue;
      const fullPath = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) { dirs.push(fullPath); continue; }
      if (!entry.isFile() || !extensions.test(entry.name)) continue;
      found.push(fullPath);
    }
  }
  return found;
}

async function workspaceReferences(base: string, id: string) {
  const files = await scanWorkspaceConfigFiles(
    base,
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

async function workspaceOjAccountReferences(base: string, id: string) {
  const files = await scanWorkspaceConfigFiles(
    base,
    /\.json$/i,
    () => new OjAccountError('Workspace too large to verify OJ account references', 409),
  );
  for (const path of files) {
    const raw = await file(path, 1_000_000).then(bytes => JSON.parse(bytes.toString('utf8')) as unknown).catch(() => undefined);
    if (
      raw &&
      typeof raw === 'object' &&
      'contest_id' in raw &&
      'judge' in raw &&
      raw.judge &&
      typeof raw.judge === 'object' &&
      'account_id' in raw.judge &&
      raw.judge.account_id === id
    ) {
      return true;
    }
  }
  return false;
}

function parseManagedMaterialRef(root: string, ref: string): { contestId: string; kind: 'entrypoint' | 'attachment'; filename: string; fullPath: string } {
  const parts = ref.split('/');
  if (parts.length !== 4 || parts[0] !== 'managed') {
    throw new FieldError(['path'], 'Material path must use managed/<contest_id>/<kind>/<filename>');
  }
  const contestId = identifierSchema.parse(parts[1]);
  const kind = z.enum(['entrypoint', 'attachment']).parse(parts[2]);
  const fullPath = managedMaterial(root, ref, contestId, kind);
  if (!fullPath) throw new FieldError(['path'], 'Invalid managed material reference');
  return { contestId, kind, filename: parts[3]!, fullPath };
}

async function pruneEmptyDirs(dir: string, stopAt: string) {
  let current = dir;
  const boundary = resolve(stopAt);
  while (resolve(current) !== boundary && resolve(current).startsWith(boundary + sep)) {
    const entries = await readdir(current).catch(() => []);
    if (entries.length > 0) break;
    await rm(current, { recursive: false, force: false }).catch(() => {});
    current = dirname(current);
  }
}

async function deleteManagedMaterial(root: string, ref: string): Promise<string[]> {
  const materialsRoot = join(root, '.materials');
  const { fullPath } = parseManagedMaterialRef(root, ref);
  let info;
  try {
    info = await lstat(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new FieldError(['path'], 'Material not found', 404);
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new FieldError(['path'], 'Material target is not a regular file');
  }
  const realRoot = await realpath(materialsRoot);
  const realTarget = await realpath(fullPath);
  const within = relative(realRoot, realTarget);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new FieldError(['path'], 'Material escapes managed materials directory');
  }
  await rm(fullPath);
  await pruneEmptyDirs(dirname(fullPath), materialsRoot);
  return [ref];
}

async function cleanupOrphanMaterials(root: string, base: string): Promise<string[]> {
  const materialsRoot = join(root, '.materials');
  let realMaterialsRoot: string;
  try {
    realMaterialsRoot = await realpath(materialsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }

  const referenced = new Set<string>();
  const files = await scanWorkspaceConfigFiles(
    base,
    /\.json$/i,
    () => new FieldError(['cleanup_orphans'], 'Workspace too large to scan material references', 409),
  );
  for (const contestFile of files) {
    const raw = await file(contestFile, 1_000_000).then(b => JSON.parse(b.toString('utf8')) as unknown).catch(() => undefined);
    if (!raw || typeof raw !== 'object' || !('contest_id' in raw) || !('materials' in raw)) continue;
    const materials = (raw as { materials?: unknown }).materials;
    if (!materials || typeof materials !== 'object') continue;
    const matRec = materials as { entrypoint?: { path?: unknown }; attachments?: Array<{ path?: unknown }> };
    const candidates: string[] = [];
    if (typeof matRec.entrypoint?.path === 'string') candidates.push(matRec.entrypoint.path);
    if (Array.isArray(matRec.attachments)) {
      for (const att of matRec.attachments) {
        if (typeof att?.path === 'string') candidates.push(att.path);
      }
    }
    for (const rel of candidates) {
      const resolved = resolve(dirname(contestFile), rel);
      const real = await realpath(resolved).catch(() => undefined);
      if (real && (real === realMaterialsRoot || real.startsWith(realMaterialsRoot + sep))) {
        referenced.add(real);
      }
    }
  }

  const deleted: string[] = [];
  const walk = async (dir: string, relParts: string[]): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      const info = await lstat(fullPath).catch(() => undefined);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(fullPath, [...relParts, entry.name]);
        await pruneEmptyDirs(fullPath, materialsRoot);
      } else if (info.isFile()) {
        const real = await realpath(fullPath).catch(() => undefined);
        if (real && !referenced.has(real)) {
          await rm(fullPath);
          deleted.push(`managed/${[...relParts, entry.name].join('/')}`);
        }
      }
    }
  };
  await walk(materialsRoot, []);
  return deleted.sort();
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
  const agent = await resolveAgentManifest(raw, target, store);
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
          await store.remove(id, key => workspaceReferences(base, key));
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
          await ojAccounts.remove(id, key => workspaceOjAccountReferences(base, key));
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
      const target = await existingWorkspaceFile(base, relPath, 'path');
      let format;
      try { format = documentFormat(target); } catch { throw new FieldError(['path'], 'Unsupported Agent manifest extension'); }
      const bytes = await readWorkspaceFileNoFollow(target);
      const parsed = parseDocumentText(bytes.toString('utf8'), format);
      const loaded = await loadAgent(target, store).then(value => ({ value }), error => ({ error }));
      const realBase = await realpath(base);
      return {
        data: {
          path: relative(realBase, target),
          format,
          document: parsed,
          valid: 'value' in loaded,
          issues: 'error' in loaded ? [loaded.error instanceof Error ? loaded.error.message : 'Invalid Agent'] : [],
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
      const target = await existingWorkspaceFile(base, input.path, 'path');
      let detected;
      try { detected = documentFormat(target); } catch { throw new FieldError(['path'], 'Unsupported manifest extension'); }
      const format = input.format ?? detected;
      if (detected !== format) throw new FieldError(['format'], 'File extension does not match selected manifest format');
      const raw = z.record(z.string(), z.unknown()).parse(input.document);
      const resolved = await resolveAgentForWrite(raw, target, format, input.native_config, store, getImage, false, true);
      await persistAgentManifest(target, manifestProvider(resolved.manifest), resolved.serialized!, store, true);
      return {
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
    if (method === 'DELETE') {
      const relPath = url.searchParams.get('path');
      if (!relPath) throw new FieldError(['path'], 'Query parameter path is required');
      const target = await existingWorkspaceFile(base, relPath, 'path');
      try { documentFormat(target); } catch { throw new FieldError(['path'], 'Target is not a supported Agent manifest'); }
      const realBase = await realpath(base);
      await rm(target);
      return { data: { deleted: true, path: relative(realBase, target) } };
    }
  }

  // Clone Agent
  if (method === 'POST' && path === '/api/agents/clone') {
    const input = agentCloneRequest.parse(await body());
    const sourceTarget = await existingWorkspaceFile(base, input.source_path, 'source_path');
    let sourceFormat;
    try { sourceFormat = documentFormat(sourceTarget); } catch { throw new FieldError(['source_path'], 'Unsupported Agent manifest extension'); }
    const bytes = await readWorkspaceFileNoFollow(sourceTarget);
    const parsed = parseDocumentText(bytes.toString('utf8'), sourceFormat);
    const sourceDoc = z.record(z.string(), z.unknown()).parse(parsed);
    const clonedDoc = mergeCloneDocument(sourceDoc, input.id, input.name, input.overrides);
    const format = input.format ?? (input.file ? (() => {
      try { return documentFormat(input.file); } catch { throw new FieldError(['file'], 'Unsupported manifest extension'); }
    })() : sourceFormat);
    const fileRel = input.file ?? `agents/${input.id}.${format}`;
    if (!input.file) await mkdir(join(base, 'agents'), { recursive: true });
    const target = await outputPath(base, fileRel);
    let detected;
    try { detected = documentFormat(target); } catch { throw new FieldError(['file'], 'Unsupported manifest extension'); }
    if (detected !== format) throw new FieldError(['file'], 'File extension does not match selected manifest format');
    const resolved = await resolveAgentForWrite(clonedDoc, target, format, undefined, store, getImage, false, true);
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

    if (!input.dry_run) {
      await mkdir(resolve(base, dirRel), { recursive: true });
    }
    const baseDirResolved = input.dry_run ? resolve(base, dirRel) : await realpath(resolve(base, dirRel));
    const realBase = await realpath(base);
    const relDir = relative(realBase, baseDirResolved);
    if (relDir === '..' || relDir.startsWith(`..${sep}`) || isAbsolute(relDir) || relDir.split(sep).some(p => p.startsWith('.'))) {
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
            : await outputPath(base, join(dirRel, `${variantId}.${format}`));
          const resolved = await resolveAgentForWrite(doc, target, format, undefined, store, getImage, false, true);
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
      for (const p of writtenPaths) await rm(p, { force: true }).catch(() => {});
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
    const target = fileRef ? await outputPath(base, fileRef) : resolve(base, 'agent.toml');
    if (fileRef) {
      let detected;
      try { detected = documentFormat(target); } catch { throw new FieldError(['file'], 'Unsupported manifest extension'); }
      if (format && detected !== format) throw new FieldError(['file'], 'File extension does not match selected manifest format');
    }
    const { agent, manifest, serialized, revision, digests, warnings } = await resolveAgentForWrite(
      raw,
      target,
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
      const target = await existingWorkspaceFile(base, relPath, 'path');
      if (extname(target) !== '.json') throw new FieldError(['path'], 'Contest manifest must end in .json');
      const bytes = await readWorkspaceFileNoFollow(target);
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); }
      catch { throw new FieldError(['path'], 'Invalid contest JSON'); }
      const loaded = await loadContest(target).then(value => ({ value }), error => ({ error }));
      const realBase = await realpath(base);
      const includeLocalJudge =
        'value' in loaded &&
        loaded.value.contest.judge.kind === 'local' &&
        (url.searchParams.get('include_judge') === '1' || req.headers['x-cr-studio'] === '1');
      return {
        data: {
          path: relative(realBase, target),
          document: parsed,
          valid: 'value' in loaded,
          issues: 'error' in loaded ? [loaded.error instanceof Error ? loaded.error.message : 'Invalid Contest'] : [],
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
      const target = await existingWorkspaceFile(base, relPath, 'path');
      if (extname(target) !== '.json') throw new FieldError(['path'], 'Contest manifest must end in .json');
      const realBase = await realpath(base);
      await rm(target);
      return { data: { deleted: true, path: relative(realBase, target) } };
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
      const deleted = parsed.path
        ? await deleteManagedMaterial(root, parsed.path)
        : await cleanupOrphanMaterials(root, base);
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
    const preview = await previewFn(input.platform, input.contest_id, {
      gym: input.gym,
      baseUrl: input.base_url,
      domain: input.domain,
      cookie,
      signal,
    });
    let pdfInfo: Awaited<ReturnType<typeof inspectPdf>> | undefined;
    if (input.pdf_path) {
      let pdfFile: string;
      if (input.pdf_path.startsWith('managed/')) {
        const ref = parseManagedMaterialRef(root, input.pdf_path);
        const info = await lstat(ref.fullPath);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new FieldError(['pdf_path'], 'Material target is not a regular file');
        }
        const realMaterials = await realpath(join(root, '.materials'));
        const realPdf = await realpath(ref.fullPath);
        const within = relative(realMaterials, realPdf);
        if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
          throw new FieldError(['pdf_path'], 'Material escapes managed directory');
        }
        pdfFile = ref.fullPath;
      } else {
        pdfFile = await existingWorkspaceFile(base, input.pdf_path, 'pdf_path');
      }
      pdfInfo = await inspectPdf(pdfFile);
    }
    const localProblems = input.local_problems ?? pdfInfo?.problem_ids ?? [];
    const problemMapSuggestion = localProblems.length > 0
      ? inferProblemMap(localProblems, preview.problems)
      : undefined;
    return {
      data: {
        preview,
        language_presets: languagePresetsFor(input.platform),
        ...(problemMapSuggestion ? { problem_map_suggestion: problemMapSuggestion } : {}),
        ...(pdfInfo ? { pdf_info: pdfInfo } : {}),
      },
    };
  }

  if (method === 'POST' && path === '/api/contests') {
    return { status: 201, data: await createContestDocument(root, base, await body(), signal) };
  }

  // Preflight Doctor
  if (method === 'POST' && path === '/api/preflight') {
    const input = preflightRequest.parse(await body());
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

    const loadedAgents = new Map<string, Awaited<ReturnType<typeof loadAgent>>>();
    const requiredHarnesses = new Set<'codex' | 'builtin-responses'>();
    const agentChecks: z.infer<typeof preflightReportSchema>['agents'] = [];

    for (const relPath of agentPaths) {
      const issues: string[] = [];
      let agentId: string | undefined;
      let harnessKindVal: string | undefined;
      let credentialOk = false;
      try {
        const resolvedPath = await existingWorkspaceFile(base, relPath, 'agents');
        const loaded = await loadAgent(resolvedPath, store);
        loadedAgents.set(relPath, loaded);
        agentId = loaded.agent.agent_id;
        harnessKindVal = loaded.profile.harness;
        requiredHarnesses.add(loaded.profile.harness);
        try {
          await modelKey(loaded, store);
          credentialOk = true;
        } catch (err) {
          issues.push(err instanceof Error ? err.message : 'Model credential unavailable');
        }
      } catch (err) {
        issues.push(err instanceof Error ? err.message : 'Could not load Agent');
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
          error: err instanceof Error ? err.message : 'Docker image unavailable',
        });
      }
    }

    const loadedContests = new Map<string, Awaited<ReturnType<typeof loadContest>>>();
    const contestChecks: z.infer<typeof preflightReportSchema>['contests'] = [];

    for (const relPath of contestPaths) {
      const issues: string[] = [];
      let contestId: string | undefined;
      let judgeKind: string | undefined;
      let presetName: z.infer<typeof preflightReportSchema>['contests'][number]['protocol_preset'];
      let ojReady = true;
      let pdfCheck: z.infer<typeof preflightReportSchema>['contests'][number]['pdf'];
      try {
        const resolvedPath = await existingWorkspaceFile(base, relPath, 'contests');
        const loaded = await loadContest(resolvedPath);
        loadedContests.set(relPath, loaded);
        contestId = loaded.contest.contest_id;
        judgeKind = loaded.contest.judge.kind;
        presetName = resolveProtocolPreset(loaded.contest.rules);
        const preset = protocolPresets[presetName];

        try {
          const pdfInfo = await inspectPdf(loaded.pdfPath);
          const limits = checkPdfLimits(pdfInfo, { maxPages: preset.pdfMaxPages, maxBytes: preset.pdfMaxBytes });
          pdfCheck = {
            page_count: pdfInfo.page_count,
            size_bytes: pdfInfo.size_bytes,
            ok: limits.ok,
            issues: limits.issues,
          };
          if (!limits.ok) issues.push(...limits.issues);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'PDF inspection failed';
          pdfCheck = { page_count: 0, size_bytes: 0, ok: false, issues: [msg] };
          issues.push(msg);
        }

        if (loaded.contest.judge.kind !== 'local') {
          try {
            await checkOjReadiness(loaded.contest.judge, ojAccounts);
          } catch (err) {
            ojReady = false;
            issues.push(err instanceof Error ? err.message : 'OJ account not ready');
          }
        }
      } catch (err) {
        ojReady = false;
        issues.push(err instanceof Error ? err.message : 'Could not load Contest');
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
          reason: err instanceof Error ? err.message : 'Incompatible cell',
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
