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
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: lazyRouteComponent(() => import('@/features/batches/dashboard-page'), 'DashboardPage') });
const newBatchRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches/new', component: lazyRouteComponent(() => import('@/features/batches/new-batch-page'), 'NewBatchPage') });
const configsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/configs', component: lazyRouteComponent(() => import('@/features/configs/configs-page'), 'ConfigsPage') });
const providersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/providers', component: lazyRouteComponent(() => import('@/features/providers/providers-page'), 'ProvidersPage') });
const runRoute = createRoute({ getParentRoute: () => rootRoute, path: '/runs/$runId', component: lazyRouteComponent(() => import('@/features/runs/run-page'), 'RunPage') });
const routeTree = rootRoute.addChildren([dashboardRoute, newBatchRoute, configsRoute, providersRoute, runRoute]);
const router = createRouter({ routeTree, defaultPreload: 'intent' });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }

createRoot(document.getElementById('root')!).render(<StrictMode><MotionConfig reducedMotion="user"><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></MotionConfig></StrictMode>);
