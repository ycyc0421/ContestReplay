import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
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
import { protocolPresetNames, protocolPresets, scoringModes } from './protocol.js';
import { resultSchema, resultsSchema } from './results.js';
import { documentFormat, formatSchema, serializeDocument, type Format } from './serialization.js';

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

const SECRET_KEY_RE = /(?:secret|api[_-]?key|token|cookie|password|passwd)/i;

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
    if (SECRET_KEY_RE.test(key)) {
      hits.push(nextPath);
    }
    hits.push(...findSecretKeyPaths(child, nextPath));
  }
  return hits;
}

function safeToJsonSchema(schema: z.ZodType, fallbackTitle: string): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  } catch (error) {
    return {
      title: fallbackTitle,
      type: 'object',
      description: `Schema export fallback (${error instanceof Error ? error.message : 'unrepresentable construct'})`,
    };
  }
}

export function exportSchemas(rawTarget: SchemaTarget = 'all') {
  const target = schemaTargetSchema.parse(rawTarget);
  const allSchemas = {
    agent: safeToJsonSchema(manifestSchema, 'AgentManifest'),
    agent_legacy: safeToJsonSchema(agentSchema, 'LegacyAgentProfile'),
    contest: safeToJsonSchema(contestSchema, 'ContestManifest'),
    judge: safeToJsonSchema(judgeSchema, 'LocalJudgeTable'),
    batch: safeToJsonSchema(specSchema, 'BatchSpec'),
    plan: safeToJsonSchema(planSchema, 'BatchPlan'),
    result: safeToJsonSchema(resultSchema, 'RunResult'),
    results: safeToJsonSchema(resultsSchema, 'ResultsBundle'),
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
      },
      ...listJudgeBackends(),
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

/**
 * Confines a relative path strictly inside `base`, disallowing `..` traversal,
 * hidden segments (`.`-prefixed), null bytes, and symlinks anywhere along the path.
 */
export async function resolveConfinedPath(base: string, targetPath: string): Promise<{ absPath: string; relPath: string }> {
  if (!targetPath || targetPath.includes('\0')) {
    throw new FieldError(['file'], 'Invalid file path');
  }
  const baseReal = await realpath(base);
  const candidate = isAbsolute(targetPath) ? resolve(targetPath) : resolve(baseReal, targetPath);
  const rel = relative(baseReal, candidate);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FieldError(['file'], `Path must stay inside workspace base: ${targetPath}`);
  }
  const parts = rel.split(sep);
  if (parts.some(seg => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    throw new FieldError(['file'], `Hidden or invalid path segment is not allowed: ${targetPath}`);
  }

  let current = baseReal;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new FieldError(['file'], `Symlink is not allowed in confined path: ${rel}`);
      }
      if (i < parts.length - 1 && !info.isDirectory()) {
        throw new FieldError(['file'], `Parent path component is not a directory: ${rel}`);
      }
      if (i === parts.length - 1 && !info.isFile()) {
        throw new FieldError(['file'], `Target path exists and is not a regular file: ${rel}`);
      }
    } catch (error) {
      if (isEnoent(error)) {
        // Non-existent intermediate directories or target file are fine; remaining segments don't exist yet.
        break;
      }
      throw error;
    }
  }

  return { absPath: join(baseReal, ...parts), relPath: parts.join('/') };
}

