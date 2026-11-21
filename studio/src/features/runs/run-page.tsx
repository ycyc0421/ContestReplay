import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, Check, CircleStop, Clipboard, FileTerminal, RotateCw, TerminalSquare } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { cn, formatBytes, reasonLabel } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function RunPage() {
  const { runId } = useParams({ from: '/runs/$runId' });
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  const [follow, setFollow] = useState(true);
  const [confirmStop, setConfirmStop] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const queryClient = useQueryClient();
  const batches = useQuery({ queryKey: ['batches'], queryFn: studioApi.batches, refetchInterval: 1200 });
  const logs = useQuery({ queryKey: ['logs', runId], queryFn: () => studioApi.logs(runId), refetchInterval: 800 });
  const located = useMemo(() => {
    for (const batch of batches.data?.batches ?? []) {
      const job = batch.jobs.find(j => j.run_id === runId);
      if (job) return { batch, job };
    }
  }, [batches.data, runId]);
  const content = logs.data?.[stream] ?? '';
  useEffect(() => { if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [content, stream, follow]);
  const cancel = useMutation({ mutationFn: () => studioApi.cancelRun(runId), onSuccess: () => {
    toast.success('已请求停止当前任务'); setConfirmStop(false); void queryClient.invalidateQueries({ queryKey: ['batches'] });
  }, onError: (e: Error) => toast.error(e.message) });
  const copy = async () => { await navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const lines = content ? content.split('\n').length : 0;
  return <>
    <div className="mb-5 flex items-center justify-between gap-3"><Link to="/" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-primary"><ArrowLeft className="size-3.5" />返回运行总览</Link>
      {located?.job.status === 'running' && <Button variant="secondary" size="sm" onClick={() => setConfirmStop(true)}><CircleStop className="size-3.5" />停止任务</Button>}</div>
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><div className="mb-2 flex items-center gap-2 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-primary"><TerminalSquare className="size-4" />05 / Run inspector</div>
      <div className="flex flex-wrap items-center gap-3"><h1 className="font-mono text-2xl font-semibold tracking-[-0.04em]">{runId.slice(0, 8)}</h1>{located && <StatusBadge status={located.job.status} />}</div>
      <div className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{runId}</div></div>
      {located && <div className="grid grid-cols-2 gap-x-7 gap-y-2 text-xs sm:text-right"><span className="text-muted-foreground">Agent</span><span className="font-medium">{located.job.agent_id}</span><span className="text-muted-foreground">Contest</span><span>{located.job.contest_id} · v{located.job.data_version}</span><span className="text-muted-foreground">Batch</span><span className="font-mono">{located.batch.id.slice(0, 8)}</span>{located.job.reason && <><span className="text-muted-foreground">结束原因</span><span>{reasonLabel(located.job.reason)}</span></>}</div>}
    </motion.div>
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .05 }}><Card className="overflow-hidden border-[#343537] bg-[#141516] text-[#e7e7e3] shadow-[0_16px_50px_rgba(0,0,0,.14)]">
      <Tabs value={stream} onValueChange={value => setStream(value as 'stdout' | 'stderr')}><div className="flex flex-col border-b border-white/10 sm:flex-row sm:items-center sm:justify-between">
        <TabsList className="h-auto rounded-none bg-transparent p-0 px-3 pt-2">{(['stdout', 'stderr'] as const).map(name => <TabsTrigger key={name} value={name} className="relative h-11 rounded-none bg-transparent px-3 font-mono text-xs text-white/40 shadow-none hover:text-white/75 data-[state=active]:bg-transparent data-[state=active]:text-[#f0f0eb] data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-transparent after:transition-colors data-[state=active]:after:bg-[#d8d8d2]">
          <FileTerminal className="size-3.5" />{name}<span className="rounded-[1px] bg-white/5 px-1.5 py-0.5 text-[9px] text-white/40">{logs.data?.[name] ? formatBytes(new Blob([logs.data[name]]).size) : '0 B'}</span></TabsTrigger>)}</TabsList>
        <div className="flex items-center gap-1 px-3 py-2"><Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" onClick={() => setFollow(v => !v)}><ArrowDown className={cn('size-3.5 transition-colors', follow && 'text-[#f0f0eb]')} />{follow ? '跟随中' : '跟随'}</Button>
          <Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" onClick={() => void logs.refetch()}><RotateCw className="size-3.5" />刷新</Button>
          <Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" disabled={!content} onClick={() => void copy()}><AnimatePresence mode="wait" initial={false}><motion.span key={copied ? 'check' : 'copy'} initial={{ opacity: 0, scale: .7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .7 }}>{copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}</motion.span></AnimatePresence>{copied ? '已复制' : '复制'}</Button></div>
      </div></Tabs>
      <div className="relative"><pre ref={logRef} onScroll={event => { const el = event.currentTarget; if (follow && el.scrollTop + el.clientHeight + 24 < el.scrollHeight) setFollow(false); }} className="log-view scrollbar-thin h-[min(64vh,720px)] min-h-[360px] overflow-auto whitespace-pre p-5 font-mono text-xs leading-[1.75] text-[#c4c5c1]">{content || (logs.isLoading ? '正在读取日志…' : logs.isError ? `读取失败：${(logs.error as Error).message}` : `暂无 ${stream} 输出。`)}</pre>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-[#141516] to-transparent" /></div>
      <div className="flex items-center justify-between border-t border-white/10 px-5 py-2.5 font-mono text-[10px] text-white/35"><span>{lines} lines · UTF-8</span><span className="flex items-center gap-1.5">{located?.job.status === 'running' && <i className="size-1.5 animate-pulse bg-[#f0f0eb]" />}{located?.job.status === 'running' ? 'LIVE · 800ms' : 'LOCAL LOG'}</span></div>
    </Card></motion.div>
    <p className="mt-3 text-[11px] leading-5 text-muted-foreground">原始输出可能包含本机路径和私有运行信息，仅结果导出文件会过滤为允许公开的字段。</p>
    <ConfirmDialog open={confirmStop} onOpenChange={setConfirmStop} title="停止当前任务？" description="运行器会收到停止请求并清理沙盒。已经上传到在线判题的提交无法撤回。" confirmLabel="停止任务" loading={cancel.isPending} onConfirm={() => cancel.mutate()} />
  </>;
}
