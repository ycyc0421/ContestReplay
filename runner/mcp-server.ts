import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { agentKind, FieldError, manifestProvider } from './agent-manifest.js';
import {
  assertNotForbiddenMaterialPath,
  assertNotInProtectedDirs,
  batchApplyAgents,
  batchImportContests,
  exportSchemas,
  findSecretKeyPaths,
  generateAgentVariants,
  ifExistsSchema,
  inspectPdfBytes,
  isForbiddenPublicFilename,
  isJudgeAnswerBytes,
  readConfinedRegularFile,
  resolveConfinedPath,
  resolveProtectedDirs,
  schemaTargetSchema,
} from './automation.js';
import {
  agentDigests,
  agentRevision,
  agentSchema,
  resolveAgentManifest,
  resolveContest,
  sha256,
  validated,
} from './config.js';
import { Connections } from './connections.js';
import { speedTierSchema } from './harnesses.js';
import { OjAccounts, ojPlatformSchema } from './oj-accounts.js';
import { checkPdfLimits } from './pdf-synth.js';
import { specSchema } from './plan.js';
import { protocolDigest, protocolPresetNames, protocolPresets, resolveProtocolPreset } from './protocol.js';
import { canonical, documentFormat, formatSchema, parseDocumentText, serializeDocument } from './serialization.js';
import { toBatchSpec, WorkspaceIndex } from './sqlite-index.js';

const PREVIEW_PLACEHOLDER_IMAGE = `sha256:${'0'.repeat(64)}`;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_NATIVE_CONFIG_BYTES = 64_000;
const MAX_ATTACHMENT_BYTES = 16_000_000;
const MAX_JUDGE_FILE_BYTES = 4_000_000;
const MAX_PDF_BYTES = 128 * 1024 * 1024;

export interface WorkbenchMcpOptions {
  base: string;
  root: string;
  store?: Connections;
  ojAccounts?: OjAccounts;
  useExternalPdfTools?: boolean;
}

