import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runProgressSchema, runStatusEventSchema } from '@studio-api';
import { studioApi } from '@/lib/api';

export type ProgressConnection = 'connecting' | 'live' | 'polling' | 'closed';

export function useRunProgress(runId: string) {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ProgressConnection>('connecting');
  const query = useQuery({
    queryKey: ['progress', runId],
    queryFn: () => studioApi.progress(runId),
    refetchInterval: 4_000,
  });

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setConnection('polling');
      return;
    }
    setConnection('connecting');
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.addEventListener('open', () => setConnection('live'));
    source.addEventListener('progress', event => {
      try {
        const progress = runProgressSchema.parse(JSON.parse((event as MessageEvent).data));
        queryClient.setQueryData(['progress', runId], progress);
        setConnection('live');
        if (progress.status === 'completed' || progress.status === 'void') {
          source.close();
          setConnection('closed');
          void queryClient.invalidateQueries({ queryKey: ['batches'] });
        }
      } catch {
        setConnection('polling');
      }
    });
    source.addEventListener('status', event => {
      try {
        runStatusEventSchema.parse(JSON.parse((event as MessageEvent).data));
        source.close();
        setConnection('closed');
        void queryClient.invalidateQueries({ queryKey: ['batches'] });
      } catch {
        setConnection('polling');
      }
    });
    source.addEventListener('error', () => setConnection('polling'));
    return () => source.close();
  }, [runId, queryClient]);

  return { ...query, connection };
}
