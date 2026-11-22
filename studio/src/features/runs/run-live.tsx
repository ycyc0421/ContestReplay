import { Activity, Clock3, Cpu, Send, Trophy } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { RunProgressContract } from '@studio-api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { cn, formatDuration, formatNumber } from '@/lib/utils';
import type { ProgressConnection } from './use-run-progress';

type ProblemStatus = RunProgressContract['problems'][number]['status'];
const problemLabels: Record<ProblemStatus, string> = {
  unattempted: '未提交', pending: '判题中', accepted: '已通过', partial: '部分分', wrong: '未通过',
};
const problemStyles: Record<ProblemStatus, string> = {
  unattempted: 'border-dashed text-muted-foreground',
  pending: 'border-primary/40 bg-muted/50 text-primary',
  accepted: 'border-primary bg-primary text-primary-foreground',
  partial: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  wrong: 'border-border bg-card text-muted-foreground',
};

export function RunLive({ progress, connection }: { progress: RunProgressContract; connection: ProgressConnection }) {
  const timeRatio = progress.time_limit_ms > 0 ? Math.min(100, progress.elapsed_ms / progress.time_limit_ms * 100) : 0;
  const metrics = [
    { label: '当前得分', value: `${formatNumber(progress.score)} / ${formatNumber(progress.max_score)}`, icon: Trophy },
    { label: '已通过', value: `${progress.solved_count} / ${progress.problem_count}`, icon: Activity },
    { label: '剩余赛时', value: formatDuration(progress.remaining_ms, true), icon: Clock3 },
    { label: '提交预算', value: `${progress.submissions_used} / ${progress.max_submissions}`, icon: Send },
    { label: '模型轮次', value: String(progress.model_turns), icon: Cpu },
  ];
  return <div className="space-y-5">
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-xs"><span className={cn('size-1.5 bg-primary', connection === 'live' && 'animate-pulse-soft')} />
          <span className="font-medium">{connection === 'live' ? '实时事件流已连接' : connection === 'connecting' ? '正在连接实时事件流' : connection === 'closed' ? '运行已结束' : '事件流重连中 · 使用轮询兜底'}</span>
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">ELAPSED {formatDuration(progress.elapsed_ms)} · LAST ACTIVITY {formatDuration(progress.last_activity_ms, true)}</div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5">{metrics.map(({ label, value, icon: Icon }, index) => <div key={label} className={cn('p-4 max-md:nth-[5]:col-span-2', index < metrics.length - 1 && 'md:border-r')}>
        <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"><Icon className="size-3" />{label}</div>
        <div className="mt-2 font-mono text-lg font-semibold tabular-nums tracking-tight">{value}</div>
      </div>)}</div>
      <div className="border-t px-4 py-3"><div className="mb-2 flex justify-between font-mono text-[9px] text-muted-foreground"><span>CONTEST CLOCK</span><span>{Math.round(timeRatio)}%</span></div><Progress value={timeRatio} label="赛时进度" /></div>
    </Card>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3"><div><h2 className="text-sm font-semibold">题目状态</h2><p className="mt-1 text-[11px] text-muted-foreground">每次提交与判定都由沙盒外 Supervisor 记录</p></div><Badge>{progress.scoring_mode ?? 'default'}</Badge></div>
        {progress.problem_breakdown_unavailable ? <p className="p-6 text-xs text-warning">当前运行缺少逐题元数据，仅汇总成绩可用。</p> : <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {progress.problems.map(problem => <motion.div layout key={problem.id} className={cn('border p-3 transition-colors', problemStyles[problem.status])}>
            <div className="flex items-center justify-between gap-3"><span className="font-mono text-sm font-semibold">{problem.id}</span><span className="text-[10px] font-medium">{problemLabels[problem.status]}</span></div>
            <div className="mt-3 flex items-end justify-between gap-2"><span className="font-mono text-xs tabular-nums">{formatNumber(problem.best_score)} / {formatNumber(problem.max_points)}</span><span className="font-mono text-[9px] opacity-70">{problem.attempts} 次提交</span></div>
            {(problem.last_verdict || problem.first_ac_ms !== undefined) && <div className="mt-2 truncate font-mono text-[9px] opacity-70">{problem.first_ac_ms !== undefined ? `FIRST AC ${formatDuration(problem.first_ac_ms, true)}` : `${problem.last_verdict} · ${formatDuration(problem.last_elapsed_ms ?? 0, true)}`}</div>}
          </motion.div>)}
        </div>}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">最近活动</h2><p className="mt-1 text-[11px] text-muted-foreground">最新事件在前</p></div>
        <div className="max-h-[430px] overflow-auto scrollbar-thin"><AnimatePresence initial={false}>{progress.recent_activity.map(activity => <motion.div key={activity.seq} initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-[48px_1fr] gap-3 border-b px-4 py-3 last:border-b-0">
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{formatDuration(activity.elapsed_ms, true)}</span>
          <div className="min-w-0"><div className="text-xs leading-5">{activity.summary}</div><div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[9px] uppercase text-muted-foreground"><span>{activity.type.replaceAll('_', ' ')}</span>{activity.verdict && <span>{activity.verdict}</span>}{activity.score !== undefined && <span>+{formatNumber(activity.score)}</span>}</div></div>
        </motion.div>)}</AnimatePresence>{progress.recent_activity.length === 0 && <p className="p-6 text-center text-xs text-muted-foreground">等待第一条比赛事件…</p>}</div>
      </Card>
    </div>

    <Card className="grid grid-cols-2 divide-x md:grid-cols-4"><div className="p-4"><div className="font-mono text-[9px] text-muted-foreground">MODEL WAIT</div><div className="mt-1 font-mono text-sm">{formatDuration(progress.telemetry.total_model_wait_ms, true)}</div></div>
      <div className="p-4"><div className="font-mono text-[9px] text-muted-foreground">INPUT TOKENS</div><div className="mt-1 font-mono text-sm">{formatNumber(progress.telemetry.total_input_tokens)}</div></div>
      <div className="p-4 max-md:border-t"><div className="font-mono text-[9px] text-muted-foreground">OUTPUT TOKENS</div><div className="mt-1 font-mono text-sm">{formatNumber(progress.telemetry.total_output_tokens)}</div></div>
      <div className="p-4 max-md:border-t"><div className="font-mono text-[9px] text-muted-foreground">ACTIVITY</div><div className="mt-1 truncate text-xs">{progress.last_activity_type?.replaceAll('_', ' ') ?? '—'}</div></div></Card>
  </div>;
}
