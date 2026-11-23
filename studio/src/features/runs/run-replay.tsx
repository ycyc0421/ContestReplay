import { useEffect, useMemo, useReducer, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code2, History, Pause, Play, RotateCcw, SkipBack } from 'lucide-react';
import { studioApi } from '@/lib/api';
import { cn, formatDuration, formatNumber } from '@/lib/utils';
import { queryKeys } from '@/state/query-keys';
import { createPlaybackState, playbackReducer } from '@/state/playback.machine';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectItem } from '@/components/ui/select';
import { EmptyState } from '@/components/empty-state';
import { projectReplayAt } from './replay-projection';

export function RunReplay({ runId }: { runId: string }) {
  const [includeSources, setIncludeSources] = useState(false);
  const replay = useQuery({
    queryKey: queryKeys.replay(runId, includeSources),
    queryFn: () => studioApi.replay(runId, { includeSources, includeSession: true }),
  });
  const [playback, dispatch] = useReducer(playbackReducer, '4', createPlaybackState);
  const duration = replay.data?.duration_ms ?? 0;

  useEffect(() => {
    if (!playback.playing || !duration) return;
    const timer = window.setInterval(() => dispatch({ type: 'TICK', duration, intervalMs: 250 }), 250);
    return () => window.clearInterval(timer);
  }, [playback.playing, duration]);

  useEffect(() => { dispatch({ type: 'RESET' }); }, [runId]);

  const currentFrame = useMemo(() => {
    if (!replay.data) return undefined;
    if (playback.pinnedSeq !== undefined) return replay.data.frames.find(frame => frame.seq === playback.pinnedSeq);
    return replay.data.frames.filter(frame => frame.elapsed_ms <= playback.cursor).at(-1);
  }, [replay.data, playback.cursor, playback.pinnedSeq]);

  const recentFrames = useMemo(
    () => replay.data?.frames.filter(frame => frame.elapsed_ms <= playback.cursor).slice(-10).reverse() ?? [],
    [replay.data, playback.cursor],
  );
  const projection = useMemo(
    () => replay.data ? projectReplayAt(replay.data, playback.cursor) : undefined,
    [replay.data, playback.cursor],
  );
  const problems = projection?.problems ?? [];

  if (replay.isLoading) return <div className="skeleton h-[520px] rounded-card border bg-card" />;
  if (replay.isError || !replay.data) {
    return (
      <Card>
        <EmptyState
          icon={History}
          title="无法构建时间轴"
          description={(replay.error as Error)?.message ?? '没有可回放的数据'}
          action={<Button variant="secondary" onClick={() => void replay.refetch()}>重试</Button>}
        />
      </Card>
    );
  }
  const data = replay.data;
  const markers = data.frames.filter(frame => ['submission_judged', 'finish', 'run_ended', 'judge_error'].includes(frame.kind));

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-4 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <Button size="icon" variant="ghost" aria-label="回到起点" onClick={() => dispatch({ type: 'SEEK', cursor: 0 })}>
              <SkipBack className="size-4" />
            </Button>
            <Button size="icon" aria-label={playback.playing ? '暂停回放' : '开始回放'} onClick={() => dispatch({ type: 'TOGGLE_PLAY', duration })}>
              {playback.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'SEEK', cursor: duration })}>
              <RotateCcw className="size-3.5" />跳到终态
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <div className="font-mono text-sm tabular-nums">
              <span className="text-primary">{formatDuration(playback.cursor)}</span>
              <span className="mx-2 text-muted-foreground">/</span>
              <span className="text-muted-foreground">{formatDuration(duration)}</span>
            </div>
            <Select value={playback.speed} onValueChange={speed => dispatch({ type: 'SET_SPEED', speed })}>
              <SelectItem value="1">1× 实时</SelectItem>
              <SelectItem value="4">4×</SelectItem>
              <SelectItem value="16">16×</SelectItem>
              <SelectItem value="60">60×</SelectItem>
            </Select>
          </div>
        </div>
        <div className="px-5 py-6">
          <div className="relative pb-8 pt-2">
            <input
              aria-label="回放时间轴"
              type="range"
              min={0}
              max={Math.max(duration, 1)}
              step={1000}
              value={Math.min(playback.cursor, duration)}
              onChange={event => dispatch({ type: 'SEEK', cursor: Number(event.target.value) })}
              className="relative z-10 h-2 w-full cursor-pointer accent-[var(--primary)]"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-5">
              {markers.map(frame => (
                <button
                  key={frame.seq}
                  type="button"
                  aria-label={`定位到 ${frame.summary}`}
                  title={frame.summary}
                  onClick={() => dispatch({ type: 'SEEK', cursor: frame.elapsed_ms, pinnedSeq: frame.seq })}
                  className={cn(
                    'pointer-events-auto absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 border border-background',
                    frame.kind === 'judge_error' ? 'bg-danger' : frame.kind === 'submission_judged' ? 'bg-primary' : 'bg-warning',
                  )}
                  style={{ left: `${duration ? frame.elapsed_ms / duration * 100 : 0}%` }}
                />
              ))}
            </div>
            <div className="absolute inset-x-0 bottom-0 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span>00:00</span><span>事件标记</span><span>{formatDuration(duration, true)}</span>
            </div>
          </div>
        </div>
        <div className="grid border-t md:grid-cols-3">
          <div className="p-4 md:border-r"><div className="text-[11px] text-muted-foreground">累计得分</div><div className="mt-1 font-mono text-lg">{formatNumber(projection?.score ?? 0)}</div></div>
          <div className="p-4 max-md:border-t md:border-r"><div className="text-[11px] text-muted-foreground">已通过题数</div><div className="mt-1 font-mono text-lg">{projection?.solved_count ?? 0} / {data.problems.length}</div></div>
          <div className="p-4 max-md:border-t"><div className="text-[11px] text-muted-foreground">当前帧</div><div className="mt-1 font-mono text-xs">{currentFrame ? `#${currentFrame.seq} · ${currentFrame.kind}` : '等待开始'}</div></div>
        </div>
      </Card>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">此刻的题目状态</h2></div>
            <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
              {problems.map(problem => (
                <div key={problem.id} className="bg-card p-4">
                  <div className="flex items-center justify-between"><span className="font-mono text-sm font-semibold">{problem.id}</span><Badge>{problem.status}</Badge></div>
                  <div className="mt-3 font-mono text-xs">{formatNumber(problem.score)} / {formatNumber(problem.max_points)}</div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {problem.attempts} 次提交{problem.first_ac_ms !== undefined ? ` · AC ${formatDuration(problem.first_ac_ms, true)}` : ''}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div><h2 className="text-sm font-semibold">帧详情</h2><p className="mt-1 text-[11px] text-muted-foreground">点击时间轴标记或右侧序列可固定查看任一事件</p></div>
              {!includeSources && <Button variant="ghost" size="sm" onClick={() => setIncludeSources(true)}><Code2 className="size-3.5" />载入提交差异</Button>}
            </div>
            {currentFrame ? (
              <div className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>#{currentFrame.seq}</Badge>
                  <Badge>{currentFrame.kind}</Badge>
                  {currentFrame.verdict && <Badge>{currentFrame.verdict}</Badge>}
                </div>
                <p className="mt-3 text-sm leading-6">{currentFrame.summary}</p>
                <div className="mt-3 font-mono text-[10px] text-muted-foreground">
                  {formatDuration(currentFrame.elapsed_ms)}{currentFrame.duration_ms !== undefined ? ` · ${formatDuration(currentFrame.duration_ms, true)}` : ''}
                </div>
                {currentFrame.diff && <pre className="scrollbar-thin mt-4 max-h-80 overflow-auto border bg-muted/35 p-3 font-mono text-[11px] leading-5">{currentFrame.diff}</pre>}
                {!currentFrame.diff && currentFrame.source && <pre className="scrollbar-thin mt-4 max-h-80 overflow-auto border bg-muted/35 p-3 font-mono text-[11px] leading-5">{currentFrame.source}</pre>}
              </div>
            ) : <p className="p-6 text-xs text-muted-foreground">回放尚未开始。</p>}
          </Card>
        </div>

        <Card className="overflow-hidden">
          <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">事件序列</h2></div>
          <div>
            {recentFrames.map(frame => (
              <button
                key={frame.seq}
                onClick={() => dispatch({ type: 'SEEK', cursor: frame.elapsed_ms, pinnedSeq: frame.seq })}
                className={cn('grid w-full grid-cols-[48px_1fr] gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted/40', currentFrame?.seq === frame.seq && 'bg-muted/60')}
              >
                <span className="font-mono text-[10px] text-muted-foreground">{formatDuration(frame.elapsed_ms, true)}</span>
                <span>
                  <span className="block text-xs leading-5">{frame.summary}</span>
                  <span className="mt-1 block font-mono text-[9px] uppercase text-muted-foreground">#{frame.seq} · {frame.kind.replaceAll('_', ' ')}</span>
                </span>
              </button>
            ))}
            {recentFrames.length === 0 && <p className="p-6 text-center text-xs text-muted-foreground">向右拖动时间轴查看事件。</p>}
          </div>
        </Card>
      </div>

      {data.session_summaries && data.session_summaries.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Session 留存</h2><p className="mt-1 text-[11px] text-muted-foreground">仅展示脱敏摘要，不读取完整模型会话</p></div>
          <div className="divide-y">
            {data.session_summaries.map(session => (
              <details key={session.file} className="group px-4 py-3">
                <summary className="cursor-pointer text-xs font-medium">
                  {session.file}<span className="ml-2 font-mono text-[10px] text-muted-foreground">{session.entries.length} 条{session.truncated ? ' · 已截断' : ''}</span>
                </summary>
                <div className="mt-3 space-y-2 border-l pl-4">
                  {session.entries.map(entry => (
                    <div key={entry.index} className="text-xs">
                      <span className="mr-2 font-mono text-[10px] text-muted-foreground">#{entry.index} {entry.role ?? entry.type}</span>{entry.summary}
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
