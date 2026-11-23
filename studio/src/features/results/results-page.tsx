import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, BarChart3, Check, Flag, Grid3X3, Plus, Trophy, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import type { RankedResultsResponse } from '@studio-api';
import { studioApi } from '@/lib/api';
import { cn, formatDuration, formatNumber, shortId } from '@/lib/utils';
import { queryKeys } from '@/state/query-keys';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectItem } from '@/components/ui/select';
import { EmptyState } from '@/components/empty-state';
import { AnimatedPanel } from '@/design-system/motion';
import { SegmentedTabs } from '@/design-system/segmented-tabs';
import { GhostRace } from './ghost-race';
import { CoveragePanel } from './coverage-panel';

type ResultsTab = 'standings' | 'race' | 'coverage';
type RankedRow = RankedResultsResponse['groups'][number][number];
type Result = RankedRow['result'];
type RaceEntry = { result: Result };

const compatibilityKey = (result: Result) =>
  JSON.stringify([result.contest_id, result.data_version, result.contest_revision, result.protocol_id, result.protocol_version, result.protocol_sha256]);

function RaceToggle({ entry, selected, onToggle }: { entry: RaceEntry; selected: boolean; onToggle: (entry: RaceEntry) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={`${selected ? '移出' : '加入'}竞速 ${entry.result.agent_name ?? entry.result.agent_id}`}
      onClick={() => onToggle(entry)}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-[2px] border text-muted-foreground transition-colors hover:border-primary hover:text-primary',
        selected && 'border-primary bg-primary text-primary-foreground hover:text-primary-foreground',
      )}
    >
      {selected ? <Check className="size-4" /> : <Plus className="size-4" />}
    </button>
  );
}

