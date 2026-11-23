import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Activity, ArrowLeft, CircleStop, History, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { reasonLabel } from '@/lib/utils';
import { queryKeys } from '@/state/query-keys';
import { deriveRunAuthority } from '@/state/run-monitor.machine';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/empty-state';
import { AnimatedPanel } from '@/design-system/motion';
import { SegmentedTabs } from '@/design-system/segmented-tabs';
import { useRunProgress } from './use-run-progress';
import { RunLive } from './run-live';
import { RunReplay } from './run-replay';
import { RunLogs } from './run-logs';

type RunView = 'live' | 'replay' | 'logs';

export function RunPage() {
  const { runId } = useParams({ from: '/runs/$runId' });
  const search = useSearch({ strict: false }) as { view?: RunView };
  const navigate = useNavigate();
  const view: RunView = search.view === 'replay' || search.view === 'logs' ? search.view : 'live';
  const setView = (next: RunView) => {
    void navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, view: next }), replace: false } as never);
  };
  const [confirmStop, setConfirmStop] = useState(false);
  const queryClient = useQueryClient();
  const batches = useQuery({ queryKey: queryKeys.batches, queryFn: studioApi.batches, refetchInterval: 2_000 });
  const progress = useRunProgress(runId);
  const located = useMemo(() => {
    for (const batch of batches.data?.batches ?? []) {
      const job = batch.jobs.find(item => item.run_id === runId);
      if (job) return { batch, job };
    }
  }, [batches.data, runId]);
  const cancel = useMutation({
    mutationFn: () => studioApi.cancelRun(runId),
    onSuccess: () => {
      toast.success('已请求停止当前任务');
      setConfirmStop(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.batches });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const data = progress.data;
  const { running, displayStatus, displayReason } = deriveRunAuthority({
    terminalStatus: progress.terminalStatus,
    progress: data,
    batchJobStatus: located?.job.status,
    batchJobReason: located?.job.reason,
  });

  return <>
    <div className="mb-5 flex items-center justify-between gap-3">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-primary"><ArrowLeft className="size-3.5" />返回运行总览</Link>
      {running && <Button variant="secondary" size="sm" onClick={() => setConfirmStop(true)}><CircleStop className="size-3.5" />停止任务</Button>}
    </div>
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div>
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-primary"><TerminalSquare className="size-4" />01 · 运行详情</div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-[-0.04em]">{data?.agent_name ?? located?.job.agent_name ?? data?.agent_id ?? located?.job.agent_id ?? runId.slice(0, 8)}</h1>
          {displayStatus && <StatusBadge status={displayStatus} />}
        </div>
        <div className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{runId}</div>
      </div>
      <div className="grid grid-cols-2 gap-x-7 gap-y-2 text-xs sm:text-right">
        <span className="text-muted-foreground">Agent</span><span className="font-medium">{data?.agent_id ?? located?.job.agent_id ?? '—'}</span>
        <span className="text-muted-foreground">Contest</span><span>{data?.contest_title ?? data?.contest_id ?? located?.job.contest_id ?? '—'} · v{data?.data_version ?? located?.job.data_version ?? '—'}</span>
        <span className="text-muted-foreground">所属批次</span><span className="font-mono">{located?.batch.id.slice(0, 8) ?? '—'}</span>
        {displayReason && <><span className="text-muted-foreground">结束原因</span><span>{reasonLabel(displayReason)}</span></>}
      </div>
    </div>

    <div className="mb-5 flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
      <SegmentedTabs
        id={`run-view-${runId}`}
        panelIdPrefix={`run-panel-${runId}`}
        ariaLabel="运行详情视图"
        value={view}
        onValueChange={setView}
        items={[
          { value: 'live', label: '实时进度', icon: Activity },
          { value: 'replay', label: '时间轴回放', icon: History },
          { value: 'logs', label: '原始日志', icon: TerminalSquare },
        ]}
      />
      <span className="text-[11px] text-muted-foreground">沙盒外可信 Supervisor 事件 · 仅本机可见</span>
    </div>

    <AnimatedPanel panelKey={view} role="tabpanel" id={`run-panel-${runId}-${view}`} ariaLabelledBy={`run-view-${runId}-tab-${view}`}>
      {view === 'live' && (progress.isLoading
        ? <div className="skeleton h-[520px] rounded-card border bg-card" />
        : progress.isError || !data
          ? <Card><EmptyState icon={Activity} title="暂时无法读取运行进度" description={(progress.error as Error)?.message ?? '运行元数据尚未就绪'} action={<Button variant="secondary" onClick={() => void progress.refetch()}>重试</Button>} /></Card>
          : <RunLive progress={data} connection={progress.connection} />)}
      {view === 'replay' && <RunReplay runId={runId} />}
      {view === 'logs' && <>
        <RunLogs runId={runId} running={running} />
        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">原始输出可能包含本机路径和私有运行信息，仅结果导出文件会过滤为允许公开的字段。</p>
      </>}
    </AnimatedPanel>

    <ConfirmDialog
      open={confirmStop}
      onOpenChange={setConfirmStop}
      title="停止当前任务？"
      description="运行器会收到停止请求并清理沙盒。已经上传到在线判题的提交无法撤回。"
      confirmLabel="停止任务"
      loading={cancel.isPending}
      onConfirm={() => cancel.mutate()}
    />
  </>;
}