function mcpResult(value: Record<string, unknown>, isError = false) {
  return {
    ...(isError ? { isError: true as const } : {}),
    structuredContent: value,
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorPayload(error: unknown, code = 'error'): Record<string, unknown> {
  if (error instanceof FieldError) {
    return { ok: false, code: 'validation', path: error.path, error: error.message };
  }
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      code: 'validation',
      error: error.issues.map(iss => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; '),
      issues: error.issues.map(iss => ({ path: iss.path.map(String), message: iss.message })),
    };
  }
  return {
    ok: false,
    code,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function prevalidateAgentTransitiveRefs(
  base: string,
  agentAbsPath: string,
  rawDoc: Record<string, unknown>,
  protectedDirs: readonly string[],
): Promise<{
  validationDoc: Record<string, unknown>;
  savedNativeConfig?: Record<string, unknown>;
  legacyConfigText?: string;
}> {
  const dir = dirname(agentAbsPath);
  let validationDoc: Record<string, unknown> = rawDoc;
  let savedNativeConfig: Record<string, unknown> | undefined;
  let legacyConfigText: string | undefined;

  const harnessObj =
    rawDoc.harness && typeof rawDoc.harness === 'object' && !Array.isArray(rawDoc.harness)
      ? (rawDoc.harness as Record<string, unknown>)
      : undefined;
  const nativeCfg =
    harnessObj?.native_config &&
    typeof harnessObj.native_config === 'object' &&
    !Array.isArray(harnessObj.native_config)
      ? (harnessObj.native_config as Record<string, unknown>)
      : undefined;
  if (nativeCfg && typeof nativeCfg.path === 'string') {
    const candidate = isAbsolute(nativeCfg.path) ? nativeCfg.path : resolve(dir, nativeCfg.path);
    const nativeRead = await readConfinedRegularFile(
      base,
      candidate,
      ['harness', 'native_config', 'path'],
      MAX_NATIVE_CONFIG_BYTES,
    );
    assertNotInProtectedDirs(
      nativeRead.absPath,
      nativeRead.relPath,
      protectedDirs,
      ['harness', 'native_config', 'path'],
      'Native config',
    );
    if (typeof nativeCfg.sha256 === 'string' && sha256(nativeRead.bytes) !== nativeCfg.sha256) {
      throw new FieldError(
        ['harness', 'native_config', 'sha256'],
        `Native config SHA-256 mismatch: ${nativeRead.relPath}`,
      );
    }
    const normalizedPath = isAbsolute(nativeCfg.path)
      ? relative(dir, nativeRead.absPath).split(sep).join('/')
      : nativeCfg.path;
    savedNativeConfig = {
      ...nativeCfg,
      path: normalizedPath,
    };
    validationDoc = {
      ...rawDoc,
      harness: {
        ...harnessObj,
        native_config: {
          format: nativeCfg.format,
          ...(typeof nativeCfg.schema === 'string' ? { schema: nativeCfg.schema } : {}),
          content: nativeRead.bytes.toString('utf8'),
        },
      },
    };
  }
  if (typeof rawDoc.config === 'string') {
    const candidate = isAbsolute(rawDoc.config) ? rawDoc.config : resolve(dir, rawDoc.config);
    const legacyRead = await readConfinedRegularFile(base, candidate, ['config'], MAX_NATIVE_CONFIG_BYTES);
    assertNotInProtectedDirs(legacyRead.absPath, legacyRead.relPath, protectedDirs, ['config'], 'Legacy config');
    legacyConfigText = legacyRead.bytes.toString('utf8');
  }
  return { validationDoc, savedNativeConfig, legacyConfigText };
}

interface VerifiedContestFiles {
  entrypointBytes?: Buffer;
  attachments: Array<{ index: number; bytes: Buffer }>;
  judgeBytes?: Buffer;
}

async function prevalidateContestTransitiveRefs(
  base: string,
  contestAbsPath: string,
  rawDoc: Record<string, unknown>,
  protectedDirs: readonly string[],
): Promise<VerifiedContestFiles> {
  const dir = dirname(contestAbsPath);
  const verified: VerifiedContestFiles = { attachments: [] };

  let judgeAbsPath: string | undefined;
  const judge =
    rawDoc.judge && typeof rawDoc.judge === 'object' && !Array.isArray(rawDoc.judge)
      ? (rawDoc.judge as Record<string, unknown>)
      : undefined;
  if (judge) {
    const answers =
      judge.answers && typeof judge.answers === 'object' && !Array.isArray(judge.answers)
        ? (judge.answers as Record<string, unknown>)
        : undefined;
    const rawJudgePath = typeof answers?.path === 'string' ? answers.path : typeof judge.path === 'string' ? judge.path : undefined;
    const judgeFieldPath = typeof answers?.path === 'string' ? ['judge', 'answers', 'path'] : ['judge', 'path'];
    if (rawJudgePath !== undefined) {
      const candidate = isAbsolute(rawJudgePath) ? rawJudgePath : resolve(dir, rawJudgePath);
      const judgeRead = await readConfinedRegularFile(base, candidate, judgeFieldPath, MAX_JUDGE_FILE_BYTES);
      assertNotInProtectedDirs(judgeRead.absPath, judgeRead.relPath, protectedDirs, judgeFieldPath, 'Local answers file');
      judgeAbsPath = judgeRead.absPath;
      verified.judgeBytes = judgeRead.bytes;
    }
  }

  const checkEntrypoint = async (rawPath: unknown, fieldPath: string[]) => {
    if (typeof rawPath !== 'string') return;
    const candidate = isAbsolute(rawPath) ? rawPath : resolve(dir, rawPath);
    const confined = await resolveConfinedPath(base, candidate, fieldPath);
    assertNotForbiddenMaterialPath(confined.absPath, confined.relPath, protectedDirs, judgeAbsPath, fieldPath);
    const loaded = await readConfinedRegularFile(base, confined.absPath, fieldPath, MAX_PDF_BYTES);
    verified.entrypointBytes = loaded.bytes;
  };

  const materials =
    rawDoc.materials && typeof rawDoc.materials === 'object' && !Array.isArray(rawDoc.materials)
      ? (rawDoc.materials as Record<string, unknown>)
      : undefined;
  if (materials) {
    const entry =
      materials.entrypoint && typeof materials.entrypoint === 'object' && !Array.isArray(materials.entrypoint)
        ? (materials.entrypoint as Record<string, unknown>)
        : undefined;
    await checkEntrypoint(entry?.path, ['materials', 'entrypoint', 'path']);
    if (Array.isArray(materials.attachments)) {
      for (let i = 0; i < materials.attachments.length; i++) {
        const att = materials.attachments[i];
        if (att && typeof att === 'object' && !Array.isArray(att)) {
          const attPath = (att as Record<string, unknown>).path;
          if (typeof attPath !== 'string') continue;
          const fieldPath = ['materials', 'attachments', String(i), 'path'];
          const candidate = isAbsolute(attPath) ? attPath : resolve(dir, attPath);
          const confined = await resolveConfinedPath(base, candidate, fieldPath);
          assertNotForbiddenMaterialPath(confined.absPath, confined.relPath, protectedDirs, judgeAbsPath, fieldPath);
          const attRead = await readConfinedRegularFile(base, confined.absPath, fieldPath, MAX_ATTACHMENT_BYTES);
          if (isJudgeAnswerBytes(attRead.bytes)) {
            throw new FieldError(fieldPath, `Judge answer file cannot be exposed as contest material: ${confined.relPath}`);
          }
          verified.attachments.push({ index: i, bytes: attRead.bytes });
        }
      }
    }
  }
  const statement =
    rawDoc.statement && typeof rawDoc.statement === 'object' && !Array.isArray(rawDoc.statement)
      ? (rawDoc.statement as Record<string, unknown>)
      : undefined;
  await checkEntrypoint(statement?.path, ['statement', 'path']);

  return verified;
}

async function resolvePreviewContestFromVerified(
  rawDoc: Record<string, unknown>,
  verified: VerifiedContestFiles,
  relPath: string,
) {
  const stageDir = await mkdtemp(join(tmpdir(), 'cr-preview-contest-'));
  await chmod(stageDir, 0o700);
  try {
    const stagedDoc: Record<string, unknown> = { ...rawDoc };
    if (verified.entrypointBytes !== undefined) {
      await writeFile(join(stageDir, 'entrypoint.pdf'), verified.entrypointBytes, { mode: 0o600, flag: 'wx' });
    }
    if (verified.judgeBytes !== undefined) {
      await writeFile(join(stageDir, 'judge.json'), verified.judgeBytes, { mode: 0o600, flag: 'wx' });
    }
    const attStageNames = new Map<number, string>();
    for (const att of verified.attachments) {
      const name = `att-${att.index}.bin`;
      await writeFile(join(stageDir, name), att.bytes, { mode: 0o600, flag: 'wx' });
      attStageNames.set(att.index, name);
    }

    let origEntryPath: string | undefined;
    const origAttPaths: string[] = [];
    let origJudgePath: string | undefined;

    if (rawDoc.materials && typeof rawDoc.materials === 'object' && !Array.isArray(rawDoc.materials)) {
      const mats = rawDoc.materials as Record<string, unknown>;
      const entry =
        mats.entrypoint && typeof mats.entrypoint === 'object' && !Array.isArray(mats.entrypoint)
          ? (mats.entrypoint as Record<string, unknown>)
          : undefined;
      if (entry && typeof entry.path === 'string') {
        origEntryPath = entry.path;
      }
      const nextAttachments = Array.isArray(mats.attachments)
        ? mats.attachments.map((att, idx) => {
            if (att && typeof att === 'object' && !Array.isArray(att)) {
              const rec = att as Record<string, unknown>;
              if (typeof rec.path === 'string') origAttPaths[idx] = rec.path;
              const stageName = attStageNames.get(idx);
              if (stageName) return { ...rec, path: stageName };
            }
            return att;
          })
        : mats.attachments;
      stagedDoc.materials = {
        ...mats,
        ...(entry && verified.entrypointBytes !== undefined ? { entrypoint: { ...entry, path: 'entrypoint.pdf' } } : {}),
        ...(nextAttachments !== undefined ? { attachments: nextAttachments } : {}),
      };
    }

    if (rawDoc.statement && typeof rawDoc.statement === 'object' && !Array.isArray(rawDoc.statement)) {
      const stmt = rawDoc.statement as Record<string, unknown>;
      if (typeof stmt.path === 'string') origEntryPath = stmt.path;
      if (verified.entrypointBytes !== undefined) {
        stagedDoc.statement = { ...stmt, path: 'entrypoint.pdf' };
      }
    }

    if (rawDoc.judge && typeof rawDoc.judge === 'object' && !Array.isArray(rawDoc.judge)) {
      const judge = rawDoc.judge as Record<string, unknown>;
      if (judge.answers && typeof judge.answers === 'object' && !Array.isArray(judge.answers)) {
        const answers = judge.answers as Record<string, unknown>;
        if (typeof answers.path === 'string') origJudgePath = answers.path;
        if (verified.judgeBytes !== undefined) {
          stagedDoc.judge = { ...judge, answers: { ...answers, path: 'judge.json' } };
        }
      } else if (typeof judge.path === 'string') {
        origJudgePath = judge.path;
        if (verified.judgeBytes !== undefined) {
          stagedDoc.judge = { ...judge, path: 'judge.json' };
        }
      }
    }

    try {
      const loaded = await resolveContest(stagedDoc, join(stageDir, 'contest.json'));
      const { statement: _stmt, ...v } = loaded.contest;
      const restored = {
        ...v,
        materials: {
          entrypoint: {
            ...v.materials.entrypoint,
            ...(origEntryPath !== undefined ? { path: origEntryPath } : {}),
          },
          attachments: v.materials.attachments.map((att, idx) => ({
            ...att,
            ...(origAttPaths[idx] !== undefined ? { path: origAttPaths[idx]! } : {}),
          })),
        },
        judge:
          v.judge.kind === 'local' && origJudgePath !== undefined
            ? { ...v.judge, answers: { ...v.judge.answers, path: origJudgePath } }
            : v.judge,
      };
      return {
        contest: loaded.contest,
        contestDigest: sha256(JSON.stringify(restored)),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Invalid contest';
      if (msg.includes('Invalid JSON')) {
        throw new FieldError(['contests', relPath], `Invalid JSON: ${relPath}`);
      }
      throw error;
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

/**
 * Creates a narrow-permission local ContestReplay MCP server for Coding Agents.
 *
 * Security invariants:
 * - ZERO secret access: never calls store.key(), store.listProviders(), ojAccounts.list(),
 *   ojAccounts.resolveSecret(), ojAccounts.resolveAccountTransport(), pushTargets.resolveForDelivery(),
 *   or returns judge answers.
 * - ZERO execution / billing authority: no tools to start runs, cancel runs,
 *   delete/rotate credentials, or trigger webhooks.
 * - Strict workspace path confinement via realpath + O_NOFOLLOW checks, with writable outputs
 *   restricted to approved directories (`agents/`, `contests/`) and verified resource identity on overwrite.
 */
export function createWorkbenchMcpServer(opts: WorkbenchMcpOptions): McpServer {
  const base = resolve(opts.base);
  const root = resolve(opts.root);
  const store = opts.store ?? new Connections();
  const ojAccounts = opts.ojAccounts ?? new OjAccounts();
  const credentialDirs = [store.root, ojAccounts.root];

  const withIndex = async <T>(fn: (index: WorkspaceIndex) => Promise<T> | T): Promise<T> => {
    const index = new WorkspaceIndex(root);
    try {
      await index.sync({ base, root, store });
      return await fn(index);
    } finally {
      index.close();
    }
  };

  const server = new McpServer({
    name: 'contestreplay-workbench',
    version: '0.2.0',
  });

  // 1. cr_schema_export
  server.registerTool(
    'cr_schema_export',
    {
      description: 'Export ContestReplay JSON Schemas and harness/judge/protocol capability metadata.',
      inputSchema: z.strictObject({
        target: schemaTargetSchema.optional(),
      }),
    },
    async ({ target }) => {
      try {
        return mcpResult({ ok: true, ...exportSchemas(target ?? 'all') });
      } catch (error) {
        return mcpResult(errorPayload(error), true);
      }
    },
  );

  // 2. cr_catalog_list
  server.registerTool(
    'cr_catalog_list',
    {
      description:
        'List indexed agents, contests, or metadata-only providers / OJ accounts (never accesses or exposes credentials or judge answers).',
      inputSchema: z.strictObject({
        kind: z.enum(['agents', 'contests', 'providers', 'oj_accounts']),
        search: z.string().max(200).optional(),
        vendor: z.string().max(128).optional(),
        harness: z.string().max(64).optional(),
        provider: z.string().max(128).optional(),
        judge_kind: z.string().max(64).optional(),
        platform: ojPlatformSchema.optional(),
        valid_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    async args => {
      try {
        const limit = args.limit ?? 100;
        const offset = args.offset ?? 0;

        if (args.kind === 'agents') {
          const data = await withIndex(index =>
            index.listAgents({
              search: args.search,
              vendor: args.vendor,
              harness: args.harness,
              provider: args.provider,
              validOnly: args.valid_only,
              limit,
              offset,
            }),
          );
          return mcpResult({ ok: true, kind: 'agents', ...data });
        }

        if (args.kind === 'contests') {
          const data = await withIndex(index =>
            index.listContests({
              search: args.search,
              judgeKind: args.judge_kind,
              validOnly: args.valid_only,
              limit,
              offset,
            }),
          );
          return mcpResult({ ok: true, kind: 'contests', ...data });
        }

        if (args.kind === 'providers') {
          // Metadata-only store.list(); NEVER calls store.listProviders() or store.key()!
          const all = await store.list();
          const q = args.search?.trim().toLowerCase();
          const filtered = all
            .filter(
              p =>
                !q ||
                p.id.toLowerCase().includes(q) ||
                p.label.toLowerCase().includes(q) ||
                p.base_url.toLowerCase().includes(q) ||
                p.protocol.toLowerCase().includes(q),
            )
            .map(p => ({
              id: p.id,
              label: p.label,
              protocol: p.protocol,
              base_url: p.base_url,
              approved_origin: p.approved_origin,
              ...(p.supports_fast !== undefined ? { supports_fast: p.supports_fast } : {}),
              ...(p.supports_ultrafast !== undefined ? { supports_ultrafast: p.supports_ultrafast } : {}),
            }));
          return mcpResult({
            ok: true,
            kind: 'providers',
            total: filtered.length,
            items: filtered.slice(offset, offset + limit),
          });
        }

        // kind === 'oj_accounts': metadata-only ojAccounts.listMetadata(); NEVER reads cookies/secrets or probes executables!
        const all = await ojAccounts.listMetadata();
        const q = args.search?.trim().toLowerCase();
        const filtered = all
          .filter(acc => {
            if (args.platform && acc.platform !== args.platform) return false;
            if (!q) return true;
            return (
              acc.id.toLowerCase().includes(q) ||
              acc.label.toLowerCase().includes(q) ||
              acc.handle.toLowerCase().includes(q) ||
              acc.pool.toLowerCase().includes(q) ||
              acc.platform.toLowerCase().includes(q)
            );
          })
          .map(acc => ({
            id: acc.id,
            label: acc.label,
            platform: acc.platform,
            handle: acc.handle,
            pool: acc.pool,
            transport: acc.transport,
            ...(acc.base_url ? { base_url: acc.base_url } : {}),
            backend: acc.backend,
            created_at: acc.created_at,
            updated_at: acc.updated_at,
          }));
        return mcpResult({
          ok: true,
          kind: 'oj_accounts',
          total: filtered.length,
          items: filtered.slice(offset, offset + limit),
        });
      } catch (error) {
        return mcpResult(errorPayload(error), true);
      }
    },
  );

  // 3. cr_coverage_diff
  server.registerTool(
    'cr_coverage_diff',
    {
      description: 'Compute uncovered (agent x contest) matrix cells and emit a ready-to-use Batch Spec v2 JSON (or null if 0 gaps).',
      inputSchema: z.strictObject({
        agent_ids: z.array(z.string().min(1)).max(256).optional(),
        contest_ids: z.array(z.string().min(1)).max(512).optional(),
        min_repeats: z.number().int().min(1).max(100).optional(),
        include_void: z.boolean().optional(),
        max_cells: z.number().int().min(1).max(1000).optional(),
      }),
    },
    async args => {
      try {
        const diff = await withIndex(index =>
          index.findUncoveredCells({
            agentIds: args.agent_ids,
            contestIds: args.contest_ids,
            minRepeats: args.min_repeats ?? 1,
            includeVoid: args.include_void ?? true,
            maxCells: args.max_cells ?? 1000,
          }),
        );
        return mcpResult({
          ok: true,
          total_gaps: diff.total_gaps,
          waves_required: diff.waves_required,
          truncated: diff.truncated,
          incompatible_skipped: diff.incompatible_skipped,
          cells: diff.cells,
          batch_spec: toBatchSpec(diff),
        });
      } catch (error) {
        return mcpResult(errorPayload(error), true);
      }
    },
  );

  // 4. cr_agent_validate
  server.registerTool(
    'cr_agent_validate',
    {
      description:
        'Validate an Agent manifest document against registered providers and harness capabilities, returning a redacted effective config preview.',
      inputSchema: z.strictObject({
        document: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ document }) => {
      try {
        const secretHits = findSecretKeyPaths(document);
        if (secretHits.length > 0) {
          return mcpResult(
            {
              ok: false,
              valid: false,
              code: 'secret_rejected',
              issues: secretHits.map(path => ({
                path,
                message: `Embedded secret field "${path.join('.')}" is forbidden; reference a saved provider ID instead`,
              })),
            },
            true,
          );
        }

        const baseReal = await realpath(base);
        const protectedDirs = await resolveProtectedDirs({
          baseReal,
          baseResolved: base,
          root,
          store,
          credentialDirs,
        });
        const previewPath = join(baseReal, 'agents', 'preview.toml');
        const { validationDoc, savedNativeConfig } = await prevalidateAgentTransitiveRefs(
          base,
          previewPath,
          document,
          protectedDirs,
        );

        const resolved = await resolveAgentManifest(validationDoc, previewPath, store);
        const digestsRaw = agentDigests(resolved.profile, resolved.native, resolved.nativeText, resolved.env);
        const manifestForSource = savedNativeConfig
          ? {
              ...resolved.manifest,
              harness: {
                ...resolved.manifest.harness,
                native_config: savedNativeConfig,
              },
            }
          : resolved.manifest;
        const serialized = serializeDocument(manifestForSource, 'toml');
        return mcpResult({
          ok: true,
          valid: true,
          agent_id: resolved.manifest.id,
          ...(resolved.manifest.name ? { name: resolved.manifest.name } : {}),
          provider: {
            id: manifestProvider(resolved.manifest),
            label: resolved.connection.label,
            protocol: resolved.connection.protocol,
            base_url: resolved.connection.base_url,
            ...(resolved.connection.supports_fast !== undefined
              ? { supports_fast: resolved.connection.supports_fast }
              : {}),
            ...(resolved.connection.supports_ultrafast !== undefined
              ? { supports_ultrafast: resolved.connection.supports_ultrafast }
              : {}),
          },
          speed_tier: resolved.manifest.speed_tier ?? 'standard',
          effective: {
            format: resolved.effective.format,
            content: resolved.effective.content,
          },
          digests: {
            source_sha256: sha256(serialized),
            profile_sha256: digestsRaw.profileDigest,
            ...(digestsRaw.nativeDigest ? { native_sha256: digestsRaw.nativeDigest } : {}),
            effective_sha256: digestsRaw.effectiveDigest,
          },
        });
      } catch (error) {
        return mcpResult({ ...errorPayload(error), valid: false }, true);
      }
    },
  );

  // 5. cr_agent_batch_apply
  server.registerTool(
    'cr_agent_batch_apply',
    {
      description:
        'Pre-validate and idempotently save a batch of Agent manifests under agents/ inside the workspace (all-or-nothing; never accepts secrets).',
      inputSchema: z.strictObject({
        items: z.array(z.unknown()).min(1).max(256),
        dry_run: z.boolean().optional(),
        if_exists: ifExistsSchema.optional(),
      }),
    },
    async args => {
      try {
        const res = await batchApplyAgents(args.items, {
          base,
          root,
          store,
          dryRun: args.dry_run,
          ifExists: args.if_exists,
          allowedPrefixes: ['agents'],
          credentialDirs,
        });
        return mcpResult(res as unknown as Record<string, unknown>, !res.ok);
      } catch (error) {
        return mcpResult(errorPayload(error), true);
      }
    },
  );

  // 6. cr_agent_generate_variants
  server.registerTool(
    'cr_agent_generate_variants',
    {
      description:
        'Generate up to 64 validated Agent manifest variants under agents/ across reasoning_efforts, speed_tiers, and service_tiers.',
      inputSchema: z.strictObject({
        base_document: z.record(z.string(), z.unknown()),
        reasoning_efforts: z.array(z.string().trim().min(1)).max(16).optional(),
        speed_tiers: z.array(speedTierSchema).max(8).optional(),
        service_tiers: z.array(z.string().trim().min(1)).max(8).optional(),
        id_template: z.string().trim().min(1).max(160).optional(),
        name_template: z.string().trim().min(1).max(160).optional(),
        format: formatSchema.optional(),
        out_dir: z.string().trim().min(1).max(256).optional(),
        dry_run: z.boolean().optional(),
        if_exists: ifExistsSchema.optional(),
      }),
    },
    async args => {
      try {
        const res = await generateAgentVariants(
          {
            base_document: args.base_document,
            reasoning_efforts: args.reasoning_efforts,
            speed_tiers: args.speed_tiers,
            service_tiers: args.service_tiers,
            id_template: args.id_template,
            name_template: args.name_template,
            format: args.format,
            out_dir: args.out_dir,
          },
          {
            base,
            root,
            store,
            dryRun: args.dry_run,
            ifExists: args.if_exists,
            allowedPrefixes: ['agents'],
            credentialDirs,
          },
        );
        return mcpResult(res as unknown as Record<string, unknown>, !res.ok);
      } catch (error) {
        return mcpResult(errorPayload(error), true);
      }
    },
  );

  // 7a. cr_contest_inspect_pdf
  server.registerTool(
    'cr_contest_inspect_pdf',
    {
      description:
        'Inspect a contest PDF inside the workspace for page count, SHA-256, detected problem headers, and protocol preset limits.',
      inputSchema: z.strictObject({
        pdf_path: z.string().trim().min(1).max(4096),
        protocol_preset: z.enum(protocolPresetNames).optional(),
      }),
    },
    async args => {
      try {
        const baseReal = await realpath(base);
        const protectedDirs = await resolveProtectedDirs({
          baseReal,
          baseResolved: base,
          root,
          store,
          credentialDirs,
        });
        const confined = await resolveConfinedPath(base, args.pdf_path, ['pdf_path']);
        assertNotInProtectedDirs(confined.absPath, confined.relPath, protectedDirs, ['pdf_path'], 'PDF file');
        if (isForbiddenPublicFilename(confined.absPath)) {
          throw new FieldError(['pdf_path'], `Forbidden filename: ${confined.relPath}`);
        }
        const pdfRead = await readConfinedRegularFile(baseReal, confined.absPath, ['pdf_path'], MAX_PDF_BYTES);
        const info = await inspectPdfBytes(pdfRead.bytes, confined.relPath, {
          useExternalTools: opts.useExternalPdfTools ?? false,
        });
        const presetName = args.protocol_preset ?? 'short';
        const preset = protocolPresets[presetName];
        const limits = checkPdfLimits(info, {
          maxPages: preset.pdfMaxPages,
          maxBytes: preset.pdfMaxBytes,
        });
        return mcpResult({
          ok: true,
          path: confined.relPath,
          protocol_preset: presetName,
          info,
          limits,
        });
      } catch (error) {
        return mcpResult(errorPayload(error), true);
      }
    },
  );

  // 7b. cr_contest_batch_import
  server.registerTool(
    'cr_contest_batch_import',
    {
      description:
        'Pre-validate and idempotently import a batch of Contest manifests under contests/ inside the workspace (supports PDF synthesis and auto problem_map inference; never accepts OJ secrets).',
      inputSchema: z.strictObject({
        items: z.array(z.unknown()).min(1).max(256),
        dry_run: z.boolean().optional(),
        if_exists: ifExistsSchema.optional(),
      }),
    },
    async args => {
      try {
        const res = await batchImportContests(args.items, {
          root,
          base,
          dryRun: args.dry_run,
          ifExists: args.if_exists,
          useExternalPdfTools: opts.useExternalPdfTools,
          allowedPrefixes: ['contests'],
          credentialDirs,
        });
        return mcpResult(res as unknown as Record<string, unknown>, !res.ok);
      } catch (error) {
        return mcpResult(errorPayload(error), true);
      }
    },
  );

  // 8. cr_plan_preview
  server.registerTool(
    'cr_plan_preview',
    {
      description:
        'Dry-validate a Batch Spec v1 or v2 against workspace agents and contests (checks canonical path deduplication, revision deduplication, transitive path confinement, and compatibility without Docker or executing any run).',
      inputSchema: z.strictObject({
        spec: z.unknown(),
      }),
    },
    async ({ spec }) => {
      try {
        const baseReal = await realpath(base);
        const protectedDirs = await resolveProtectedDirs({
          baseReal,
          baseResolved: base,
          root,
          store,
          credentialDirs,
        });
        const parsed = specSchema.parse(spec);
        const rawCells: Array<{ agent: string; contest: string }> =
          'cells' in parsed
            ? parsed.cells
            : parsed.agents.flatMap(agent => parsed.contests.map(contest => ({ agent, contest })));

        const errors: Array<{ path: string[]; message: string }> = [];

        // Canonicalize paths & enforce makePlan axis / cell deduplication parity!
        const canonicalAgentByRef = new Map<string, { absPath: string; relPath: string }>();
        const canonicalContestByRef = new Map<string, { absPath: string; relPath: string }>();

        const uniqueAgentRefs = 'cells' in parsed ? [...new Set(parsed.cells.map(c => c.agent))] : parsed.agents;
        const uniqueContestRefs = 'cells' in parsed ? [...new Set(parsed.cells.map(c => c.contest))] : parsed.contests;

        const seenAgentAbs = new Set<string>();
        for (const ref of uniqueAgentRefs) {
          try {
            const confined = await resolveConfinedPath(base, ref, ['agents', ref]);
            if (isForbiddenPublicFilename(confined.absPath)) {
              throw new FieldError(['agents', ref], `Forbidden filename for agent manifest: ${confined.relPath}`);
            }
            assertNotInProtectedDirs(confined.absPath, confined.relPath, protectedDirs, ['agents', ref], 'Agent manifest');
            if (seenAgentAbs.has(confined.absPath)) {
              errors.push({ path: ['agents', ref], message: `Duplicate input paths in a matrix axis: ${confined.relPath}` });
              continue;
            }
            seenAgentAbs.add(confined.absPath);
            canonicalAgentByRef.set(ref, confined);
          } catch (error) {
            errors.push({
              path: ['agents', ref],
              message: error instanceof Error ? error.message : 'Invalid agent path',
            });
          }
        }

        const seenContestAbs = new Set<string>();
        for (const ref of uniqueContestRefs) {
          try {
            const confined = await resolveConfinedPath(base, ref, ['contests', ref]);
            if (isForbiddenPublicFilename(confined.absPath)) {
              throw new FieldError(['contests', ref], `Forbidden filename for contest manifest: ${confined.relPath}`);
            }
            assertNotInProtectedDirs(confined.absPath, confined.relPath, protectedDirs, ['contests', ref], 'Contest manifest');
            if (seenContestAbs.has(confined.absPath)) {
              errors.push({ path: ['contests', ref], message: `Duplicate input paths in a matrix axis: ${confined.relPath}` });
              continue;
            }
            seenContestAbs.add(confined.absPath);
            canonicalContestByRef.set(ref, confined);
          } catch (error) {
            errors.push({
              path: ['contests', ref],
              message: error instanceof Error ? error.message : 'Invalid contest path',
            });
          }
        }

        if ('cells' in parsed && errors.length === 0) {
          const seenCanonicalCells = new Set<string>();
          for (const cell of parsed.cells) {
            const aConf = canonicalAgentByRef.get(cell.agent)!;
            const cConf = canonicalContestByRef.get(cell.contest)!;
            const key = JSON.stringify([aConf.absPath, cConf.absPath]);
            if (seenCanonicalCells.has(key)) {
              errors.push({
                path: ['cells'],
                message: `Duplicate matrix cell after path canonicalization: ${aConf.relPath} × ${cConf.relPath}`,
              });
            }
            seenCanonicalCells.add(key);
          }
        }

        interface LightAgentMeta {
          absPath: string;
          relPath: string;
          agent_id: string;
          agent_name?: string;
          harness: 'builtin-responses' | 'codex';
          speed_tier: string;
          baseRevision: string;
        }
        interface LightContestMeta {
          absPath: string;
          relPath: string;
          contest_id: string;
          data_version: number;
          contest_sha256: string;
          judge_kind: string;
          attachment_count: number;
          protocol_preset: string;
        }

        const agents = new Map<string, LightAgentMeta>();
        const contests = new Map<string, LightContestMeta>();

        if (errors.length === 0) {
          for (const [ref, confined] of canonicalAgentByRef) {
            try {
              // Read ONCE via O_NOFOLLOW and validate from verified bytes (zero reopen TOCTOU).
              const rawFile = await readConfinedRegularFile(baseReal, confined.absPath, ['agents', ref], MAX_MANIFEST_BYTES);
              const fmt = documentFormat(confined.absPath);
              let rawParsed: unknown;
              try {
                rawParsed = parseDocumentText(rawFile.bytes.toString('utf8'), fmt);
              } catch {
                throw new FieldError(['agents', ref], `Invalid ${fmt.toUpperCase()}: ${confined.relPath}`);
              }
              if (!rawParsed || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) {
                throw new FieldError(['agents', ref], `Invalid agent manifest: ${confined.relPath}`);
              }
              const rawDoc = rawParsed as Record<string, unknown>;
              const pre = await prevalidateAgentTransitiveRefs(base, confined.absPath, rawDoc, protectedDirs);

              let profile;
              let effectiveDigest: string;
              let agentName: string | undefined;
              let speedTier: string;
              if ('kind' in rawDoc) {
                if (rawDoc.kind !== agentKind) {
                  throw new FieldError(['agents', ref], 'Unsupported Agent manifest kind');
                }
                const resolved = await resolveAgentManifest(pre.validationDoc, confined.absPath, store);
                profile = resolved.profile;
                effectiveDigest = agentDigests(resolved.profile, resolved.native, resolved.nativeText, resolved.env).effectiveDigest;
                agentName = profile.name;
                speedTier = profile.speed_tier ?? 'standard';
              } else {
                let candidateRaw: unknown = rawDoc;
                let nativeText: string | undefined;
                if ('schema_version' in rawDoc || 'agent_id' in rawDoc) {
                  if (
                    rawDoc.schema_version !== 1 ||
                    typeof rawDoc.agent_id !== 'string' ||
                    typeof rawDoc.config !== 'string' ||
                    pre.legacyConfigText === undefined
                  ) {
                    throw new FieldError(['agents', ref], `Invalid legacy agent manifest: ${confined.relPath}`);
                  }
                  let parsedLegacy: Record<string, unknown>;
                  try {
                    parsedLegacy = Object(parseDocumentText(pre.legacyConfigText, 'toml')) as Record<string, unknown>;
                  } catch {
                    throw new FieldError(['agents', ref], `Invalid legacy config TOML: ${confined.relPath}`);
                  }
                  const { name: _displayName, ...nativeCore } = parsedLegacy;
                  nativeText = canonical(nativeCore);
                  const hObj =
                    rawDoc.harness && typeof rawDoc.harness === 'object' && !Array.isArray(rawDoc.harness)
                      ? (rawDoc.harness as Record<string, unknown>)
                      : undefined;
                  candidateRaw = { ...parsedLegacy, id: rawDoc.agent_id, harness: hObj?.kind };
                }
                profile = validated(agentSchema, candidateRaw, confined.relPath);
                effectiveDigest = agentDigests(profile, undefined, nativeText, undefined).effectiveDigest;
                agentName = profile.name;
                speedTier = profile.speed_tier ?? 'standard';
              }

              if (profile.api !== 'responses' && profile.api !== 'passthrough') {
                throw new Error(
                  `Harness ${profile.harness} requires a responses or passthrough provider (got ${profile.api})`,
                );
              }
              const baseRevision = agentRevision(
                { profile, effectiveDigest },
                PREVIEW_PLACEHOLDER_IMAGE,
                protocolDigest,
              );
              agents.set(ref, {
                absPath: confined.absPath,
                relPath: confined.relPath,
                agent_id: profile.id,
                ...(agentName ? { agent_name: agentName } : {}),
                harness: profile.harness,
                speed_tier: speedTier,
                baseRevision,
              });
            } catch (error) {
              errors.push({
                path: ['agents', ref],
                message: error instanceof Error ? error.message : 'Invalid agent',
              });
            }
          }

          for (const [ref, confined] of canonicalContestByRef) {
            try {
              // Read ONCE via O_NOFOLLOW, sanitize JSON parse errors, pre-validate transitive refs, and resolve from verified staged bytes!
              const rawFile = await readConfinedRegularFile(baseReal, confined.absPath, ['contests', ref], MAX_MANIFEST_BYTES);
              let rawParsed: unknown;
              try {
                rawParsed = JSON.parse(rawFile.bytes.toString('utf8'));
              } catch {
                throw new FieldError(['contests', ref], `Invalid JSON: ${confined.relPath}`);
              }
              if (!rawParsed || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) {
                throw new FieldError(['contests', ref], `Invalid contest manifest: ${confined.relPath}`);
              }
              const rawDoc = rawParsed as Record<string, unknown>;
              const verifiedFiles = await prevalidateContestTransitiveRefs(base, confined.absPath, rawDoc, protectedDirs);
              const loaded = await resolvePreviewContestFromVerified(rawDoc, verifiedFiles, confined.relPath);
              // Retain ONLY lightweight metadata; immediately drop PDF, attachment buffers, and judge answers!
              contests.set(ref, {
                absPath: confined.absPath,
                relPath: confined.relPath,
                contest_id: loaded.contest.contest_id,
                data_version: loaded.contest.data_version,
                contest_sha256: loaded.contestDigest,
                judge_kind: loaded.contest.judge.kind,
                attachment_count: loaded.contest.materials.attachments.length,
                protocol_preset: resolveProtocolPreset(loaded.contest.rules),
              });
            } catch (error) {
              errors.push({
                path: ['contests', ref],
                message: error instanceof Error ? error.message : 'Invalid contest',
              });
            }
          }
        }

        // Check duplicate (agent_id, revision, speed_tier) and (contest_id, data_version, contest_sha256) matching makePlan!
        if (errors.length === 0) {
          const seenAgentRevs = new Set<string>();
          for (const a of agents.values()) {
            const key = JSON.stringify([a.agent_id, a.baseRevision, a.speed_tier]);
            if (seenAgentRevs.has(key)) {
              errors.push({
                path: ['agents'],
                message: `Duplicate Agent revision in matrix axis: ${a.agent_id} (${a.relPath})`,
              });
            }
            seenAgentRevs.add(key);
          }
          const seenContestRevs = new Set<string>();
          for (const c of contests.values()) {
            const key = JSON.stringify([c.contest_id, c.data_version, c.contest_sha256]);
            if (seenContestRevs.has(key)) {
              errors.push({
                path: ['contests'],
                message: `Duplicate Contest revision in matrix axis: ${c.contest_id}@v${c.data_version} (${c.relPath})`,
              });
            }
            seenContestRevs.add(key);
          }
        }

        if (errors.length > 0) {
          return mcpResult(
            {
              ok: false,
              valid: false,
              schema_version: parsed.schema_version,
              total_cells: rawCells.length,
              compatible_count: 0,
              incompatible_count: 0,
              cells: [],
              errors,
            },
            true,
          );
        }

        const cells: Array<{
          agent: string;
          agent_id: string;
          agent_name?: string;
          harness: string;
          speed_tier: string;
          contest: string;
          contest_id: string;
          data_version: number;
          protocol_preset: string;
          compatible: boolean;
          reason?: string;
        }> = [];
        let compatibleCount = 0;
        let incompatibleCount = 0;

        for (const cell of rawCells) {
          const a = agents.get(cell.agent)!;
          const c = contests.get(cell.contest)!;
          let compatible = true;
          let reason: string | undefined;
          if (a.harness === 'builtin-responses' && (c.judge_kind !== 'local' || c.attachment_count > 0)) {
            compatible = false;
            reason = `Incompatible cell ${a.agent_id} × ${c.contest_id}: built-in Responses supports PDF and local answers only`;
            incompatibleCount++;
          } else {
            compatibleCount++;
          }
          cells.push({
            agent: a.relPath,
            agent_id: a.agent_id,
            ...(a.agent_name ? { agent_name: a.agent_name } : {}),
            harness: a.harness,
            speed_tier: a.speed_tier,
            contest: c.relPath,
            contest_id: c.contest_id,
            data_version: c.data_version,
            protocol_preset: c.protocol_preset,
            compatible,
            ...(reason ? { reason } : {}),
          });
        }

        const valid = incompatibleCount === 0;
        return mcpResult(
          {
            ok: valid,
            valid,
            schema_version: parsed.schema_version,
            total_cells: cells.length,
            compatible_count: compatibleCount,
            incompatible_count: incompatibleCount,
            cells,
            errors: [],
          },
          !valid,
        );
      } catch (error) {
        return mcpResult({ ...errorPayload(error), valid: false }, true);
      }
    },
  );

  return server;
}

export async function serveWorkbenchMcp(opts: WorkbenchMcpOptions, signal?: AbortSignal): Promise<void> {
  const server = createWorkbenchMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closing = false;
  let onShutdown: (() => void) | undefined;

  try {
    await new Promise<void>(resolvePromise => {
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void server.close().catch(() => {}).finally(resolvePromise);
      };
      onShutdown = shutdown;
      if (signal?.aborted || process.stdin.readableEnded) {
        shutdown();
        return;
      }
      signal?.addEventListener('abort', shutdown, { once: true });
      process.stdin.once('end', shutdown);
      process.stdin.once('close', shutdown);
    });
  } finally {
    if (onShutdown) {
      signal?.removeEventListener('abort', onShutdown);
      process.stdin.off('end', onShutdown);
      process.stdin.off('close', onShutdown);
    }
    if (!closing) {
      closing = true;
      await server.close().catch(() => {});
    }
  }
}
