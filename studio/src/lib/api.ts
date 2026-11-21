import { z } from 'zod';
import {
  batchesResponseSchema, cancelResponseSchema, idResponseSchema, logsResponseSchema,
  connectionResponseSchema as connectionSchema, materialResponseSchema as materialSchema, effectiveConfigSchema,
  catalogAgentSchema, catalogContestSchema, matrixResponseSchema, pathResponseSchema, planResponseSchema,
} from '@studio-api';

export async function api<T>(path: string, schema: z.ZodType<T>, payload?: unknown, method?: 'POST' | 'PATCH' | 'DELETE'): Promise<T> {
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
  planCells: (cells: { agent: string; contest: string }[]) => api('/api/plan', planResponseSchema, { schema_version: 2, cells }),
  catalogAgents: () => api('/api/catalog/agents', z.strictObject({ agents: z.array(catalogAgentSchema) })),
  catalogContests: () => api('/api/catalog/contests', z.strictObject({ contests: z.array(catalogContestSchema) })),
  matrix: (agents: string[], contests: string[]) => api('/api/matrix', matrixResponseSchema, { agents, contests }),
  startBatch: (token: string) => api('/api/batches', idResponseSchema, { token }),
  stopBatch: (id: string) => api(`/api/batches/${id}/stop`, idResponseSchema, {}),
  resumeBatch: (id: string) => api(`/api/batches/${id}/resume`, idResponseSchema, {}),
  cancelRun: (id: string) => api(`/api/runs/${id}/cancel`, cancelResponseSchema, {}),
  logs: (id: string) => api(`/api/runs/${id}/logs`, logsResponseSchema),
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
