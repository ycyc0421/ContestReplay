import { Profiler } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { studioApi } from '@/lib/api';
import { RunLogs } from './run-logs';

describe('RunLogs', () => {
  it('mounts cleanly without triggering an infinite render loop while log request is pending', () => {
    const spy = vi.spyOn(studioApi, 'logSlice').mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let commits = 0;

    render(
      <QueryClientProvider client={client}>
        <Profiler id="run-logs" onRender={() => { commits += 1; }}>
          <RunLogs runId="11111111-1111-4111-8111-111111111111" running={false} />
        </Profiler>
      </QueryClientProvider>,
    );

    expect(screen.getByText('正在读取日志…')).toBeTruthy();
    expect(commits).toBeLessThanOrEqual(3);
    spy.mockRestore();
  });
});
