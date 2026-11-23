import { useEffect, useMemo, useReducer } from 'react';
import { Flag, Pause, Play, SkipBack, Users } from 'lucide-react';
import type { GhostRaceContract } from '@studio-api';
import { cn, formatDuration, formatNumber } from '@/lib/utils';
import { createPlaybackState, playbackReducer } from '@/state/playback.machine';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/empty-state';
import { Select, SelectItem } from '@/components/ui/select';

export function GhostRace({ race }: { race: GhostRaceContract }) {
  const [playback, dispatch] = useReducer(playbackReducer, '16', createPlaybackState);
  const duration = race.timeline_end_ms;
  const samples = useMemo(() => race.samples ?? [], [race.samples]);

  useEffect(() => {
    dispatch({ type: 'RESET' });
  }, [race]);

  useEffect(() => {
    if (!playback.playing || !duration) return;
    const timer = window.setInterval(() => dispatch({ type: 'TICK', duration, intervalMs: 250 }), 250);
    return () => window.clearInterval(timer);
  }, [playback.playing, duration]);

  const snapshotIndex = useMemo(() => {
    let idx = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i]!.at_elapsed_ms <= playback.cursor) idx = i;
      else break;
    }
    return idx;
  }, [samples, playback.cursor]);

  const snapshot = samples[snapshotIndex];
  const displayTime = snapshot?.at_elapsed_ms ?? playback.cursor;
  const standings = snapshot?.standings ?? [];
  const milestones = race.milestones.filter(item => item.elapsed_ms <= displayTime).slice(-8).reverse();

  const chart = useMemo(() => {
    const width = 720;
    const height = 180;
    const maxScore = Math.max(1, ...standings.map(row => row.max_score), ...race.participants.map(row => row.final_score));
    return race.participants.map((participant, participantIndex) => {
      const points = samples.map(sample => {
        const standing = sample.standings.find(row => row.run_id === participant.run_id);
        const x = duration ? sample.at_elapsed_ms / duration * width : 0;
        const y = height - (standing?.score ?? 0) / maxScore * height;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      }).join(' ');
      return { participant, participantIndex, points };
    });
  }, [race, samples, standings, duration]);

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-4 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-[11px] font-medium text-primary">同步赛时轴</div>
            <h2 className="mt-0.5 text-sm font-semibold">{race.contest_title ?? race.contest_id}</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">{race.participants.length} 个 Agent · {race.scoring_mode} · 数据 v{race.data_version}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="竞速回到起点" onClick={() => dispatch({ type: 'SEEK', cursor: 0 })}>
              <SkipBack className="size-4" />
            </Button>
            <Button
              size="icon"
              aria-label={playback.playing ? '暂停竞速' : '开始竞速'}
              onClick={() => dispatch({ type: 'TOGGLE_PLAY', duration, displayTime })}
            >
              {playback.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <span className="mx-2 font-mono text-sm tabular-nums">
              <span className="mr-2 text-[10px] text-muted-foreground">采样时刻</span>
              {formatDuration(displayTime)} / {formatDuration(duration)}
            </span>
            <Select value={playback.speed} onValueChange={speed => dispatch({ type: 'SET_SPEED', speed })}>
              <SelectItem value="1">1×</SelectItem>
              <SelectItem value="16">16×</SelectItem>
              <SelectItem value="60">60×</SelectItem>
            </Select>
          </div>
        </div>
        <div className="p-5">
          {samples.length > 1 ? (
            <input
              aria-label="竞速时间轴"
              aria-valuetext={formatDuration(displayTime)}
              type="range"
              min={0}
              max={samples.length - 1}
              step={1}
              value={snapshotIndex}
              onChange={event => dispatch({ type: 'SEEK', cursor: samples[Number(event.target.value)]?.at_elapsed_ms ?? 0 })}
              className="h-2 w-full cursor-pointer accent-[var(--primary)]"
            />
          ) : (
            <input
              aria-label="竞速时间轴"
              aria-valuetext={formatDuration(displayTime)}
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={1000}
              value={Math.min(displayTime, duration)}
              onChange={event => dispatch({ type: 'SEEK', cursor: Number(event.target.value) })}
              className="h-2 w-full cursor-pointer accent-[var(--primary)]"
            />
          )}
        </div>
        {samples.length > 0 && (
          <div className="border-t p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">得分曲线</span>
              <div className="flex flex-wrap gap-3">
                {race.participants.map((participant, index) => (
                  <span key={participant.run_id} className="flex items-center gap-1.5 text-[10px] text-muted-foreground" style={{ opacity: Math.max(.45, 1 - index * .12) }}>
                    <i className="h-0.5 w-4 bg-current" />{participant.agent_name ?? participant.agent_id}
                  </span>
                ))}
              </div>
            </div>
            <svg viewBox="0 -10 720 200" className="h-48 w-full text-primary" role="img" aria-label="各 Agent 得分随赛时变化折线图">
              <line x1="0" y1="180" x2="720" y2="180" stroke="currentColor" strokeOpacity=".18" />
              <line x1="0" y1="90" x2="720" y2="90" stroke="currentColor" strokeOpacity=".1" strokeDasharray="3 5" />
              <line x1="0" y1="0" x2="720" y2="0" stroke="currentColor" strokeOpacity=".1" strokeDasharray="3 5" />
              {chart.map(({ participant, participantIndex, points }) => (
                <polyline
                  key={participant.run_id}
                  points={points}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={Math.max(.35, 1 - participantIndex * .14)}
                  strokeWidth={participantIndex === 0 ? 2.4 : 1.7}
                  strokeDasharray={participantIndex % 3 === 2 ? '5 4' : participantIndex % 3 === 1 ? '9 3' : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <line x1={duration ? displayTime / duration * 720 : 0} x2={duration ? displayTime / duration * 720 : 0} y1="0" y2="180" stroke="currentColor" strokeOpacity=".45" strokeWidth="1" />
            </svg>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">赛时排名</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">未完成与协议不一致的运行明确标记，不混入正式名次。</p>
        </div>
        {standings.length === 0 ? (
          <EmptyState icon={Users} title="等待竞速采样" description="拖动时间轴或开始播放。" />
        ) : (
          <div className="divide-y">
            {standings.map(row => (
              <div key={row.run_id} className="grid gap-3 px-4 py-4 md:grid-cols-[44px_minmax(160px,1fr)_110px_110px_130px] md:items-center">
                <div className="font-mono text-lg text-muted-foreground">{row.rank ?? '—'}</div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{row.agent_name ?? row.agent_id}</span>
                    {row.provisional && <Badge>暂定</Badge>}
                    {row.unranked && <Badge>未计名次</Badge>}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{row.agent_id} · {row.run_id.slice(0, 8)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">得分</div>
                  <div className="mt-1 font-mono text-sm">{formatNumber(row.score)} / {formatNumber(row.max_score)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">通过题数</div>
                  <div className="mt-1 font-mono text-sm">{row.solved_count}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">罚时</div>
                  <div className="mt-1 font-mono text-sm">{row.penalty}</div>
                </div>
                <div className="md:col-span-5">
                  <div className="h-1 bg-muted">
                    <div className={cn('h-full bg-primary transition-[width]', row.unranked && 'bg-warning')} style={{ width: `${row.max_score ? Math.min(100, row.score / row.max_score * 100) : 0}%` }} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {row.problems.map(problem => (
                      <span
                        key={problem.id}
                        title={`${problem.id}: ${problem.status}`}
                        className={cn(
                          'flex size-6 items-center justify-center border font-mono text-[9px]',
                          problem.status === 'accepted'
                            ? 'border-primary bg-primary text-primary-foreground'
                            : problem.status === 'partial'
                              ? 'border-warning text-warning'
                              : 'text-muted-foreground',
                        )}
                      >
                        {problem.id}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-3"><Flag className="size-4" /><h2 className="text-sm font-semibold">关键里程碑</h2></div>
        <div className="grid md:grid-cols-2">
          {milestones.map(item => (
            <div key={`${item.run_id}-${item.seq}`} className="grid grid-cols-[52px_1fr] gap-3 border-b px-4 py-3 md:odd:border-r">
              <span className="font-mono text-[10px] text-muted-foreground">{formatDuration(item.elapsed_ms, true)}</span>
              <div>
                <div className="text-xs leading-5">{item.summary}</div>
                <div className="mt-1 font-mono text-[9px] text-muted-foreground">{item.agent_name ?? item.agent_id} · {item.kind.replaceAll('_', ' ')}</div>
              </div>
            </div>
          ))}
          {milestones.length === 0 && <p className="p-6 text-xs text-muted-foreground">当前时刻尚无里程碑。</p>}
        </div>
      </Card>
    </div>
  );
}
