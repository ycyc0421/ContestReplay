import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown, CircleStop, Download, ExternalLink, Play } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import type { BatchSummary } from '@studio-api';
import { studioApi } from '@/lib/api';
import { cn, formatDate, formatDuration, formatNumber, reasonLabel, shortId } from '@/lib/utils';
import { queryKeys } from '@/state/query-keys';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Tooltip } from '@/components/ui/tooltip';

export function BatchCard({ batch, busy, defaultOpen = false }: { batch: BatchSummary; busy: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [confirmStop, setConfirmStop] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.batches });
  const stop = useMutation({ mutationFn: () => studioApi.stopBatch(batch.id), onSuccess: () => { toast.success('已请求停止整个批次'); setConfirmStop(false); void refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const resume = useMutation({ mutationFn: () => studioApi.resumeBatch(batch.id), onSuccess: () => { toast.success('批次已继续'); void refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const completed = batch.jobs.filter(j => j.status === 'completed').length;
  const active = batch.jobs.some(j => j.status === 'running');
  const queued = batch.jobs.some(j => j.status === 'queued');
  const overall = active ? 'running' : queued ? 'queued' : batch.jobs.some(j => j.status === 'interrupted') ? 'interrupted'
    : batch.jobs.some(j => j.status === 'void') ? 'void' : batch.jobs.every(j => j.status === 'completed') ? 'completed' : 'cancelled';
  return <Card className={cn('overflow-hidden transition-[border-color,box-shadow] hover:border-muted-foreground/25', active && 'border-l-2 border-l-primary')}>
    <div className="flex items-stretch">
      <button className="flex min-w-0 flex-1 items-center gap-3 px-4 py-4 text-left sm:gap-5 sm:px-5" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform duration-150', open && 'rotate-180')} />
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2.5"><span className="font-mono text-sm font-semibold tracking-tight">{shortId(batch.id)}</span><StatusBadge status={overall} />{batch.concurrency && batch.concurrency > 1 && <Badge>{batch.concurrency} 路并行</Badge>}</div>
          <div className="mt-2 flex items-center gap-3"><div className="hidden w-28 sm:block"><Progress value={batch.jobs.length ? completed / batch.jobs.length * 100 : 0} label={`${completed} / ${batch.jobs.length} 有效完赛`} /></div><span className="text-[11px] text-muted-foreground">{formatDate(batch.created_at)} · {batch.jobs.length} 个任务</span></div></div>
        <div className="hidden text-right sm:block"><div className="font-mono text-sm font-medium tabular-nums">{completed}<span className="text-muted-foreground"> / {batch.jobs.length}</span></div><div className="mt-1 text-[10px] text-muted-foreground">已完赛</div></div>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 border-l px-2 sm:px-3">
        {queued && !busy && <Tooltip content="继续未启动任务"><Button size="icon" variant="ghost" aria-label="继续未启动任务" loading={resume.isPending} onClick={() => resume.mutate()}><Play className="size-4" /></Button></Tooltip>}
        {(queued || active) && <Tooltip content="停止整个批次"><Button size="icon" variant="ghost" aria-label="停止整个批次" onClick={() => setConfirmStop(true)}><CircleStop className="size-4" /></Button></Tooltip>}
        {completed > 0 && <Tooltip content="导出已完赛结果"><a className="rounded-[2px] p-2.5 text-muted-foreground transition hover:bg-muted hover:text-primary" href={`/api/batches/${encodeURIComponent(batch.id)}/results`} download aria-label="导出已完赛结果"><Download className="size-4" /></a></Tooltip>}
      </div>
    </div>
    <AnimatePresence initial={false}>{open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .18, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden"><div className="border-t">
      <div className="hidden grid-cols-[minmax(180px,1.2fr)_minmax(150px,1fr)_110px_minmax(180px,1fr)_36px] gap-4 bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
        <span>Agent / 修订</span><span>Contest</span><span>状态</span><span>详情</span><span /></div>
      <div className="divide-y">{batch.jobs.map((job, index) => <div key={job.run_id ?? `${job.agent_revision}-${job.contest_id}-${index}`} className="grid gap-3 px-4 py-4 sm:px-5 md:grid-cols-[minmax(180px,1.2fr)_minmax(150px,1fr)_110px_minmax(180px,1fr)_36px] md:items-center md:gap-4">
        <div className="min-w-0"><div className="truncate text-sm font-medium">{job.agent_name ?? job.agent_id}</div><div className="mt-1.5 flex items-center gap-2"><Badge>{job.agent_revision.slice(0, 8)}</Badge>{job.speed_tier && <Badge>{job.speed_tier}</Badge>}{job.repeat_total && job.repeat_total > 1 && <Badge>{job.repeat_index}/{job.repeat_total}</Badge>}<span className="truncate text-[11px] text-muted-foreground">{job.harness}</span></div></div>
        <div className="min-w-0"><div className="truncate text-sm">{job.contest_id}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">数据 v{job.data_version}</div></div>
        <div><StatusBadge status={job.status} /></div>
        <div className="text-xs text-muted-foreground" title={reasonLabel(job.reason)}>{job.live_summary ? <div className="space-y-1"><div>{job.live_summary.solved_count}/{job.live_summary.problem_count} 题通过 · {formatNumber(job.live_summary.score)}/{formatNumber(job.live_summary.max_score)} 分</div><div className="font-mono text-[10px]">{job.live_summary.last_submission ? `最近 ${job.live_summary.last_submission.problem_id} · ${job.live_summary.last_submission.verdict} · ` : ''}剩余 {formatDuration(job.live_summary.remaining_ms, true)}</div></div> : reasonLabel(job.reason) ?? '—'}</div>
        <div className="md:text-right">{job.run_id && <Tooltip content="查看运行详情"><Button asChild variant="ghost" size="icon" aria-label={`查看 ${job.agent_id} 的运行日志`}><Link to="/runs/$runId" params={{ runId: job.run_id }}><ExternalLink className="size-4" /></Link></Button></Tooltip>}</div>
      </div>)}</div>
    </div></motion.div>}</AnimatePresence>
    <ConfirmDialog open={confirmStop} onOpenChange={setConfirmStop} title="停止整个批次？" description="当前任务会收到停止请求，未启动的任务将标记为已停止。已上传到在线判题的提交无法撤回。" confirmLabel="停止批次" loading={stop.isPending} onConfirm={() => stop.mutate()} />
  </Card>;
}
