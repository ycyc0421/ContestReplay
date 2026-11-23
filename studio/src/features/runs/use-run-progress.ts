import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runProgressSchema, runStatusEventSchema, type RunProgressContract } from '@studio-api';
import { studioApi } from '@/lib/api';
import { queryKeys } from '@/state/query-keys';
import {
  isTerminalProgress,
  type ProgressConnection,
  type TerminalQueueStatus,
} from '@/state/run-monitor.machine';

export type { ProgressConnection, TerminalQueueStatus };

export function useRunProgress(runId: string) {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ProgressConnection>('connecting');
  const [terminalStatus, setTerminalStatus] = useState<TerminalQueueStatus>();
  const lastSseSeq = useRef(0);
  const queryKey = useMemo(() => queryKeys.progress(runId), [runId]);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const seqAtStart = lastSseSeq.current;
      const result = await studioApi.progress(runId, signal);
      // A GET that started before a newer SSE snapshot must never roll the UI back.
      if (lastSseSeq.current !== seqAtStart) {
        return queryClient.getQueryData<RunProgressContract>(queryKey) ?? result;
      }
      return result;
    },
    refetchInterval: current => connection === 'live' || connection === 'closed' || Boolean(terminalStatus) || isTerminalProgress(current.state.data) ? false : 4_000,
  });

  useEffect(() => {
    setTerminalStatus(undefined);
    if (typeof EventSource === 'undefined') {
      setConnection('polling');
      return;
    }
    let disposed = false;
    let terminalClosed = false;
    setConnection('connecting');
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    source.addEventListener('open', () => { if (!disposed && !terminalClosed) setConnection('live'); });
    source.addEventListener('progress', event => {
      if (disposed || terminalClosed) return;
      try {
        const progress = runProgressSchema.parse(JSON.parse((event as MessageEvent).data));
        lastSseSeq.current += 1;
        void queryClient.cancelQueries({ queryKey });
        queryClient.setQueryData(queryKey, progress);
        setConnection('live');
        if (isTerminalProgress(progress)) {
          terminalClosed = true;
          source.close();
          setConnection('closed');
          void queryClient.invalidateQueries({ queryKey: queryKeys.batches });
        }
      } catch {
        setConnection('polling');
      }
    });
    source.addEventListener('status', event => {
      if (disposed || terminalClosed) return;
      try {
        const parsed = runStatusEventSchema.parse(JSON.parse((event as MessageEvent).data));
        terminalClosed = true;
        setTerminalStatus({ status: parsed.status, ...(parsed.reason ? { reason: parsed.reason } : {}) });
        source.close();
        setConnection('closed');
        void queryClient.invalidateQueries({ queryKey: queryKeys.batches });
        if (!isTerminalProgress(queryClient.getQueryData<RunProgressContract>(queryKey))) {
          void queryClient.invalidateQueries({ queryKey });
        }
      } catch {
        setConnection('polling');
      }
    });
    source.addEventListener('error', () => { if (!disposed && !terminalClosed) setConnection('polling'); });
    return () => { disposed = true; source.close(); };
  }, [runId, queryClient, queryKey]);

  return { ...query, connection, terminalStatus };
}
