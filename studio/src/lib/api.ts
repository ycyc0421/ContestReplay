import { z } from 'zod';
import {
  batchesResponseSchema, cancelResponseSchema, idResponseSchema, logsResponseSchema,
  connectionResponseSchema as connectionSchema, materialResponseSchema as materialSchema, effectiveConfigSchema,
  catalogAgentSchema, catalogContestSchema, matrixResponseSchema, pathResponseSchema, planResponseSchema,
  runProgressSchema, runLogSliceSchema, runReplaySchema, ghostRaceSchema, rankedResultsResponseSchema,
  coverageResponseSchema, preflightReportSchema,
} from '@studio-api';

export async function api<T>(path: string, schema: z.ZodType<T>, payload?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'): Promise<T> {
  const httpMethod = method ?? (payload === undefined ? 'GET' : 'POST');
  let response: Response;
  try {
    response = await fetch(path, httpMethod === 'GET' ? undefined : {
      method: httpMethod, headers: { 'Content-Type': 'application/json', 'X-CR-Studio': '1' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    throw new Error('无法连接本地 Studio 服务，请确认 cr studio 仍在运行。');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = z.object({ error: z.string() }).safeParse(data);
    throw new Error(message.success ? message.data.error : `请求失败（${response.status}）`);
  }
  return schema.parse(data);
}

const documentPathSchema = z.looseObject({ path: z.string() });

export const studioApi = {
  batches: () => api('/api/batches', batchesResponseSchema),
  plan: (agents: string[], contests: string[]) => api('/api/plan', planResponseSchema, { schema_version: 1, agents, contests }),
  planCells: (cells: { agent: string; contest: string; repeats?: number }[]) => api('/api/plan', planResponseSchema, { schema_version: 2, cells }),
  catalogAgents: () => api('/api/catalog/agents', z.strictObject({ agents: z.array(catalogAgentSchema) })),
  catalogContests: () => api('/api/catalog/contests', z.strictObject({ contests: z.array(catalogContestSchema) })),
  matrix: (agents: string[], contests: string[]) => api('/api/matrix', matrixResponseSchema, { agents, contests }),
  startBatch: (token: string, concurrency?: number) => api('/api/batches', idResponseSchema, { token, ...(concurrency ? { concurrency } : {}) }),
  stopBatch: (id: string) => api(`/api/batches/${id}/stop`, idResponseSchema, {}),
  resumeBatch: (id: string) => api(`/api/batches/${id}/resume`, idResponseSchema, {}),
  cancelRun: (id: string) => api(`/api/runs/${id}/cancel`, cancelResponseSchema, {}),
  logs: (id: string) => api(`/api/runs/${id}/logs`, logsResponseSchema),
  progress: (id: string) => api(`/api/runs/${id}/progress`, runProgressSchema),
  logSlice: (id: string, stream: 'stdout' | 'stderr', offset: number, limit = 65_536) =>
    api(`/api/runs/${id}/logs?stream=${stream}&offset=${offset}&limit=${limit}`, runLogSliceSchema),
  replay: (id: string, options: { includeSources?: boolean; includeSession?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (options.includeSources) query.set('include_sources', 'true');
    if (options.includeSession) query.set('include_session', 'true');
    const suffix = query.size ? `?${query}` : '';
    return api(`/api/runs/${id}/replay${suffix}`, runReplaySchema);
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
  preflight: (cells: { agent: string; contest: string }[]) => api('/api/preflight', preflightReportSchema, { schema_version: 2, cells }),
  saveAgent: (file: string, config: unknown) => api('/api/config/agent', pathResponseSchema, { file, config }),
  saveContest: (file: string, config: unknown) => api('/api/config/contest', pathResponseSchema, { file, config }),
  importCodeforces: (file: string, config: unknown) => api('/api/config/codeforces', pathResponseSchema, { file, config }),
  saveAgentDocument: (document: unknown) => api('/api/agents', documentPathSchema, { document }),
  previewAgent: (document: unknown) => api('/api/agents/preview', effectiveConfigSchema, { document }),
  saveContestDocument: (file: string, document: unknown) => api('/api/contests', documentPathSchema, { file, document }),
  connections: () => api('/api/connections', z.strictObject({ connections: z.array(connectionSchema) })),
  providers: async () => {
    const schema = z.strictObject({ providers: z.array(connectionSchema) });
    try { return await api('/api/providers', schema); }
    catch (error) {
      if (error instanceof Error && /404|Not found/i.test(error.message)) {
        const legacy = await studioApi.connections(); return { providers: legacy.connections };
      }
      throw error;
    }
  },
  createProvider: (input: { id?: string; label: string; protocol: string; base_url: string; secret: string }) => api('/api/providers', connectionSchema, input),
  updateProvider: (id: string, input: { label?: string; protocol?: string; base_url?: string }) => api(`/api/providers/${id}`, connectionSchema, input, 'PATCH'),
  rotateProvider: (id: string, secret: string) => api(`/api/providers/${id}/rotate`, connectionSchema, { secret }),
  deleteProvider: (id: string) => api(`/api/providers/${id}`, z.strictObject({ deleted: z.boolean() }), undefined, 'DELETE'),
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
