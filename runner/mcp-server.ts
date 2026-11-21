import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { FieldError, manifestProvider } from './agent-manifest.js';
import {
  batchApplyAgents,
  batchImportContests,
  exportSchemas,
  findSecretKeyPaths,
  generateAgentVariants,
  ifExistsSchema,
  resolveConfinedPath,
  schemaTargetSchema,
} from './automation.js';
import { agentDigests, loadAgent, loadContest, resolveAgentManifest, sha256 } from './config.js';
import { Connections } from './connections.js';
import { speedTierSchema } from './harnesses.js';
import { OjAccounts, ojPlatformSchema } from './oj-accounts.js';
import { checkPdfLimits, inspectPdf } from './pdf-synth.js';
import { assertCompatible, specSchema } from './plan.js';
import { protocolPresetNames, protocolPresets, resolveProtocolPreset } from './protocol.js';
import { formatSchema, serializeDocument } from './serialization.js';
import { toBatchSpec, WorkspaceIndex } from './sqlite-index.js';

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

/**
 * Creates a narrow-permission local ContestReplay MCP server for Coding Agents.
 *
 * Security invariants:
 * - ZERO secret access: never calls store.key(), ojAccounts.resolveSecret(),
 *   ojAccounts.resolveAccountTransport(), pushTargets.resolveForDelivery(), or returns judge answers.
 * - ZERO execution / billing authority: no tools to start runs, cancel runs,
 *   delete/rotate credentials, or trigger webhooks.
 * - Strict workspace path confinement via realpath + O_NOFOLLOW checks.
 */
export function createWorkbenchMcpServer(opts: WorkbenchMcpOptions): McpServer {
  const base = resolve(opts.base);
  const root = resolve(opts.root);
  const store = opts.store ?? new Connections();
  const ojAccounts = opts.ojAccounts ?? new OjAccounts();

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
        'List indexed agents, contests, or metadata-only providers / OJ accounts (never exposes credentials or judge answers).',
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
          // Use metadata-only store.list(); never reads credential files or calls store.key().
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

        // kind === 'oj_accounts' (metadata only; never returns cookies or tokens).
        const all = await ojAccounts.list();
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
            ready: acc.ready,
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
      description: 'Compute uncovered (agent x contest) matrix cells and emit a ready-to-use Batch Spec v2 JSON.',
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

        // Prevent native_config.path traversal outside workspace base.
        const harnessObj =
          document.harness && typeof document.harness === 'object' && !Array.isArray(document.harness)
            ? (document.harness as Record<string, unknown>)
            : undefined;
        const nativeCfg =
          harnessObj?.native_config &&
          typeof harnessObj.native_config === 'object' &&
          !Array.isArray(harnessObj.native_config)
            ? (harnessObj.native_config as Record<string, unknown>)
            : undefined;
        const previewPath = join(base, 'agents', 'preview.toml');
        if (nativeCfg && typeof nativeCfg.path === 'string') {
          await resolveConfinedPath(base, resolve(join(base, 'agents'), nativeCfg.path));
        }

        const resolved = await resolveAgentManifest(document, previewPath, store);
        const digestsRaw = agentDigests(resolved.profile, resolved.native, resolved.nativeText, resolved.env);
        const serialized = serializeDocument(resolved.manifest, 'toml');
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
        'Pre-validate and idempotently save a batch of Agent manifests inside the workspace (all-or-nothing; never accepts secrets).',
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
          store,
          dryRun: args.dry_run,
          ifExists: args.if_exists,
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
        'Generate up to 64 validated Agent manifest variants across reasoning_efforts, speed_tiers, and service_tiers.',
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
            store,
            dryRun: args.dry_run,
            ifExists: args.if_exists,
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
        const confined = await resolveConfinedPath(base, args.pdf_path);
        const info = await inspectPdf(confined.absPath, {
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
          info: {
            ...info,
            path: confined.relPath,
          },
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
        'Pre-validate and idempotently import a batch of Contest manifests inside the workspace (supports PDF synthesis and auto problem_map inference; never accepts OJ secrets).',
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
        'Dry-validate a Batch Spec v1 or v2 against workspace agents and contests (checks compatibility without Docker or executing any run).',
      inputSchema: z.strictObject({
        spec: z.unknown(),
      }),
    },
    async ({ spec }) => {
      try {
        const parsed = specSchema.parse(spec);
        const rawCells: Array<{ agent: string; contest: string }> =
          'cells' in parsed
            ? parsed.cells
            : parsed.agents.flatMap(agent => parsed.contests.map(contest => ({ agent, contest })));

        const uniqueAgentRefs = [...new Set(rawCells.map(c => c.agent))];
        const uniqueContestRefs = [...new Set(rawCells.map(c => c.contest))];

        const agents = new Map<
          string,
          { relPath: string; loaded: Awaited<ReturnType<typeof loadAgent>> }
        >();
        const contests = new Map<
          string,
          { relPath: string; loaded: Awaited<ReturnType<typeof loadContest>> }
        >();
        const errors: Array<{ path: string[]; message: string }> = [];

        for (const ref of uniqueAgentRefs) {
          try {
            const confined = await resolveConfinedPath(base, ref);
            const loaded = await loadAgent(confined.absPath, store);
            if (loaded.profile.api !== 'responses' && loaded.profile.api !== 'passthrough') {
              throw new Error(
                `Harness ${loaded.profile.harness} requires a responses or passthrough provider (got ${loaded.profile.api})`,
              );
            }
            agents.set(ref, { relPath: confined.relPath, loaded });
          } catch (error) {
            errors.push({
              path: ['agents', ref],
              message: error instanceof Error ? error.message : 'Invalid agent',
            });
          }
        }

        for (const ref of uniqueContestRefs) {
          try {
            const confined = await resolveConfinedPath(base, ref);
            const loaded = await loadContest(confined.absPath);
            contests.set(ref, { relPath: confined.relPath, loaded });
          } catch (error) {
            errors.push({
              path: ['contests', ref],
              message: error instanceof Error ? error.message : 'Invalid contest',
            });
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
          const preset = resolveProtocolPreset(c.loaded.contest.rules);
          let compatible = true;
          let reason: string | undefined;
          try {
            assertCompatible(a.loaded.profile.harness, c.loaded.contest, a.loaded.agent.agent_id);
            compatibleCount++;
          } catch (error) {
            compatible = false;
            reason = error instanceof Error ? error.message : 'Incompatible cell';
            incompatibleCount++;
          }
          cells.push({
            agent: a.relPath,
            agent_id: a.loaded.agent.agent_id,
            ...(a.loaded.agentName ? { agent_name: a.loaded.agentName } : {}),
            harness: a.loaded.profile.harness,
            speed_tier: a.loaded.speedTier,
            contest: c.relPath,
            contest_id: c.loaded.contest.contest_id,
            data_version: c.loaded.contest.data_version,
            protocol_preset: preset,
            compatible,
            ...(reason ? { reason } : {}),
          });
        }

        const valid = incompatibleCount === 0;
        return mcpResult({
          ok: valid,
          valid,
          schema_version: parsed.schema_version,
          total_cells: cells.length,
          compatible_count: compatibleCount,
          incompatible_count: incompatibleCount,
          cells,
          errors: [],
        });
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
  await new Promise<void>(resolvePromise => {
    const shutdown = () => {
      void server.close().finally(resolvePromise);
    };
    if (signal?.aborted) {
      shutdown();
      return;
    }
    signal?.addEventListener('abort', shutdown, { once: true });
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
  });
}
