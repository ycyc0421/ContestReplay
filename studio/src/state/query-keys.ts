import type { QueryClient } from '@tanstack/react-query';

export const queryKeys = {
  capabilities: ['capabilities'] as const,
  batches: ['batches'] as const,
  catalogAll: ['catalog'] as const,
  catalogAgents: ['catalog', 'agents'] as const,
  catalogContests: ['catalog', 'contests'] as const,
  agentItemAll: ['agent-item'] as const,
  agentItem: (path: string) => ['agent-item', path] as const,
  contestItemAll: ['contest-item'] as const,
  contestItem: (path: string) => ['contest-item', path] as const,
  matrixAll: ['matrix'] as const,
  matrix: (agents: readonly string[], contests: readonly string[]) => ['matrix', agents, contests] as const,
  preflightAll: ['preflight'] as const,
  providers: ['providers'] as const,
  ojAccounts: ['oj-accounts'] as const,
  pushTargets: ['push-targets'] as const,
  pushDeliveries: ['push-deliveries'] as const,
  progress: (runId: string) => ['progress', runId] as const,
  logSlice: (runId: string, stream: 'stdout' | 'stderr', offset: number) => ['log-slice', runId, stream, offset] as const,
  replay: (runId: string, includeSources: boolean) => ['replay', runId, includeSources] as const,
  ranked: (scoring: string, groupBy: string) => ['ranked', scoring, groupBy] as const,
  race: (runIds: readonly string[], scoring: string) => ['race', runIds, scoring] as const,
  coverage: ['coverage'] as const,
};

export function invalidateConfigGraph(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.catalogAll }),
    client.invalidateQueries({ queryKey: queryKeys.matrixAll }),
    client.invalidateQueries({ queryKey: queryKeys.preflightAll }),
    client.invalidateQueries({ queryKey: queryKeys.coverage }),
    client.invalidateQueries({ queryKey: queryKeys.agentItemAll }),
    client.invalidateQueries({ queryKey: queryKeys.contestItemAll }),
  ]);
}

export function invalidateProviderGraph(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.providers }),
    client.invalidateQueries({ queryKey: queryKeys.catalogAgents }),
    client.invalidateQueries({ queryKey: queryKeys.preflightAll }),
  ]);
}

export function invalidateOjAccountGraph(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.ojAccounts }),
    client.invalidateQueries({ queryKey: queryKeys.preflightAll }),
  ]);
}

export function invalidatePushGraph(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.pushTargets }),
    client.invalidateQueries({ queryKey: queryKeys.pushDeliveries }),
  ]);
}
