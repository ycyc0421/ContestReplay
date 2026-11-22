import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Grid3X3 } from 'lucide-react';
import { studioApi } from '@/lib/api';
import { formatNumber } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';

export function CoveragePanel() {
  const query = useQuery({ queryKey: ['coverage'], queryFn: studioApi.coverage, refetchInterval: 5_000 });
  const cells = query.data?.cells ?? [];
  const completed = cells.filter(cell => cell.completed_count > 0).length;
  const attention = cells.filter(cell => cell.void_count > 0 || cell.latest_status === 'interrupted').length;
  if (query.isLoading) return <div className="skeleton h-96 border bg-card" />;
  if (query.isError) return <Card><EmptyState icon={Grid3X3} title="无法读取覆盖率" description={(query.error as Error).message} action={<Button variant="secondary" onClick={() => void query.refetch()}>重试</Button>} /></Card>;
  return <div className="space-y-5">
    <Card className="grid grid-cols-3"><div className="p-4"><div className="font-mono text-[9px] text-muted-foreground">TRACKED CELLS</div><div className="mt-2 font-mono text-2xl">{cells.length}</div></div><div className="border-l p-4"><div className="font-mono text-[9px] text-muted-foreground">COMPLETED</div><div className="mt-2 font-mono text-2xl">{completed}</div></div><div className="border-l p-4"><div className="font-mono text-[9px] text-muted-foreground">ATTENTION</div><div className="mt-2 font-mono text-2xl">{attention}</div></div></Card>
    {cells.length === 0 ? <Card><EmptyState icon={Grid3X3} title="还没有执行记录" description="启动批次后，这里会按 Agent Revision × Contest 数据版本汇总有效完赛、作废与最佳成绩。" /></Card> : <Card className="overflow-hidden"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">执行覆盖档案</h2><p className="mt-1 text-[11px] text-muted-foreground">不同 Agent Revision 与 Contest 数据版本独立计数，不会静默混合。</p></div><div className="overflow-auto scrollbar-thin"><table className="w-full min-w-[850px] text-left text-xs"><thead className="bg-muted/40 font-mono text-[9px] text-muted-foreground"><tr><th className="px-4 py-3">Agent / revision</th><th>Contest / data</th><th>有效完赛</th><th>作废</th><th>最佳成绩</th><th>最近状态</th><th className="px-4 text-right">运行</th></tr></thead><tbody className="divide-y">{cells.map(cell => <tr key={`${cell.agent_id}-${cell.agent_revision}-${cell.contest_id}-${cell.data_version}`}><td className="px-4 py-3"><div className="font-medium">{cell.agent_id}</div><div className="mt-1 font-mono text-[9px] text-muted-foreground">{cell.agent_revision.slice(0, 12)}</div></td><td><div>{cell.contest_id}</div><div className="mt-1 font-mono text-[9px] text-muted-foreground">data v{cell.data_version}</div></td><td className="font-mono">{cell.completed_count}</td><td className={cell.void_count ? 'font-mono text-danger' : 'font-mono'}>{cell.void_count}</td><td className="font-mono">{cell.best_score !== undefined ? `${formatNumber(cell.best_score)} / ${formatNumber(cell.max_score ?? 0)}` : '—'}</td><td><StatusBadge status={cell.latest_status} /></td><td className="px-4 text-right">{cell.latest_run_id ? <Button variant="ghost" size="icon" asChild aria-label={`查看 ${cell.agent_id} 最近运行`}><Link to="/runs/$runId" params={{ runId: cell.latest_run_id }}><ArrowUpRight className="size-4" /></Link></Button> : '—'}</td></tr>)}</tbody></table></div></Card>}
  </div>;
}
