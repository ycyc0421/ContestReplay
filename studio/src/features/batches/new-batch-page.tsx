import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronDown, Grid3X3, List, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import type { CatalogAgent, CatalogContest } from '@studio-api';
import { studioApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { queryKeys } from '@/state/query-keys';
import {
  batchComposerReducer,
  cellKey,
  createInitialBatchComposerState,
  parseCell,
  sanitizeBatchDraft,
  type BatchDraft,
} from '@/state/batch-composer.machine';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AnimatedPanel, SPRING_INDICATOR } from '@/design-system/motion';
import { SegmentedTabs } from '@/design-system/segmented-tabs';

const stages = [['catalog', '选择配置'], ['matrix', '调整矩阵'], ['review', '核对启动']] as const;
const draftKey = 'cr.batch.draft';

function readDraft(): BatchDraft {
  try {
    const raw = JSON.parse(sessionStorage.getItem(draftKey) ?? '{"agents":[],"contests":[],"cells":[]}') as unknown;
    return sanitizeBatchDraft(raw);
  } catch {
    return { agents: [], contests: [], cells: [] };
  }
}

function findUniqueCatalogMatch<T extends { path: string }>(entries: T[], requestedPath: string): T | undefined {
  const exact = entries.find(item => item.path === requestedPath);
  if (exact) return exact;
  // Fallback for legacy absolute paths only when unambiguous
  const suffixMatches = entries.filter(item => requestedPath.endsWith(`/${item.path}`));
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

function Mark({ selected }: { selected: boolean }) {
  return (
    <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-[2px] border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/35')}>
      {selected && <Check className="size-3" />}
    </span>
  );
}

function FilterMenu({ count, onReset, children }: { count: number; onReset: () => void; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn(count && 'text-primary')}>
          <SlidersHorizontal className="size-3.5" />筛选{count > 0 && <span className="ml-0.5 font-mono text-[10px]">{count}</span>}<ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="mb-4 flex items-center justify-between"><span className="text-xs font-semibold">筛选条件</span><button className="text-[11px] text-muted-foreground hover:text-primary" onClick={onReset}>重置</button></div>
        <div className="space-y-4">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

function AgentList({ items, selected, onToggle }: { items: CatalogAgent[]; selected: Set<string>; onToggle: (path: string) => void }) {
  if (!items.length) return <p className="px-4 py-12 text-center text-xs text-muted-foreground">没有匹配的 Agent</p>;
  return (
    <div className="divide-y">
      {items.map(agent => {
        const distinctName = Boolean(agent.name && agent.name.trim() && agent.name.trim() !== agent.id);
        return (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected.has(agent.path)}
            key={agent.path}
            disabled={!agent.valid}
            onClick={() => onToggle(agent.path)}
            className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-55"
          >
            <Mark selected={selected.has(agent.path)} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{distinctName ? agent.name : agent.id}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{agent.harness}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {distinctName ? `${agent.id} · ${agent.model}` : agent.model}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <span>{agent.vendor ?? '未标厂商'}</span>
                {!agent.provider_available && <span className="text-warning">Provider 未就绪</span>}
                {!agent.valid && <span className="text-danger" title={agent.issues.join('\n')}>配置无效</span>}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ContestList({ items, selected, onToggle }: { items: CatalogContest[]; selected: Set<string>; onToggle: (path: string) => void }) {
  if (!items.length) return <p className="px-4 py-12 text-center text-xs text-muted-foreground">没有匹配的 Contest</p>;
  return (
    <div className="divide-y">
      {items.map(contest => (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected.has(contest.path)}
          key={contest.path}
          disabled={!contest.valid}
          onClick={() => onToggle(contest.path)}
          className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-55"
        >
          <Mark selected={selected.has(contest.path)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{contest.title}</span>
              <Badge>v{contest.data_version}</Badge>
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{contest.id}</div>
            <div className="mt-1.5 flex gap-2 text-[10px] text-muted-foreground">
              <span>{contest.problem_count} 题</span>
              <span>{contest.judge_kind}</span>
              <span>{Math.round(contest.time_limit_ms / 60_000)} 分钟</span>
              {!contest.valid && <span className="text-danger" title={contest.issues.join('\n')}>配置无效</span>}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function NewBatchPage() {
  const search = useSearch({ strict: false }) as { addAgent?: string; addContest?: string };
  const [composer, dispatch] = useReducer(batchComposerReducer, undefined, () => createInitialBatchComposerState(readDraft()));
  const [agentSearch, setAgentSearch] = useState('');
  const [contestSearch, setContestSearch] = useState('');
  const [vendor, setVendor] = useState('all');
  const [harness, setHarness] = useState('all');
  const [judge, setJudge] = useState('all');
  const [agentsOnlySelected, setAgentsOnlySelected] = useState(false);
  const [contestsOnlySelected, setContestsOnlySelected] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const agentsQuery = useQuery({ queryKey: queryKeys.catalogAgents, queryFn: studioApi.catalogAgents, refetchOnMount: 'always' });
  const contestsQuery = useQuery({ queryKey: queryKeys.catalogContests, queryFn: studioApi.catalogContests, refetchOnMount: 'always' });
  const batches = useQuery({ queryKey: queryKeys.batches, queryFn: studioApi.batches });

  const selectedAgents = useMemo(() => new Set(composer.selectedAgents), [composer.selectedAgents]);
  const selectedContests = useMemo(() => new Set(composer.selectedContests), [composer.selectedContests]);
  const selectedCells = useMemo(() => new Set(composer.selectedCells), [composer.selectedCells]);
  const agentPaths = useMemo(() => [...composer.selectedAgents].sort(), [composer.selectedAgents]);
  const contestPaths = useMemo(() => [...composer.selectedContests].sort(), [composer.selectedContests]);

  const matrix = useQuery({
    queryKey: queryKeys.matrix(agentPaths, contestPaths),
    queryFn: () => studioApi.matrix(agentPaths, contestPaths),
    enabled: composer.stage !== 'catalog' && agentPaths.length > 0 && contestPaths.length > 0,
  });
  const compatibility = useMemo(() => new Map(matrix.data?.cells.map(cell => [cellKey(cell.agent, cell.contest), cell])), [matrix.data]);
  const agents = agentsQuery.data?.agents ?? [];
  const contests = contestsQuery.data?.contests ?? [];
  const selectedAgentEntries = agents.filter(agent => selectedAgents.has(agent.path));
  const selectedContestEntries = contests.filter(contest => selectedContests.has(contest.path));

  // Reconcile draft strictly after fresh mount fetch succeeds (never prune against stale cache or errors)
  useEffect(() => {
    if (!agentsQuery.isFetchedAfterMount || agentsQuery.isFetching || !agentsQuery.isSuccess) return;
    dispatch({ type: 'RECONCILE_AGENTS', validPaths: new Set(agentsQuery.data.agents.filter(a => a.valid).map(a => a.path)) });
  }, [agentsQuery.data, agentsQuery.isFetchedAfterMount, agentsQuery.isFetching, agentsQuery.isSuccess]);
  useEffect(() => {
    if (!contestsQuery.isFetchedAfterMount || contestsQuery.isFetching || !contestsQuery.isSuccess) return;
    dispatch({ type: 'RECONCILE_CONTESTS', validPaths: new Set(contestsQuery.data.contests.filter(c => c.valid).map(c => c.path)) });
  }, [contestsQuery.data, contestsQuery.isFetchedAfterMount, contestsQuery.isFetching, contestsQuery.isSuccess]);
  useEffect(() => {
    sessionStorage.setItem(draftKey, JSON.stringify({
      agents: composer.selectedAgents,
      contests: composer.selectedContests,
      cells: composer.selectedCells,
    }));
  }, [composer.selectedAgents, composer.selectedContests, composer.selectedCells]);
  useEffect(() => {
    if (!matrix.data) return;
    dispatch({ type: 'FILTER_INCOMPATIBLE', compatibleMap: new Map(matrix.data.cells.map(cell => [cellKey(cell.agent, cell.contest), cell.compatible])) });
  }, [matrix.data]);

  // Consume URL ?addAgent=... and ?addContest=... independently strictly after fresh catalog refetch succeeds
  useEffect(() => {
    const legacyRaw = sessionStorage.getItem('cr.batch.pending');
    let legacyPending: { kind: 'agent' | 'contest'; path: string } | null = null;
    if (legacyRaw) {
      try {
        const parsed = JSON.parse(legacyRaw) as { kind: 'agent' | 'contest'; path: string };
        if (parsed?.path) legacyPending = parsed;
      } catch {
        sessionStorage.removeItem('cr.batch.pending');
      }
    }

    const reqAgent = search.addAgent ?? (legacyPending?.kind === 'agent' ? legacyPending.path : undefined);
    const reqContest = search.addContest ?? (legacyPending?.kind === 'contest' ? legacyPending.path : undefined);
    if (!reqAgent && !reqContest) return;

    const agentsReady = agentsQuery.isFetchedAfterMount && !agentsQuery.isFetching && agentsQuery.isSuccess;
    const contestsReady = contestsQuery.isFetchedAfterMount && !contestsQuery.isFetching && contestsQuery.isSuccess;

    let consumedAgent = false;
    let consumedContest = false;

    if (reqAgent && agentsReady) {
      consumedAgent = true;
      const entry = findUniqueCatalogMatch(agents, reqAgent);
      if (entry?.valid) {
        const validContests = contestsReady ? new Set(contests.filter(c => c.valid).map(c => c.path)) : undefined;
        dispatch({ type: 'ADD_PENDING', kind: 'agent', path: entry.path, validOpposite: validContests });
      } else {
        toast.warning('未能将指定 Agent 加入批次', { description: entry ? '该 Agent 当前配置无效' : `未找到 ${reqAgent}` });
      }
    }

    if (reqContest && contestsReady) {
      consumedContest = true;
      const entry = findUniqueCatalogMatch(contests, reqContest);
      if (entry?.valid) {
        const validAgents = agentsReady ? new Set(agents.filter(a => a.valid).map(a => a.path)) : undefined;
        dispatch({ type: 'ADD_PENDING', kind: 'contest', path: entry.path, validOpposite: validAgents });
      } else {
        toast.warning('未能将指定 Contest 加入批次', { description: entry ? '该 Contest 当前配置无效' : `未找到 ${reqContest}` });
      }
    }

    if (consumedAgent || consumedContest) {
      if ((consumedAgent && search.addAgent) || (consumedContest && search.addContest)) {
        void navigate({
          search: (prev: Record<string, unknown>) => {
            const next = { ...prev };
            if (consumedAgent) delete next.addAgent;
            if (consumedContest) delete next.addContest;
            return next;
          },
          replace: true,
        } as never);
      }
      if ((consumedAgent && legacyPending?.kind === 'agent') || (consumedContest && legacyPending?.kind === 'contest')) {
        sessionStorage.removeItem('cr.batch.pending');
      }
    }
  }, [
    search.addAgent, search.addContest,
    agentsQuery.data, contestsQuery.data,
    agentsQuery.isFetchedAfterMount, contestsQuery.isFetchedAfterMount,
    agentsQuery.isFetching, contestsQuery.isFetching,
    agentsQuery.isSuccess, contestsQuery.isSuccess,
    agents, contests, navigate,
  ]);

  const toggleRow = (agent: string) => {
    const keys = contestPaths.map(contest => cellKey(agent, contest)).filter(key => compatibility.get(key)?.compatible);
    dispatch({ type: 'TOGGLE_CELL_GROUP', keys });
  };
  const toggleColumn = (contest: string) => {
    const keys = agentPaths.map(agent => cellKey(agent, contest)).filter(key => compatibility.get(key)?.compatible);
    dispatch({ type: 'TOGGLE_CELL_GROUP', keys });
  };

  const agentFilterCount = Number(vendor !== 'all') + Number(harness !== 'all');
  const filteredAgents = agents.filter(agent =>
    (!agentSearch || `${agent.id} ${agent.name ?? ''} ${agent.model} ${agent.vendor ?? ''}`.toLowerCase().includes(agentSearch.toLowerCase())) &&
    (vendor === 'all' || agent.vendor === vendor) &&
    (harness === 'all' || agent.harness === harness) &&
    (!agentsOnlySelected || selectedAgents.has(agent.path)),
  );
  const filteredContests = contests.filter(contest =>
    (!contestSearch || `${contest.id} ${contest.title}`.toLowerCase().includes(contestSearch.toLowerCase())) &&
    (judge === 'all' || contest.judge_kind === judge) &&
    (!contestsOnlySelected || selectedContests.has(contest.path)),
  );

  const selectedPairs = useMemo(() => composer.selectedCells.map(parseCell).map(([agent, contest]) => ({ agent, contest })), [composer.selectedCells]);
  const preview = useMutation({
    mutationFn: async (gen: number) => {
      const result = await studioApi.planCells(selectedPairs.map(cell => ({ ...cell, ...(composer.repeats > 1 ? { repeats: composer.repeats } : {}) })));
      return { gen, result };
    },
    onSuccess: ({ gen, result }) => dispatch({ type: 'PLAN_READY', plan: result, gen }),
    onError: (error: Error) => toast.error('计划生成失败', { description: error.message }),
  });
  const preflightCheck = useMutation({
    mutationFn: async (gen: number) => {
      const report = await studioApi.preflight(selectedPairs);
      return { gen, report };
    },
    onSuccess: ({ gen, report }) => dispatch({ type: 'SET_PREFLIGHT', preflight: report, gen }),
    onError: (error: Error) => toast.error('Preflight 执行失败', { description: error.message }),
  });
  const planValid = Boolean(composer.plan && composer.planGen === composer.selectionGen);
  const start = useMutation({
    mutationFn: () => {
      if (!composer.plan || composer.planGen !== composer.selectionGen) {
        return Promise.reject(new Error('选择已变更，请重新生成执行计划'));
      }
      return studioApi.startBatch(composer.plan.token, composer.concurrency);
    },
    onSuccess: async result => {
      sessionStorage.removeItem(draftKey);
      toast.success('批次已启动', { description: `批次 ${result.id.slice(0, 8)}` });
      await queryClient.invalidateQueries({ queryKey: queryKeys.batches });
      void navigate({ to: '/' });
    },
    onError: (error: Error) => toast.error('批次启动失败', { description: error.message }),
  });

  const goReview = () => {
    if (planValid) dispatch({ type: 'SET_STAGE', stage: 'review' });
    else preview.mutate(composer.selectionGen);
  };
  const ready = selectedCells.size > 0 && [...selectedCells].every(key => compatibility.get(key)?.compatible);
  const compatibleKeys = [...compatibility].filter(([, cell]) => cell.compatible).map(([key]) => key);
  const allSelected = compatibleKeys.length > 0 && compatibleKeys.every(key => selectedCells.has(key));
  const estimatedMs = composer.selectedCells.reduce((total, key) => total + (contests.find(contest => contest.path === parseCell(key)[1])?.time_limit_ms ?? 0), 0) * composer.repeats;
  const totalJobs = selectedCells.size * composer.repeats;
  const stageIndex = stages.findIndex(([id]) => id === composer.stage);

  return <>
    <Link to="/" className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"><ArrowLeft className="size-3.5" />返回运行总览</Link>
    <PageHeader eyebrow="02 · 新建批次" title="新建评测批次" description="先检索配置，再精修矩阵，最后锁定修订并启动执行计划。" />
    <ol className="mb-7 flex items-center border-y" aria-label="批次创建步骤">
      {stages.map(([id, label], index) => (
        <li key={id} className="flex-1">
          <button
            disabled={index >= stageIndex}
            onClick={() => dispatch({ type: 'SET_STAGE', stage: id })}
            className={cn('relative flex h-12 w-full items-center justify-center gap-2 text-xs text-muted-foreground disabled:cursor-default', index === stageIndex && 'font-medium text-foreground', index < stageIndex && 'text-foreground hover:bg-muted/30')}
          >
            {index === stageIndex && <motion.span layoutId="batch-stage" transition={SPRING_INDICATOR} className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
            <span className="font-mono text-[10px] opacity-65">0{index + 1}</span>{label}
          </button>
        </li>
      ))}
    </ol>

    <AnimatedPanel panelKey={composer.stage}>
      {composer.stage === 'catalog' && <>
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <Card className="overflow-hidden">
            <div className="border-b p-4">
              <div className="flex items-center justify-between">
                <div><h2 className="text-sm font-semibold">Agent 目录</h2><p className="mt-1 text-[11px] text-muted-foreground">{filteredAgents.length} 个结果 · {selectedAgents.size} 已选</p></div>
                <div className="flex items-center">
                  <Button variant="ghost" size="sm" className={cn(agentsOnlySelected && 'bg-muted text-primary')} onClick={() => setAgentsOnlySelected(value => !value)}>已选 {selectedAgents.size}</Button>
                  <Button variant="ghost" size="icon" aria-label="刷新 Agent 目录" onClick={() => void agentsQuery.refetch()}><RefreshCw className="size-3.5" /></Button>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <label className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-9" value={agentSearch} onChange={event => setAgentSearch(event.target.value)} placeholder="搜索模型或 Agent" aria-label="搜索 Agent" /></label>
                <FilterMenu count={agentFilterCount} onReset={() => { setVendor('all'); setHarness('all'); }}>
                  <Field label="模型厂商"><Select value={vendor} onValueChange={setVendor}><SelectItem value="all">全部厂商</SelectItem>{[...new Set(agents.map(agent => agent.vendor).filter((value): value is string => Boolean(value)))].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</Select></Field>
                  <Field label="Harness"><Select value={harness} onValueChange={setHarness}><SelectItem value="all">全部 Harness</SelectItem>{[...new Set(agents.map(agent => agent.harness))].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</Select></Field>
                </FilterMenu>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <div className="flex gap-1.5">{vendor !== 'all' && <Badge>{vendor}</Badge>}{harness !== 'all' && <Badge>{harness}</Badge>}</div>
                <button className="text-[11px] text-primary hover:underline" onClick={() => dispatch({ type: 'SELECT_AGENTS', paths: filteredAgents.filter(a => a.valid).map(a => a.path) })}>选择当前结果</button>
              </div>
            </div>
            <ScrollArea className="h-[390px]"><AgentList items={filteredAgents} selected={selectedAgents} onToggle={path => dispatch({ type: 'TOGGLE_AGENT', path })} /></ScrollArea>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b p-4">
              <div className="flex items-center justify-between">
                <div><h2 className="text-sm font-semibold">Contest 目录</h2><p className="mt-1 text-[11px] text-muted-foreground">{filteredContests.length} 个结果 · {selectedContests.size} 已选</p></div>
                <div className="flex items-center">
                  <Button variant="ghost" size="sm" className={cn(contestsOnlySelected && 'bg-muted text-primary')} onClick={() => setContestsOnlySelected(value => !value)}>已选 {selectedContests.size}</Button>
                  <Button variant="ghost" size="icon" aria-label="刷新 Contest 目录" onClick={() => void contestsQuery.refetch()}><RefreshCw className="size-3.5" /></Button>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <label className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-9" value={contestSearch} onChange={event => setContestSearch(event.target.value)} placeholder="搜索赛事或 Contest" aria-label="搜索 Contest" /></label>
                <FilterMenu count={Number(judge !== 'all')} onReset={() => setJudge('all')}>
                  <Field label="判题方式"><Select value={judge} onValueChange={setJudge}><SelectItem value="all">全部判题方式</SelectItem>{[...new Set(contests.map(contest => contest.judge_kind))].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</Select></Field>
                </FilterMenu>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <div>{judge !== 'all' && <Badge>{judge}</Badge>}</div>
                <button className="text-[11px] text-primary hover:underline" onClick={() => dispatch({ type: 'SELECT_CONTESTS', paths: filteredContests.filter(c => c.valid).map(c => c.path) })}>选择当前结果</button>
              </div>
            </div>
            <ScrollArea className="h-[390px]"><ContestList items={filteredContests} selected={selectedContests} onToggle={path => dispatch({ type: 'TOGGLE_CONTEST', path })} /></ScrollArea>
          </Card>
        </div>
        <div className="mt-3 flex justify-between text-xs text-muted-foreground">
          <span>无效配置会保留在目录中并说明原因。</span>
          <Link to="/configs" className="inline-flex items-center gap-1 text-primary hover:underline"><Plus className="size-3.5" />前往配置库创建</Link>
        </div>
      </>}

      {composer.stage === 'matrix' && (
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[11px] font-medium text-primary">执行矩阵</div>
              <h2 className="mt-0.5 text-sm font-semibold">{selectedAgents.size} 个 Agent × {selectedContests.size} 场 Contest</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">点击单元格精修；点击行/列标题批量切换。</p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="每格重复" hint="Pass@k" className="w-36">
                <Select value={String(composer.repeats)} onValueChange={value => dispatch({ type: 'SET_REPEATS', repeats: Number(value) })}>
                  {[1, 2, 3, 5, 10].map(value => <SelectItem key={value} value={String(value)}>{value} 次</SelectItem>)}
                </Select>
              </Field>
              <SegmentedTabs
                id="batch-matrix-view"
                size="sm"
                value={composer.view}
                onValueChange={view => dispatch({ type: 'SET_VIEW', view })}
                items={[
                  { value: 'matrix', label: '矩阵', icon: Grid3X3 },
                  { value: 'list', label: '任务列表', icon: List },
                ]}
              />
            </div>
          </div>
          {!selectedCells.size && !compatibleKeys.length && matrix.isLoading
            ? <div className="p-12 text-center text-xs text-muted-foreground">正在校验矩阵兼容性…</div>
            : <AnimatedPanel panelKey={composer.view}>
                {composer.view === 'matrix' ? (
                  <div className="scrollbar-thin overflow-auto p-4 sm:p-6">
                    <table className="mx-auto w-auto min-w-[560px] border-collapse text-left">
                      <thead>
                        <tr>
                          <th className="sticky left-0 z-10 w-52 border-b bg-card px-3 py-3">
                            <button className="text-xs font-medium text-muted-foreground hover:text-primary" onClick={() => dispatch({ type: 'SET_CELLS', keys: allSelected ? [] : compatibleKeys })}>
                              {allSelected ? '清空全部' : '全选兼容组合'}
                            </button>
                          </th>
                          {selectedContestEntries.map(contest => (
                            <th key={contest.path} className="min-w-36 border-b px-3 py-3 text-center">
                              <button onClick={() => toggleColumn(contest.path)} title="切换整列">
                                <span className="block truncate text-xs font-medium">{contest.title}</span>
                                <span className="mt-1 block font-mono text-[10px] font-normal text-muted-foreground">v{contest.data_version}</span>
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {selectedAgentEntries.map(agent => (
                          <tr key={agent.path}>
                            <th className="sticky left-0 z-10 border-b bg-card px-3 py-3">
                              <button onClick={() => toggleRow(agent.path)} className="text-left" title="切换整行">
                                <span className="block truncate text-xs font-medium">{agent.name ?? agent.id}</span>
                                <span className="mt-1 block font-mono text-[10px] font-normal text-muted-foreground">{agent.harness}</span>
                              </button>
                            </th>
                            {selectedContestEntries.map(contest => {
                              const key = cellKey(agent.path, contest.path);
                              const state = compatibility.get(key);
                              const selected = selectedCells.has(key);
                              const disabled = matrix.isLoading || state?.compatible === false;
                              return (
                                <td key={contest.path} className="border-b p-3 text-center">
                                  <button
                                    disabled={disabled}
                                    onClick={() => { if (!disabled) dispatch({ type: 'TOGGLE_CELL', agent: agent.path, contest: contest.path }); }}
                                    title={state?.reason ?? (selected ? '取消任务' : '选择任务')}
                                    aria-label={`${agent.id} × ${contest.title}`}
                                    aria-pressed={selected}
                                    className={cn('inline-flex size-9 items-center justify-center rounded-[2px] border transition-[background-color,border-color,transform] active:scale-95', selected ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted', disabled && 'cursor-not-allowed border-dashed opacity-30')}
                                  >
                                    {state?.compatible === false ? <X className="size-4" /> : selected ? <Check className="size-4" /> : <Plus className="size-3.5" />}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="divide-y">
                    {composer.selectedCells.map((key, index) => {
                      const [agentPath, contestPath] = parseCell(key);
                      const agent = agents.find(item => item.path === agentPath);
                      const contest = contests.find(item => item.path === contestPath);
                      return (
                        <div key={key} className="flex items-center gap-3 px-4 py-3">
                          <span className="w-7 font-mono text-[10px] text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">{agent?.name ?? agent?.id ?? agentPath} <span className="mx-1 text-muted-foreground">×</span> {contest?.title ?? contestPath}</div>
                            <div className="mt-1 font-mono text-[10px] text-muted-foreground">{agent?.harness} · v{contest?.data_version}</div>
                          </div>
                          <Button variant="ghost" size="icon" aria-label={`移除 ${agent?.id} × ${contest?.title}`} onClick={() => dispatch({ type: 'TOGGLE_CELL', agent: agentPath, contest: contestPath })}><X className="size-4" /></Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </AnimatedPanel>}
          {matrix.isError && <p className="border-t p-4 text-xs text-danger">{(matrix.error as Error).message}</p>}
        </Card>
      )}

      {composer.stage === 'review' && composer.plan && <>
        <Card className="overflow-hidden">
          <div className="border-b px-5 py-4">
            <div className="text-[11px] font-medium text-primary">修订已锁定</div>
            <h2 className="mt-0.5 text-sm font-semibold">执行计划 · {composer.plan.jobs.length} 个任务</h2>
            <p className="mt-1 text-xs text-muted-foreground">{composer.concurrency > 1 ? `${composer.concurrency} 路受控并行` : '串行执行'} · 理论最长队列时间约 {(estimatedMs / composer.concurrency / 3_600_000).toFixed(1)} 小时</p>
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
              <Field label="执行并发" hint="1–8" className="w-44">
                <Select value={String(composer.concurrency)} onValueChange={value => dispatch({ type: 'SET_CONCURRENCY', concurrency: Number(value) })}>
                  {[1, 2, 4, 8].map(value => <SelectItem key={value} value={String(value)}>{value === 1 ? '1 · 串行' : `${value} 路并行`}</SelectItem>)}
                </Select>
              </Field>
              <div className="pb-2 text-[11px] leading-5 text-muted-foreground">同一 OJ 账号仍互斥；并行度只控制本批次的 worker 数。</div>
              <Button type="button" variant="secondary" size="sm" loading={preflightCheck.isPending} onClick={() => preflightCheck.mutate(composer.selectionGen)}><ShieldCheck className="size-3.5" />运行 Preflight</Button>
            </div>
          </div>
          <ScrollArea className="max-h-[520px]">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-muted/45 text-xs font-medium text-muted-foreground">
                <tr><th className="px-5 py-3">序号</th><th>Agent / 修订</th><th>Contest</th><th className="px-5 text-right">数据版本</th></tr>
              </thead>
              <tbody className="divide-y">
                {composer.plan.jobs.map((job, index) => (
                  <tr key={`${job.agent_revision}-${job.contest_id}-${index}`}>
                    <td className="px-5 py-3.5 font-mono text-xs text-primary">{String(index + 1).padStart(2, '0')}</td>
                    <td className="py-3.5"><div>{job.agent_name ?? job.agent_id}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">{job.agent_revision.slice(0, 12)}</div></td>
                    <td>{job.contest_id}</td>
                    <td className="px-5 text-right font-mono text-xs text-muted-foreground">v{job.data_version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        </Card>

        {composer.preflight && (
          <Card className="mt-4 overflow-hidden">
            <div className="flex items-center gap-3 border-b px-4 py-3">
              {composer.preflight.ok ? <ShieldCheck className="size-4 text-primary" /> : <AlertTriangle className="size-4 text-warning" />}
              <div>
                <h2 className="text-sm font-semibold">{composer.preflight.ok ? 'Preflight 全部通过' : 'Preflight 发现需要处理的问题'}</h2>
                <p className="mt-1 text-[11px] text-muted-foreground">{composer.preflight.agents.length} Agents · {composer.preflight.contests.length} Contests · {composer.preflight.images.length} Images · {composer.preflight.compatibility.length} Cells</p>
              </div>
            </div>
            <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
              {[
                ...composer.preflight.agents.map(item => ({ key: `agent-${item.path}`, title: item.id ?? item.path, ok: item.ok && item.credential_ok, detail: item.credential_ok ? '凭据就绪' : '凭据不可用', issues: item.issues })),
                ...composer.preflight.contests.map(item => ({ key: `contest-${item.path}`, title: item.id ?? item.path, ok: item.ok && item.oj_ready, detail: `${item.judge_kind ?? 'judge'} · ${item.oj_ready ? 'OJ 就绪' : 'OJ 未就绪'}`, issues: [...new Set([...item.issues, ...(item.pdf?.issues ?? [])])] })),
                ...composer.preflight.images.map(item => ({ key: `image-${item.image}`, title: item.image, ok: item.ok, detail: item.harness, issues: item.error ? [item.error] : [] })),
                ...composer.preflight.compatibility.filter(item => !item.compatible).map(item => ({ key: `cell-${item.agent}-${item.contest}`, title: '不兼容组合', ok: false, detail: `${item.agent} × ${item.contest}`, issues: item.reason ? [item.reason] : [] })),
              ].map(item => (
                <div key={item.key} className="bg-card p-4">
                  <div className="flex items-center gap-2"><span className={item.ok ? 'size-1.5 rounded-full bg-primary' : 'size-1.5 rounded-full bg-warning'} /><span className="truncate text-xs font-medium" title={item.title}>{item.title}</span></div>
                  <div className="mt-1 text-[10px] text-muted-foreground">{item.detail}</div>
                  {item.issues.length > 0 && <ul className="mt-2 space-y-1 text-[10px] leading-4 text-warning">{item.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
                </div>
              ))}
            </div>
          </Card>
        )}
      </>}
    </AnimatedPanel>

    <Card className="sticky bottom-3 z-20 mt-6 border-t-2 border-t-primary p-4 shadow-[0_8px_30px_rgba(0,0,0,.08)]">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-5 text-xs">
          <div>
            <div className="text-[11px] text-muted-foreground">{composer.stage === 'catalog' ? '已选配置' : composer.stage === 'matrix' ? '已选组合' : '准备启动'}</div>
            <div className="mt-1 font-medium">{composer.stage === 'catalog' ? `${selectedAgents.size} Agents · ${selectedContests.size} Contests` : composer.repeats > 1 ? `${selectedCells.size} Cells · ${totalJobs} 个任务` : `${selectedCells.size} 个任务`}</div>
          </div>
          {composer.stage === 'review' && <span className="text-muted-foreground">{composer.concurrency > 1 ? `${composer.concurrency} 路并行` : '串行队列'}</span>}
        </div>
        <div className="flex items-center gap-2">
          {composer.stage !== 'catalog' && <Button variant="ghost" onClick={() => dispatch({ type: 'SET_STAGE', stage: composer.stage === 'review' ? 'matrix' : 'catalog' })}><ArrowLeft className="size-4" />{composer.stage === 'review' ? '返回矩阵' : '修改配置'}</Button>}
          {composer.stage === 'catalog' && <Button disabled={!selectedAgents.size || !selectedContests.size} onClick={() => dispatch({ type: 'SET_STAGE', stage: 'matrix' })}>调整矩阵<ArrowRight className="size-4" /></Button>}
          {composer.stage === 'matrix' && <Button disabled={!ready} loading={preview.isPending} onClick={goReview}>核对执行计划<ArrowRight className="size-4" /></Button>}
          {composer.stage === 'review' && <Button disabled={!planValid || batches.data?.busy} loading={start.isPending} onClick={() => start.mutate()}>确认并启动批次<ArrowRight className="size-4" /></Button>}
        </div>
      </div>
    </Card>
    {batches.data?.busy && <p className="mt-2 text-right text-[11px] text-warning">已有批次正在执行，请等待完成。</p>}
    {composer.stage === 'catalog' && <p className="mt-3 text-[11px] text-muted-foreground">配置目录仅展示元数据。选择草稿会保留在当前浏览器会话中。</p>}
  </>;
}
