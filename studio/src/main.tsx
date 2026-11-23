import { StrictMode } from 'react';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, RouterProvider } from '@tanstack/react-router';
import { AppShell } from '@/components/app-shell';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 500, refetchOnWindowFocus: false } } });
const rootRoute = createRootRoute({ component: AppShell });

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/features/batches/dashboard-page'), 'DashboardPage'),
});

const newBatchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/batches/new',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.addAgent === 'string' && search.addAgent ? { addAgent: search.addAgent } : {}),
    ...(typeof search.addContest === 'string' && search.addContest ? { addContest: search.addContest } : {}),
  }),
  component: lazyRouteComponent(() => import('@/features/batches/new-batch-page'), 'NewBatchPage'),
});

const configsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/configs',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.tab === 'agents' || search.tab === 'contests' ? { tab: search.tab } : {}),
    ...(typeof search.q === 'string' && search.q ? { q: search.q } : {}),
    ...(search.drawer === 'new-agent' || search.drawer === 'new-contest' || search.drawer === 'edit-agent' || search.drawer === 'edit-contest'
      ? { drawer: search.drawer }
      : {}),
    ...(typeof search.path === 'string' && search.path ? { path: search.path } : {}),
  }),
  component: lazyRouteComponent(() => import('@/features/configs/configs-page'), 'ConfigsPage'),
});

const validateConnectionSearch = (search: Record<string, unknown>) => ({
  ...(search.tab === 'providers' || search.tab === 'oj' || search.tab === 'push' ? { tab: search.tab } : {}),
});

const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connections',
  validateSearch: validateConnectionSearch,
  component: lazyRouteComponent(() => import('@/features/providers/providers-page'), 'ProvidersPage'),
});

// Keep /providers as a seamless compatibility alias for bookmarks & links
const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/providers',
  validateSearch: validateConnectionSearch,
  component: lazyRouteComponent(() => import('@/features/providers/providers-page'), 'ProvidersPage'),
});

const resultsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/results',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.tab === 'standings' || search.tab === 'race' || search.tab === 'coverage' ? { tab: search.tab } : {}),
  }),
  component: lazyRouteComponent(() => import('@/features/results/results-page'), 'ResultsPage'),
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.view === 'live' || search.view === 'replay' || search.view === 'logs' ? { view: search.view } : {}),
  }),
  component: lazyRouteComponent(() => import('@/features/runs/run-page'), 'RunPage'),
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  newBatchRoute,
  configsRoute,
  connectionsRoute,
  providersRoute,
  resultsRoute,
  runRoute,
]);
const router = createRouter({ routeTree, defaultPreload: 'intent' });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
