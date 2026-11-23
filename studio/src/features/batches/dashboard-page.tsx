import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, AlertTriangle, ArrowUpRight, CheckCircle2, Layers3, Plus, RotateCw } from 'lucide-react';
import { motion } from 'motion/react';
import { studioApi } from '@/lib/api';
import { queryKeys } from '@/state/query-keys';
import { Card, PageHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Separator } from '@/components/ui/separator';
import { BatchCard } from './batch-card';

export function DashboardPage() {
  const query = useQuery({ queryKey: queryKeys.batches, queryFn: studioApi.batches, refetchInterval: 1200 });
  const batches = query.data?.batches ?? [];
  const jobs = batches.flatMap(b => b.jobs);
  const stats = [
    { label: '全部批次', value: batches.length, icon: Layers3, detail: '当前工作区' },
    { label: '正在运行', value: jobs.filter(j => j.status === 'running').length, icon: Activity, detail: query.data?.busy ? '队列执行中' : '队列空闲' },
    { label: '有效完赛', value: jobs.filter(j => j.status === 'completed').length, icon: CheckCircle2, detail: `共 ${jobs.length} 个任务` },
    { label: '需要关注', value: jobs.filter(j => ['void', 'interrupted'].includes(j.status)).length, icon: AlertTriangle, detail: '作废或中断' },
  ];
  return <>
    <PageHeader eyebrow="01 · 运行总览" title="运行总览" description="每一场比赛都有清晰的进度、修订与运行记录。" actions={<Button asChild><Link to="/batches/new"><Plus className="size-4" />新建批次</Link></Button>} />
    <Card className="mb-8 overflow-hidden"><div className="grid grid-cols-2 xl:grid-cols-4">{stats.map(({ label, value, icon: Icon, detail }, index) => <div key={label} className="relative p-4 sm:p-5 xl:not-last:border-r max-xl:nth-[1]:border-b max-xl:nth-[2]:border-b max-xl:odd:border-r">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">{label}</span><Icon className="size-3.5 text-muted-foreground/55" /></div>
      <div className="mt-3.5 flex items-end gap-2"><span className="font-mono text-[28px] font-semibold leading-none tabular-nums tracking-[-0.04em]">{query.isLoading ? '—' : String(value).padStart(2, '0')}</span></div>
      <div className="mt-2 text-[11px] text-muted-foreground">{detail}</div>{index === 1 && value > 0 && <motion.span layoutId="active-metric" className="absolute inset-x-5 bottom-0 h-0.5 bg-primary" />}
    </div>)}</div></Card>
    {query.data?.error && <div className="mb-5 flex gap-3 rounded-[3px] border border-red-500/20 bg-red-500/5 p-4 text-sm text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><div><strong className="font-medium">执行器报告了错误</strong><p className="mt-1 text-xs leading-5">{query.data.error}</p></div></div>}
    <div className="mb-4 flex items-end justify-between"><div><div className="mb-1 text-[11px] font-medium text-primary">执行队列</div><h2 className="text-base font-semibold tracking-tight">批次队列</h2><p className="mt-1 text-xs text-muted-foreground">串行或受控并行执行，任务状态与最近提交实时汇总</p></div>
      <Button variant="ghost" size="sm" onClick={() => void query.refetch()}><RotateCw className="size-3.5" />刷新</Button></div>
    <Separator className="mb-4" />
    {query.isError ? <Card><EmptyState icon={AlertTriangle} title="暂时无法读取批次" description={(query.error as Error).message} action={<Button variant="secondary" onClick={() => void query.refetch()}>重新连接</Button>} /></Card>
      : query.isLoading ? <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="skeleton h-[98px] rounded-card border bg-card" />)}</div>
      : batches.length === 0 ? <Card><EmptyState icon={Layers3} title="赛道待命" description="从已有的 Agent 与 Contest 配置生成执行矩阵，确认计划后即可开始第一场比赛。" action={<Button variant="ghost" asChild><Link to="/batches/new" className="text-primary">创建第一个批次<ArrowUpRight className="size-4" /></Link></Button>} /></Card>
      : <div className="space-y-3">{batches.map(batch => <BatchCard key={batch.id} batch={batch} busy={query.data?.busy ?? false} defaultOpen={batch === batches[0]} />)}</div>}
  </>;
}
