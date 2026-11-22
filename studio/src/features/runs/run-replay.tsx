import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code2, History, Pause, Play, RotateCcw, SkipBack } from 'lucide-react';
import { motion } from 'motion/react';
import { studioApi } from '@/lib/api';
import { cn, formatDuration, formatNumber } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectItem } from '@/components/ui/select';
import { EmptyState } from '@/components/empty-state';
import { projectReplayAt } from './replay-projection';

export function RunReplay({ runId }: { runId: string }) {
  const [includeSources, setIncludeSources] = useState(false);
  const replay = useQuery({ queryKey: ['replay', runId, includeSources], queryFn: () => studioApi.replay(runId, { includeSources, includeSession: true }) });
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('4');
  const [pinnedSeq, setPinnedSeq] = useState<number>();
  const duration = replay.data?.duration_ms ?? 0;
  useEffect(() => {
    if (!playing || !duration) return;
    const timer = window.setInterval(() => setCursor(value => {
      const next = Math.min(duration, value + 250 * Number(speed));
      if (next >= duration) setPlaying(false);
      return next;
    }), 250);
    return () => window.clearInterval(timer);
  }, [playing, duration, speed]);
  useEffect(() => { setCursor(0); setPlaying(false); setPinnedSeq(undefined); }, [runId]);

  const currentFrame = useMemo(() => {
    if (!replay.data) return undefined;
    if (pinnedSeq !== undefined) return replay.data.frames.find(frame => frame.seq === pinnedSeq);
    return replay.data.frames.filter(frame => frame.elapsed_ms <= cursor).at(-1);
  }, [replay.data, cursor, pinnedSeq]);
  const recentFrames = useMemo(() => replay.data?.frames.filter(frame => frame.elapsed_ms <= cursor).slice(-10).reverse() ?? [], [replay.data, cursor]);
  const projection = useMemo(() => replay.data ? projectReplayAt(replay.data, cursor) : undefined, [replay.data, cursor]);
  const problems = projection?.problems ?? [];

  if (replay.isLoading) return <div className="skeleton h-[520px] border bg-card" />;
  if (replay.isError || !replay.data) return <Card><EmptyState icon={History} title="无法构建时间轴" description={(replay.error as Error)?.message ?? '没有可回放的数据'} action={<Button variant="secondary" onClick={() => void replay.refetch()}>重试</Button>} /></Card>;
  const data = replay.data;
  const markers = data.frames.filter(frame => ['submission_judged', 'finish', 'run_ended', 'judge_error'].includes(frame.kind));
  return <div className="space-y-5">
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2"><Button size="icon" variant="ghost" aria-label="回到起点" onClick={() => { setCursor(0); setPlaying(false); setPinnedSeq(undefined); }}><SkipBack className="size-4" /></Button>
          <Button size="icon" aria-label={playing ? '暂停回放' : '开始回放'} onClick={() => { if (cursor >= duration) setCursor(0); setPinnedSeq(undefined); setPlaying(value => !value); }}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setCursor(duration); setPlaying(false); setPinnedSeq(undefined); }}><RotateCcw className="size-3.5" />跳到终态</Button></div>
        <div className="flex items-center gap-3"><div className="font-mono text-sm tabular-nums"><span className="text-primary">{formatDuration(cursor)}</span><span className="mx-2 text-muted-foreground">/</span><span className="text-muted-foreground">{formatDuration(duration)}</span></div>
          <Select value={speed} onValueChange={setSpeed}><SelectItem value="1">1× 实时</SelectItem><SelectItem value="4">4×</SelectItem><SelectItem value="16">16×</SelectItem><SelectItem value="60">60×</SelectItem></Select></div>
      </div>
      <div className="px-5 py-6">
        <div className="relative pb-8 pt-2">
          <input aria-label="回放时间轴" type="range" min={0} max={Math.max(duration, 1)} step={1000} value={Math.min(cursor, duration)} onChange={event => { setCursor(Number(event.target.value)); setPinnedSeq(undefined); setPlaying(false); }} className="relative z-10 h-2 w-full cursor-pointer accent-[var(--primary)]" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 top-5">
            {markers.map(frame => <button key={frame.seq} type="button" aria-label={`定位到 ${frame.summary}`} title={frame.summary} onClick={() => { setCursor(frame.elapsed_ms); setPinnedSeq(frame.seq); setPlaying(false); }} className={cn('pointer-events-auto absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 border border-background', frame.kind === 'judge_error' ? 'bg-danger' : frame.kind === 'submission_judged' ? 'bg-primary' : 'bg-warning')} style={{ left: `${duration ? frame.elapsed_ms / duration * 100 : 0}%` }} />)}
          </div>
          <div className="absolute inset-x-0 bottom-0 flex justify-between font-mono text-[9px] text-muted-foreground"><span>00:00</span><span>事件标记</span><span>{formatDuration(duration, true)}</span></div>
        </div>
      </div>
      <div className="grid border-t md:grid-cols-3"><div className="p-4 md:border-r"><div className="font-mono text-[9px] text-muted-foreground">CUMULATIVE SCORE</div><div className="mt-1 font-mono text-lg">{formatNumber(projection?.score ?? 0)}</div></div>
        <div className="p-4 max-md:border-t md:border-r"><div className="font-mono text-[9px] text-muted-foreground">SOLVED</div><div className="mt-1 font-mono text-lg">{projection?.solved_count ?? 0} / {data.problems.length}</div></div>
        <div className="p-4 max-md:border-t"><div className="font-mono text-[9px] text-muted-foreground">CURRENT FRAME</div><div className="mt-1 font-mono text-xs">{currentFrame ? `#${currentFrame.seq} · ${currentFrame.kind}` : '等待开始'}</div></div></div>
    </Card>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        <Card className="overflow-hidden"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">此刻的题目状态</h2></div><div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">{problems.map(problem => <div key={problem.id} className="bg-card p-4"><div className="flex items-center justify-between"><span className="font-mono text-sm font-semibold">{problem.id}</span><Badge>{problem.status}</Badge></div><div className="mt-3 font-mono text-xs">{formatNumber(problem.score)} / {formatNumber(problem.max_points)}</div><div className="mt-1 font-mono text-[9px] text-muted-foreground">{problem.attempts} submissions{problem.first_ac_ms !== undefined ? ` · AC ${formatDuration(problem.first_ac_ms, true)}` : ''}</div></div>)}</div></Card>
        <Card className="overflow-hidden"><div className="flex items-center justify-between border-b px-4 py-3"><div><h2 className="text-sm font-semibold">帧详情</h2><p className="mt-1 text-[11px] text-muted-foreground">选择时间轴标记可固定查看任一事件</p></div>{!includeSources && <Button variant="ghost" size="sm" onClick={() => setIncludeSources(true)}><Code2 className="size-3.5" />载入提交差异</Button>}</div>
          {currentFrame ? <div className="p-4"><div className="flex flex-wrap items-center gap-2"><Badge>#{currentFrame.seq}</Badge><Badge>{currentFrame.kind}</Badge>{currentFrame.verdict && <Badge>{currentFrame.verdict}</Badge>}</div><p className="mt-3 text-sm leading-6">{currentFrame.summary}</p><div className="mt-3 font-mono text-[10px] text-muted-foreground">{formatDuration(currentFrame.elapsed_ms)}{currentFrame.duration_ms !== undefined ? ` · ${formatDuration(currentFrame.duration_ms, true)}` : ''}</div>
            {currentFrame.diff && <pre className="mt-4 max-h-80 overflow-auto border bg-muted/35 p-3 font-mono text-[11px] leading-5 scrollbar-thin">{currentFrame.diff}</pre>}{!currentFrame.diff && currentFrame.source && <pre className="mt-4 max-h-80 overflow-auto border bg-muted/35 p-3 font-mono text-[11px] leading-5 scrollbar-thin">{currentFrame.source}</pre>}</div> : <p className="p-6 text-xs text-muted-foreground">回放尚未开始。</p>}</Card>
      </div>
      <Card className="overflow-hidden"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">事件序列</h2></div><div>{recentFrames.map(frame => <button key={frame.seq} onClick={() => { setCursor(frame.elapsed_ms); setPinnedSeq(frame.seq); setPlaying(false); }} className={cn('grid w-full grid-cols-[48px_1fr] gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted/40', currentFrame?.seq === frame.seq && 'bg-muted/60')}><span className="font-mono text-[10px] text-muted-foreground">{formatDuration(frame.elapsed_ms, true)}</span><span><span className="block text-xs leading-5">{frame.summary}</span><span className="mt-1 block font-mono text-[9px] uppercase text-muted-foreground">#{frame.seq} · {frame.kind.replaceAll('_', ' ')}</span></span></button>)}{recentFrames.length === 0 && <p className="p-6 text-center text-xs text-muted-foreground">向右拖动时间轴查看事件。</p>}</div></Card>
    </div>

    {data.session_summaries && data.session_summaries.length > 0 && <Card className="overflow-hidden"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Session 留存</h2><p className="mt-1 text-[11px] text-muted-foreground">仅展示脱敏摘要，不读取完整模型会话</p></div><div className="divide-y">{data.session_summaries.map(session => <details key={session.file} className="group px-4 py-3"><summary className="cursor-pointer text-xs font-medium">{session.file}<span className="ml-2 font-mono text-[9px] text-muted-foreground">{session.entries.length} entries{session.truncated ? ' · truncated' : ''}</span></summary><div className="mt-3 space-y-2 border-l pl-4">{session.entries.map(entry => <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} key={entry.index} className="text-xs"><span className="mr-2 font-mono text-[9px] text-muted-foreground">#{entry.index} {entry.role ?? entry.type}</span>{entry.summary}</motion.div>)}</div></details>)}</div></Card>}
  </div>;
}
