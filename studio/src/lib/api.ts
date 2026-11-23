import { z } from 'zod';
import {
  batchesResponseSchema, cancelResponseSchema, idResponseSchema, logsResponseSchema,
  connectionResponseSchema as connectionSchema, materialResponseSchema as materialSchema, effectiveConfigSchema,
  catalogAgentSchema, catalogContestSchema, matrixResponseSchema, pathResponseSchema, planResponseSchema,
  runProgressSchema, runLogSliceSchema, runReplaySchema, ghostRaceSchema, rankedResultsResponseSchema,
  coverageResponseSchema, preflightReportSchema, providerResponseSchema, providersResponseSchema,
  agentItemResponseSchema, contestItemResponseSchema, agentVariantsResponseSchema, contestPreviewResponseSchema,
  ojAccountSchema, ojAccountsResponseSchema, ojAccountProbeResponseSchema, pushTargetSchema, pushTargetsResponseSchema,
  pushDeliveriesResponseSchema, pushDeliverySchema,
} from '@studio-api';

export interface ApiIssue {
  path: string[];
  code?: string;
  message: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly issues: ApiIssue[] = []) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, schema: z.ZodType<T>, payload?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE', signal?: AbortSignal): Promise<T> {
  const httpMethod = method ?? (payload === undefined ? 'GET' : 'POST');
  let response: Response;
  try {
    response = await fetch(path, httpMethod === 'GET' ? (signal ? { signal } : undefined) : {
      method: httpMethod, headers: { 'Content-Type': 'application/json', 'X-CR-Studio': '1' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('无法连接本地 Studio 服务，请确认 cr studio 仍在运行。');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({
      error: z.string(),
      issues: z.array(z.object({ path: z.array(z.string()), code: z.string().optional(), message: z.string() })).optional(),
    }).safeParse(data);
    if (parsed.success) throw new ApiError(parsed.data.error, response.status, parsed.data.issues ?? []);
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
  return schema.parse(data);
}

const documentPathSchema = z.looseObject({ path: z.string() });
const deletedResponseSchema = z.strictObject({ deleted: z.boolean(), path: z.string().optional() });
const segment = (id: string) => encodeURIComponent(id);

export const studioApi = {
  batches: () => api('/api/batches', batchesResponseSchema),
  plan: (agents: string[], contests: string[]) => api('/api/plan', planResponseSchema, { schema_version: 1, agents, contests }),
  planCells: (cells: { agent: string; contest: string; repeats?: number }[]) => api('/api/plan', planResponseSchema, { schema_version: 2, cells }),
  catalogAgents: () => api('/api/catalog/agents', z.strictObject({ agents: z.array(catalogAgentSchema) })),
  catalogContests: () => api('/api/catalog/contests', z.strictObject({ contests: z.array(catalogContestSchema) })),
  matrix: (agents: string[], contests: string[]) => api('/api/matrix', matrixResponseSchema, { agents, contests }),
  startBatch: (token: string, concurrency?: number) => api('/api/batches', idResponseSchema, { token, ...(concurrency ? { concurrency } : {}) }),
  stopBatch: (id: string) => api(`/api/batches/${segment(id)}/stop`, idResponseSchema, {}),
  resumeBatch: (id: string) => api(`/api/batches/${segment(id)}/resume`, idResponseSchema, {}),
  cancelRun: (id: string) => api(`/api/runs/${segment(id)}/cancel`, cancelResponseSchema, {}),
  logs: (id: string) => api(`/api/runs/${segment(id)}/logs`, logsResponseSchema),
  progress: (id: string, signal?: AbortSignal) => api(`/api/runs/${segment(id)}/progress`, runProgressSchema, undefined, undefined, signal),
  logSlice: (id: string, stream: 'stdout' | 'stderr', offset: number, limit = 65_536) =>
    api(`/api/runs/${segment(id)}/logs?stream=${encodeURIComponent(stream)}&offset=${offset}&limit=${limit}`, runLogSliceSchema),
  replay: (id: string, options: { includeSources?: boolean; includeSession?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (options.includeSources) query.set('include_sources', 'true');
    if (options.includeSession) query.set('include_session', 'true');
    const suffix = query.size ? `?${query}` : '';
    return api(`/api/runs/${segment(id)}/replay${suffix}`, runReplaySchema);
  },
  race: (runIds: string[], scoringMode?: 'icpc' | 'cf' | 'ioi' | 'last_ac', sampleStepMs = 60_000) =>
    api('/api/runs/race', ghostRaceSchema, { run_ids: runIds, ...(scoringMode ? { scoring_mode: scoringMode } : {}), sample_step_ms: sampleStepMs }),
  ranked: (options: { scoring?: 'icpc' | 'cf' | 'ioi' | 'last_ac'; groupBy?: 'revision' | 'model'; vendor?: string; family?: string; batchId?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.scoring) query.set('scoring', options.scoring);
    if (options.groupBy) query.set('group_by', options.groupBy);
    if (options.vendor) query.set('vendor', options.vendor);
    if (options.family) query.set('family', options.family);
    if (options.batchId) query.set('batch_id', options.batchId);
    const suffix = query.size ? `?${query}` : '';
    return api(`/api/results/ranked${suffix}`, rankedResultsResponseSchema);
  },
  coverage: () => api('/api/coverage', coverageResponseSchema),
  preflight: (cells: { agent: string; contest: string }[]) => api('/api/preflight', preflightReportSchema, { cells }),
  saveAgent: (file: string, config: unknown) => api('/api/config/agent', pathResponseSchema, { file, config }),
  saveContest: (file: string, config: unknown) => api('/api/config/contest', pathResponseSchema, { file, config }),
  importCodeforces: (file: string, config: unknown) => api('/api/config/codeforces', pathResponseSchema, { file, config }),
  saveAgentDocument: (document: unknown) => api('/api/agents', documentPathSchema, { document }),
  agentItem: (path: string) => api(`/api/agents/item?path=${encodeURIComponent(path)}`, agentItemResponseSchema),
  updateAgent: (path: string, format: 'toml' | 'yaml' | 'json', document: unknown) => api('/api/agents/item', documentPathSchema, { path, format, document }, 'PUT'),
  deleteAgent: (path: string) => api(`/api/agents/item?path=${encodeURIComponent(path)}`, deletedResponseSchema, undefined, 'DELETE'),
  cloneAgent: (input: { source_path: string; id: string; name?: string; overrides?: Record<string, unknown> }) => api('/api/agents/clone', documentPathSchema, input),
  agentVariants: (input: { base_document: Record<string, unknown>; reasoning_efforts?: string[]; speed_tiers?: string[]; service_tiers?: string[]; dry_run: boolean }) => api('/api/agents/variants', agentVariantsResponseSchema, input),
  previewAgent: (document: unknown, file?: string) => api('/api/agents/preview', effectiveConfigSchema, { document, ...(file ? { file } : {}) }),
  saveContestDocument: (file: string, document: unknown) => api('/api/contests', documentPathSchema, { file, document }),
  contestItem: (path: string) => api(`/api/contests/item?path=${encodeURIComponent(path)}&include_judge=1`, contestItemResponseSchema),
  updateContest: (path: string, document: unknown) => api('/api/contests/item', documentPathSchema, { path, document }, 'PUT'),
  previewContest: (input: { platform: 'codeforces' | 'qoj' | 'vjudge' | 'hydro'; contest_id: number | string; gym?: boolean; base_url?: string; domain?: string; account_id?: string; local_problems?: string[]; pdf_path?: string; manifest_path?: string; manifest_contest_id?: string }) => api('/api/contests/preview', contestPreviewResponseSchema, input),
  deleteContest: (path: string) => api(`/api/contests/item?path=${encodeURIComponent(path)}`, deletedResponseSchema, undefined, 'DELETE'),
  connections: () => api('/api/connections', z.strictObject({ connections: z.array(connectionSchema) })),
  providers: async () => {
    const schema = providersResponseSchema;
    try { return await api('/api/providers', schema); }
    catch (error) {
      if (error instanceof Error && /404|Not found/i.test(error.message)) {
        const legacy = await studioApi.connections();
        return schema.parse({
          providers: legacy.connections.map(connection => ({
            ...connection,
            backend: connection.backend === 'secret-service' ? 'secret-service' : 'file',
            credential_available: typeof connection.credential_available === 'boolean' ? connection.credential_available : true,
          })),
        });
      }
      throw error;
    }
  },
  createProvider: (input: { id?: string; label: string; protocol: string; base_url: string; secret: string }) => api('/api/providers', providerResponseSchema, input),
  updateProvider: (id: string, input: { label?: string; protocol?: string; base_url?: string }) => api(`/api/providers/${segment(id)}`, providerResponseSchema, input, 'PATCH'),
  rotateProvider: (id: string, secret: string) => api(`/api/providers/${segment(id)}/rotate`, providerResponseSchema, { secret }),
  deleteProvider: (id: string) => api(`/api/providers/${segment(id)}`, z.strictObject({ deleted: z.boolean() }), undefined, 'DELETE'),
  ojAccounts: () => api('/api/oj-accounts', ojAccountsResponseSchema),
  probeOjAccount: (input: { platform: 'codeforces' | 'qoj' | 'vjudge' | 'hydro'; base_url?: string; secret: string }) =>
    api('/api/oj-accounts/probe', ojAccountProbeResponseSchema, input),
  createOjAccount: (input: { id?: string; label: string; platform: 'codeforces' | 'qoj' | 'vjudge' | 'hydro'; handle: string; pool?: string; base_url?: string; transport: 'cookie'; secret: string } | { id?: string; label: string; platform: 'codeforces' | 'qoj' | 'vjudge' | 'hydro'; handle: string; pool?: string; base_url?: string; transport: 'submitter'; executable_path: string }) => api('/api/oj-accounts', ojAccountSchema, input),
  updateOjAccount: (id: string, input: { label?: string; handle?: string; pool?: string; base_url?: string; executable_path?: string }) => api(`/api/oj-accounts/${segment(id)}`, ojAccountSchema, input, 'PATCH'),
  rotateOjAccount: (id: string, secret: string) => api(`/api/oj-accounts/${segment(id)}/rotate`, ojAccountSchema, { secret }),
  deleteOjAccount: (id: string) => api(`/api/oj-accounts/${segment(id)}`, z.strictObject({ deleted: z.boolean() }), undefined, 'DELETE'),
  pushTargets: () => api('/api/push-targets', pushTargetsResponseSchema),
  createPushTarget: (input: { id?: string; label: string; url: string; enabled: boolean; events: ('run.completed' | 'run.progress' | 'batch.completed')[]; auth_mode: 'none' | 'bearer' | 'hmac-sha256'; secret?: string; timeout_ms: number; max_retries: number }) => api('/api/push-targets', pushTargetSchema, input),
  updatePushTarget: (id: string, input: { label?: string; url?: string; enabled?: boolean; events?: ('run.completed' | 'run.progress' | 'batch.completed')[]; timeout_ms?: number; max_retries?: number }) => api(`/api/push-targets/${segment(id)}`, pushTargetSchema, input, 'PATCH'),
  rotatePushTarget: (id: string, secret: string, authMode?: 'bearer' | 'hmac-sha256') => api(`/api/push-targets/${segment(id)}/rotate`, pushTargetSchema, { secret, ...(authMode ? { auth_mode: authMode } : {}) }),
  testPushTarget: (id: string) => api(`/api/push-targets/${segment(id)}/test`, pushDeliverySchema, {}),
  deletePushTarget: (id: string) => api(`/api/push-targets/${segment(id)}`, z.strictObject({ deleted: z.boolean() }), undefined, 'DELETE'),
  pushDeliveries: () => api('/api/push-deliveries?limit=50', pushDeliveriesResponseSchema),
  uploadMaterial: async (file: File, contestId: string, kind: 'entrypoint' | 'attachment') => {
    const body = new FormData(); body.append('file', file); body.append('contest_id', contestId); body.append('kind', kind);
    const response = await fetch('/api/contests/materials', { method: 'POST', headers: { 'X-CR-Studio': '1' }, body });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = z.object({ error: z.string() }).safeParse(data);
      throw new Error(message.success ? message.data.error : `上传失败（${response.status}）`);
    }
    return materialSchema.parse(data);
  },
};
