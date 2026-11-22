import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { RunStatus } from '@studio-api';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
export const shortId = (id: string) => id.slice(0, 8);
export const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));
export const formatBytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export const formatDuration = (value: number, compact = false) => {
  const seconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (compact && hours === 0) return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};
export const formatNumber = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);

export const statusMeta: Record<RunStatus, { label: string; className: string }> = {
  queued: { label: '等待中', className: 'bg-muted text-muted-foreground' },
  running: { label: '运行中', className: 'bg-zinc-800 text-zinc-50 dark:bg-zinc-200 dark:text-zinc-900' },
  completed: { label: '已完赛', className: 'border-primary/25 bg-primary/5 text-primary' },
  void: { label: '已作废', className: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  cancelled: { label: '已停止', className: 'bg-muted text-muted-foreground' },
  interrupted: { label: '已中断', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
};

export const reasonLabels: Record<string, string> = {
  batch_stopped: '批次已停止', cancelled: '手动停止', executor_lost: '执行器已退出',
  executor_stopped: '执行器已停止', runner_error: '运行器错误', queue_monitor_error: '队列监控错误',
  sandbox_cleanup_failed: '沙盒清理失败',
};
export const reasonLabel = (reason?: string) => reason ? reasonLabels[reason] ?? reason.replaceAll('_', ' ') : undefined;
