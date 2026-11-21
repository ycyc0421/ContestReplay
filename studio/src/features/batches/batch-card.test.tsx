import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { BatchSummary } from '@studio-api';
import { BatchCard } from './batch-card';
import { TooltipProvider } from '@/components/ui/tooltip';

const batch: BatchSummary = {
  id: '8bd084e4-96b2-4b4b-8d8d-985c17b84c46', created_at: '2025-01-01T08:00:00.000Z', jobs: [{
    status: 'completed', run_id: 'f2cb5714-c0f1-4bfa-8be3-7c4825750985', agent_id: 'codex-high',
    agent_revision: 'a'.repeat(64), contest_id: 'demo-final', data_version: 1, harness: 'codex',
  }],
};
function renderCard() {
  const client = new QueryClient();
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/', component: () => <BatchCard batch={batch} busy={false} /> });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(<QueryClientProvider client={client}><TooltipProvider><RouterProvider router={router} /></TooltipProvider></QueryClientProvider>);
}
describe('BatchCard', () => {
  it('shows a concise batch summary', async () => { renderCard(); expect(await screen.findByText('8bd084e4')).toBeInTheDocument(); expect(screen.getByText((_, el) => el?.textContent === '1 / 1')).toBeInTheDocument(); expect(screen.queryByText('codex-high')).not.toBeInTheDocument(); });
  it('expands job details without losing batch context', async () => { renderCard(); await userEvent.click(await screen.findByRole('button', { expanded: false })); expect(screen.getByText('codex-high')).toBeInTheDocument(); expect(screen.getByText('demo-final')).toBeInTheDocument(); expect(screen.getByLabelText('导出已完赛结果')).toHaveAttribute('href', `/api/batches/${batch.id}/results`); });
});