export function ResultsPage() {
  const search = useSearch({ strict: false }) as { tab?: ResultsTab };
  const navigate = useNavigate();
  const tab: ResultsTab = search.tab === 'race' || search.tab === 'coverage' ? search.tab : 'standings';
  const setTab = (next: ResultsTab) => {
    void navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, tab: next }), replace: false } as never);
  };

  const [scoring, setScoring] = useState('auto');
  const [groupBy, setGroupBy] = useState<'revision' | 'model'>('revision');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: queryKeys.ranked(scoring, groupBy),
    queryFn: () => studioApi.ranked({ scoring: scoring === 'auto' ? undefined : scoring as 'icpc' | 'cf' | 'ioi' | 'last_ac', groupBy }),
  });
  const entries = useMemo(() => query.data?.groups.flatMap(group => group.flatMap(row => [row, ...(row.variants ?? [])])) ?? [], [query.data]);
  const selectedEntries = entries.filter(entry => selected.has(entry.result.run_id));
  const selectedSorted = useMemo(() => [...selected].sort(), [selected]);
  const race = useQuery({
    queryKey: queryKeys.race(selectedSorted, scoring),
    queryFn: () => studioApi.race(selectedSorted, scoring === 'auto' ? undefined : scoring as 'icpc' | 'cf' | 'ioi' | 'last_ac'),
    enabled: tab === 'race' && selected.size > 0,
  });

  const toggleRace = (entry: RaceEntry) => {
    if (selected.has(entry.result.run_id)) {
      setSelected(previous => { const next = new Set(previous); next.delete(entry.result.run_id); return next; });
      return;
    }
    if (selected.size >= 8) { toast.error('一次竞速最多选择 8 个运行'); return; }
    const first = entries.find(item => selected.has(item.result.run_id));
    if (first && compatibilityKey(first.result) !== compatibilityKey(entry.result)) {
      toast.error('只能选择同一 Contest、数据版本与评测协议的运行', { description: '不同 Revision 的 Agent 可以比较，不同比赛输入不能混入同一竞速。' });
      return;
    }
    setSelected(previous => new Set(previous).add(entry.result.run_id));
  };

  const groups = query.data?.groups ?? [];

  return <>
    <PageHeader
      eyebrow="03 · 结果分析"
      title="结果分析"
      description="按 Revision 或模型主代表查看成绩，并在同一赛时轴上重放多个 Agent 的解题节奏。"
      actions={selected.size > 0 ? (
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setSelected(new Set())}><X className="size-4" />清空 {selected.size}</Button>
          <Button onClick={() => setTab('race')}><Flag className="size-4" />开始 Ghost Racing</Button>
        </div>
      ) : undefined}
    />

    <div className="mb-5 flex flex-col gap-3 border-b pb-4 xl:flex-row xl:items-center xl:justify-between">
      <SegmentedTabs
        id="results-tab"
        panelIdPrefix="results-panel"
        ariaLabel="结果分析视图"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'standings', label: '排行榜', icon: Trophy },
          { value: 'race', label: 'Ghost Racing', icon: Users, count: selected.size > 0 ? selected.size : undefined },
          { value: 'coverage', label: '覆盖率', icon: Grid3X3 },
        ]}
      />
      {tab !== 'coverage' && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={scoring} onValueChange={setScoring}>
            <SelectItem value="auto">场次默认计分</SelectItem>
            <SelectItem value="icpc">ICPC 罚时</SelectItem>
            <SelectItem value="cf">CF 积分</SelectItem>
            <SelectItem value="ioi">IOI 部分分</SelectItem>
            <SelectItem value="last_ac">最后 AC 时间</SelectItem>
          </Select>
          <Select value={groupBy} onValueChange={value => setGroupBy(value as 'revision' | 'model')}>
            <SelectItem value="revision">按完整 Revision</SelectItem>
            <SelectItem value="model">模型主代表 + 变体</SelectItem>
          </Select>
        </div>
      )}
    </div>

    <AnimatedPanel panelKey={tab} role="tabpanel" id={`results-panel-${tab}`} ariaLabelledBy={`results-tab-tab-${tab}`}>
      {tab === 'standings' && <>
        {query.isLoading ? <div className="skeleton h-[480px] rounded-card border bg-card" />
          : query.isError ? <Card><EmptyState icon={BarChart3} title="无法读取排名" description={(query.error as Error).message} action={<Button variant="secondary" onClick={() => void query.refetch()}>重试</Button>} /></Card>
          : groups.length === 0 ? <Card><EmptyState icon={Trophy} title="还没有可排名的结果" description="有效完赛后，结果会按 Contest、协议和配置 Revision 分组。作废与损坏运行会单独列出，不会混入排名。" action={<Button asChild><Link to="/batches/new">创建评测批次<ArrowUpRight className="size-4" /></Link></Button>} /></Card>
          : <div className="space-y-6">
              {groups.map((rows, groupIndex) => {
                const first = rows[0]!.result;
                return (
                  <Card key={`${first.contest_id}-${first.contest_revision}-${groupIndex}`} className="overflow-hidden">
                    <div className="flex flex-col gap-2 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="text-[11px] font-medium text-primary">赛事分组 #{String(groupIndex + 1).padStart(2, '0')}</div>
                        <h2 className="mt-0.5 text-sm font-semibold">{first.contest_title ?? first.contest_id}</h2>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{first.contest_id} · 数据 v{first.data_version} · {first.protocol_id} v{first.protocol_version}</p>
                      </div>
                      <Badge>{rows[0]!.scoring.mode}</Badge>
                    </div>
                    <div className="scrollbar-thin overflow-auto">
                      <table className="w-full min-w-[1000px] text-left text-xs">
                        <thead className="bg-muted/35 text-xs font-medium text-muted-foreground">
                          <tr>
                            <th className="w-12 px-4 py-3">名次</th>
                            <th>Agent / 模型</th>
                            <th>得分</th>
                            <th>通过题数</th>
                            <th>次要指标</th>
                            <th>耗时 / 模型等待</th>
                            <th>推理强度 / 速度</th>
                            <th className="px-4 text-right">竞速 / 运行</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {rows.map(row => {
                            const result = row.result;
                            const variants = row.variants ?? [];
                            return (
                              <tr key={result.run_id} className="align-top">
                                <td className="px-4 py-4 font-mono text-lg">{row.rank ?? '—'}</td>
                                <td className="py-4">
                                  <div className="font-medium">{result.agent_name ?? result.agent_id}</div>
                                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{result.agent_id} · {shortId(result.agent_revision)}</div>
                                  <div className="mt-1 text-[10px] text-muted-foreground">{result.model.requested}{result.model.vendor ? ` · ${result.model.vendor}` : ''}</div>
                                  {variants.length > 0 && (
                                    <details className="mt-3 border-l pl-3">
                                      <summary className="cursor-pointer text-[10px] text-primary">展开 {variants.length} 个配置变体</summary>
                                      <div className="mt-2 space-y-2">
                                        {variants.map(variant => (
                                          <div key={variant.result.run_id} className="flex items-center gap-2">
                                            <div className="min-w-0 flex-1">
                                              <div>{variant.result.agent_name ?? variant.result.agent_id}</div>
                                              <div className="font-mono text-[9px] text-muted-foreground">{variant.result.model.reasoning_effort ?? 'default'} · {variant.result.model.speed_tier ?? 'standard'} · {formatNumber(variant.scoring.primary)}</div>
                                            </div>
                                            <RaceToggle entry={variant} selected={selected.has(variant.result.run_id)} onToggle={toggleRace} />
                                          </div>
                                        ))}
                                      </div>
                                    </details>
                                  )}
                                </td>
                                <td className="py-4">
                                  <div className="font-mono text-sm font-semibold">{formatNumber(row.scoring.primary)}</div>
                                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{formatNumber(result.score)} / {formatNumber(result.max_score)} 原始分</div>
                                </td>
                                <td className="py-4 font-mono">{row.scoring.solved}</td>
                                <td className="py-4 font-mono">{formatNumber(row.scoring.secondary)}{row.scoring.penalty_minutes !== undefined ? ' min' : ''}</td>
                                <td className="py-4">
                                  <div className="font-mono">{formatDuration(row.finish_ms, true)}</div>
                                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{result.telemetry ? `模型等待 ${formatDuration(result.telemetry.model_wait_ms, true)}` : '—'}</div>
                                </td>
                                <td className="py-4">
                                  <div className="font-mono text-[10px]">{result.model.reasoning_effort ?? 'default'}</div>
                                  <div className="mt-1"><Badge>{result.model.speed_tier ?? 'standard'}</Badge></div>
                                </td>
                                <td className="px-4 py-4">
                                  <div className="flex justify-end gap-1">
                                    <RaceToggle entry={row} selected={selected.has(result.run_id)} onToggle={toggleRace} />
                                    <Button variant="ghost" size="icon" asChild aria-label={`查看 ${result.agent_id} 运行`}>
                                      <Link to="/runs/$runId" params={{ runId: result.run_id }}><ArrowUpRight className="size-4" /></Link>
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                );
              })}
            </div>}
        {query.data && query.data.omitted_runs.length > 0 && (
          <Card className="mt-5 border-warning/40 p-4">
            <div className="text-xs font-medium text-warning">{query.data.omitted_runs.length} 个运行未纳入排名</div>
            <div className="mt-2 space-y-1 font-mono text-[10px] text-muted-foreground">
              {query.data.omitted_runs.map(item => <div key={item.run_id}>{shortId(item.run_id)} · {item.reason.replaceAll('_', ' ')}</div>)}
            </div>
          </Card>
        )}
      </>}

      {tab === 'race' && (
        selected.size === 0
          ? <Card><EmptyState icon={Users} title="先选择同场次的运行" description="在排行榜中点击每行的 +，选择 1–8 个相同 Contest、数据版本和评测协议的 Agent 运行。" action={<Button onClick={() => setTab('standings')}>返回排行榜</Button>} /></Card>
          : race.isLoading ? <div className="skeleton h-[560px] rounded-card border bg-card" />
          : race.isError || !race.data ? <Card><EmptyState icon={Flag} title="无法构建 Ghost Racing" description={(race.error as Error)?.message ?? '所选运行不兼容'} action={<Button variant="secondary" onClick={() => void race.refetch()}>重试</Button>} /></Card>
          : <GhostRace race={race.data} />
      )}

      {tab === 'coverage' && <CoveragePanel />}
    </AnimatedPanel>

    {selectedEntries.length > 0 && tab !== 'race' && (
      <div className="mt-5 border-l-2 border-primary bg-card px-4 py-3 text-xs text-muted-foreground">
        已选择 {selectedEntries.map(entry => entry.result.agent_name ?? entry.result.agent_id).join('、')}，将使用相同赛时轴比较。
      </div>
    )}
  </>;
}