async function ensureConfinedParentDir(base: string, absTarget: string): Promise<void> {
  const baseReal = await realpath(base);
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

async function atomicWriteFile(absPath: string, content: string | Buffer, overwrite: boolean, mode = 0o600): Promise<void> {
  const temp = `${absPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode, flag: 'wx' });
    if (overwrite) {
      // Re-verify target is not a symlink right before rename.
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
  store?: Connections;
  dryRun?: boolean;
  ifExists?: IfExistsMode;
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
  const base = resolve(opts.base);

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
    digests: AgentDigestsSummary;
  }> = [];
  const seenTargets = new Set<string>();

  for (let i = 0; i < rawItems.length; i++) {
    const rawEntry = rawItems[i];
    // First check secret boundary on the entire raw item before any parsing!
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

    // Accept either `{ file?, format?, document }` or a direct Agent manifest object.
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
      confined = await resolveConfinedPath(base, normalized.file ?? defaultFile);
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
    seenTargets.add(confined.absPath);

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
      action = ifExists === 'skip' ? 'skip' : 'overwrite';
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
      digests,
    });
  }

  // All-or-nothing guarantee: zero files written if any item failed pre-validation.
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

  for (const planItem of planned) {
    if (planItem.action === 'skip') {
      skipped++;
    } else {
      if (!dryRun) {
        await ensureConfinedParentDir(base, planItem.absPath);
        await store.register(planItem.provider, planItem.absPath, () =>
          atomicWriteFile(planItem.absPath, planItem.serialized, planItem.action === 'overwrite', 0o600),
        );
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
  store?: Connections;
  dryRun?: boolean;
  ifExists?: IfExistsMode;
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

function sanitizeIdPart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
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
  const cleanOutDir = spec.out_dir.replace(/^\/+|\/+$/g, '');

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
            .map(sanitizeIdPart);
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
    store: opts.store,
    dryRun,
    ifExists,
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
  root: string;
  base: string;
  dryRun?: boolean;
  ifExists?: IfExistsMode;
  signal?: AbortSignal;
  useExternalPdfTools?: boolean;
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

function validateSynthAscii(
  problems: z.infer<typeof synthProblemSchema>[],
  title: string | undefined,
  subtitle: string | undefined,
  allowAsciiFallback: boolean,
): void {
  if (allowAsciiFallback) return;
  const checkText = (str: string, allowTab: boolean) => {
    const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const ch of normalized) {
      const code = ch.charCodeAt(0);
      if (ch === '\n' || (code >= 0x20 && code <= 0x7e)) continue;
      if (ch === '\t' && allowTab) continue;
      throw new Error(
        'synth_problems contains non-ASCII or verbatim tab characters; pass allow_ascii_fallback: true to permit ASCII fallback',
      );
    }
  };
  if (title) checkText(title, true);
  if (subtitle) checkText(subtitle, true);
  for (const p of problems) {
    checkText(p.id, true);
    checkText(p.title, true);
    checkText(p.body, true);
    for (const s of p.samples ?? []) {
      checkText(s.input, false);
      checkText(s.output, false);
    }
  }
}

export async function batchImportContests(
  rawItems: unknown,
  opts: BatchImportContestsOptions,
): Promise<BatchImportContestsResult> {
  const dryRun = opts.dryRun === true;
  const ifExists = ifExistsSchema.parse(opts.ifExists ?? 'error');
  const base = resolve(opts.base);

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

  const errors: AutomationIssue[] = [];
  const seenTargets = new Set<string>();

  type PlannedContest = {
    contest_id: string;
    absPath: string;
    relPath: string;
    action: 'create' | 'skip' | 'overwrite';
    manifestDraft: Record<string, unknown>;
    answers?: z.infer<typeof judgeSchema>;
    judgeAbsPath?: string;
    judgeRelPath?: string;
    synthProblems?: z.infer<typeof synthProblemSchema>[];
    synthTitle?: string;
    synthSubtitle?: string;
    allowAsciiFallback: boolean;
    synthPdfAbsPath?: string;
    synthPdfRelPath?: string;
    pdfInfo?: Pick<PdfInfo, 'page_count' | 'size_bytes' | 'sha256' | 'problem_ids' | 'extractor'>;
    inferredProblemMap?: ProblemMapInference;
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

    let confined: { absPath: string; relPath: string };
    try {
      confined = await resolveConfinedPath(base, targetFile);
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

    if (seenTargets.has(confined.absPath)) {
      errors.push({
        index: i,
        id: contestId,
        path: ['file'],
        message: `Duplicate contest target path in batch: ${confined.relPath}`,
        code: 'conflict',
      });
      continue;
    }
    seenTargets.add(confined.absPath);

    let exists: boolean;
    try {
      exists = await fileExistsNoFollow(confined.absPath);
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

    let action: 'create' | 'skip' | 'overwrite' = 'create';
    if (exists) {
      if (ifExists === 'error') {
        errors.push({
          index: i,
          id: contestId,
          path: ['file'],
          message: `Contest file already exists: ${confined.relPath}`,
          code: 'conflict',
        });
        continue;
      }
      action = ifExists === 'skip' ? 'skip' : 'overwrite';
    }

    // Prepare judge / answers.
    const rawJudge =
      docFields.judge && typeof docFields.judge === 'object' && !Array.isArray(docFields.judge)
        ? ({ ...(docFields.judge as Record<string, unknown>) })
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
    let judgeAbsPath: string | undefined;
    let judgeRelPath: string | undefined;
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
        if (!normalized.judge && !hasInlineJudgeProblems) problems = undefined;
        problems ??= answers.problems.map(({ id, max_points }) => ({ id, max_points }));

        const stem = basename(confined.absPath, '.json');
        const judgeFileRel = relative(base, join(dirname(confined.absPath), `${stem}.judge.json`));
        try {
          const jConfined = await resolveConfinedPath(base, judgeFileRel);
          judgeAbsPath = jConfined.absPath;
          judgeRelPath = jConfined.relPath;
          if (action === 'create' && (await fileExistsNoFollow(judgeAbsPath)) && ifExists === 'error') {
            errors.push({
              index: i,
              id: contestId,
              path: ['judge'],
              message: `Local judge file already exists: ${judgeRelPath}`,
              code: 'conflict',
            });
            continue;
          }
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

    // Prepare materials / PDF (either synthesized or existing confined PDF).
    let synthPdfAbsPath: string | undefined;
    let synthPdfRelPath: string | undefined;
    let pdfInfo: Pick<PdfInfo, 'page_count' | 'size_bytes' | 'sha256' | 'problem_ids' | 'extractor'> | undefined;
    let materials: Record<string, unknown>;

    if (normalized.synth_problems) {
      try {
        validateSynthAscii(
          normalized.synth_problems,
          normalized.synth_title ?? (typeof docFields.title === 'string' ? docFields.title : undefined),
          normalized.synth_subtitle,
          normalized.allow_ascii_fallback === true,
        );
      } catch (error) {
        errors.push({
          index: i,
          id: contestId,
          path: ['synth_problems'],
          message: error instanceof Error ? error.message : 'Invalid synth_problems',
          code: 'validation',
        });
        continue;
      }
      const stem = basename(confined.absPath, '.json');
      const pdfFileRel = relative(base, join(dirname(confined.absPath), `${stem}.pdf`));
      try {
        const pConfined = await resolveConfinedPath(base, pdfFileRel);
        synthPdfAbsPath = pConfined.absPath;
        synthPdfRelPath = pConfined.relPath;
        if (action === 'create' && (await fileExistsNoFollow(synthPdfAbsPath)) && ifExists === 'error') {
          errors.push({
            index: i,
            id: contestId,
            path: ['materials'],
            message: `Synthesized PDF already exists: ${synthPdfRelPath}`,
            code: 'conflict',
          });
          continue;
        }
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
      const existingMats =
        docFields.materials && typeof docFields.materials === 'object' && !Array.isArray(docFields.materials)
          ? (docFields.materials as Record<string, unknown>)
          : {};
      materials = {
        entrypoint: {
          kind: 'pdf',
          path: `${stem}.pdf`,
          redistribution: 'allowed',
        },
        attachments: Array.isArray(existingMats.attachments) ? existingMats.attachments : [],
      };
    } else {
      const rawMats =
        docFields.materials && typeof docFields.materials === 'object' && !Array.isArray(docFields.materials)
          ? (docFields.materials as Record<string, unknown>)
          : undefined;
      const rawEntrypoint =
        rawMats?.entrypoint && typeof rawMats.entrypoint === 'object' && !Array.isArray(rawMats.entrypoint)
          ? (rawMats.entrypoint as Record<string, unknown>)
          : undefined;
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
      // Inspect the referenced PDF (confined inside base relative to target dir or base).
      const candidatePdfPath = isAbsolute(rawEntrypoint.path)
        ? rawEntrypoint.path
        : resolve(dirname(confined.absPath), rawEntrypoint.path);
      try {
        const pdfConfined = await resolveConfinedPath(base, candidatePdfPath);
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
          path: ['document', 'materials', 'entrypoint', 'path'],
          message: error instanceof Error ? error.message : 'Could not inspect referenced PDF',
          code: 'validation',
        });
        continue;
      }
      materials = {
        entrypoint: { ...rawEntrypoint, kind: 'pdf' },
        attachments: Array.isArray(rawMats?.attachments) ? rawMats.attachments : [],
      };
    }

    // Optional auto problem_map inference for remote OJ judges when PDF problem IDs were detected.
    let inferredProblemMap: ProblemMapInference | undefined;
    const detectedProblemIds = normalized.synth_problems
      ? normalized.synth_problems.map(p => p.id)
      : pdfInfo?.problem_ids ?? [];
    if (
      rawJudge.kind !== 'local' &&
      !rawJudge.problem_map &&
      detectedProblemIds.length > 0 &&
      Array.isArray(problems) &&
      problems.length > 0 &&
      normalized.auto_problem_map !== false
    ) {
      const remoteIds = problems
        .filter((p): p is { id: string } => Boolean(p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string'))
        .map(p => ({ remote_id: p.id }));
      if (remoteIds.length > 0) {
        inferredProblemMap = inferProblemMap(detectedProblemIds, remoteIds);
        if (
          Object.keys(inferredProblemMap.confirmed_map).length === detectedProblemIds.length &&
          inferredProblemMap.unmapped_local.length === 0
        ) {
          // Only attach problem_map when local IDs differ from remote IDs.
          const hasDifference = Object.entries(inferredProblemMap.confirmed_map).some(([k, v]) => k !== v);
          if (hasDifference) {
            resolvedJudge = { ...resolvedJudge, problem_map: inferredProblemMap.confirmed_map };
          }
        }
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

    // For local judge without inline answers, verify referenced answers file exists inside base.
    if (schemaCheck.data.judge.kind === 'local' && !answers) {
      const ansCandidate = resolve(dirname(confined.absPath), schemaCheck.data.judge.answers.path);
      try {
        const ansConfined = await resolveConfinedPath(base, ansCandidate);
        const handle = await open(ansConfined.absPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const st = await handle.stat();
          if (!st.isFile() || st.size > 4_000_000) throw new Error('Invalid local answers file');
          const buf = Buffer.allocUnsafe(st.size);
          let off = 0;
          while (off < st.size) {
            const { bytesRead } = await handle.read(buf, off, st.size - off, off);
            if (!bytesRead) break;
            off += bytesRead;
          }
          judgeSchema.parse(JSON.parse(buf.subarray(0, off).toString('utf8')));
        } finally {
          await handle.close();
        }
      } catch (error) {
        errors.push({
          index: i,
          id: contestId,
          path: ['document', 'judge', 'answers', 'path'],
          message: error instanceof Error ? error.message : 'Invalid local answers file',
          code: 'validation',
        });
        continue;
      }
    }

    planned.push({
      contest_id: contestId,
      absPath: confined.absPath,
      relPath: confined.relPath,
      action,
      manifestDraft,
      answers,
      judgeAbsPath,
      judgeRelPath,
      synthProblems: normalized.synth_problems,
      synthTitle: normalized.synth_title ?? schemaCheck.data.title,
      synthSubtitle: normalized.synth_subtitle,
      allowAsciiFallback: normalized.allow_ascii_fallback === true,
      synthPdfAbsPath,
      synthPdfRelPath,
      pdfInfo,
      inferredProblemMap,
    });
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

    let revision: string | undefined;
    let pdfInfo = item.pdfInfo;

    if (!dryRun) {
      const overwrite = item.action === 'overwrite';
      await ensureConfinedParentDir(base, item.absPath);

      if (item.synthProblems && item.synthPdfAbsPath) {
        const synth = await synthesizeTextContestPdf(item.synthProblems, item.synthPdfAbsPath, {
          title: item.synthTitle,
          subtitle: item.synthSubtitle,
          overwrite,
          allowAsciiFallback: item.allowAsciiFallback,
        });
        pdfInfo = {
          page_count: synth.page_count,
          size_bytes: synth.size_bytes,
          sha256: synth.sha256,
          problem_ids: synth.problem_ids,
          extractor: 'fallback',
        };
      }

      if (item.answers && item.judgeAbsPath) {
        await atomicWriteFile(item.judgeAbsPath, JSON.stringify(item.answers, null, 2) + '\n', overwrite, 0o600);
      }

      const resolved = await resolveContest(item.manifestDraft, item.absPath);
      const { statement: _statement, ...finalDocument } = resolved.contest;
      revision = resolved.contestRevision;
      await atomicWriteFile(item.absPath, JSON.stringify(finalDocument, null, 2) + '\n', overwrite, 0o600);
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
      ...(pdfInfo ? { pdf_info: pdfInfo } : {}),
      ...(item.inferredProblemMap ? { inferred_problem_map: item.inferredProblemMap } : {}),
    });
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
