import { Check } from 'lucide-react';
import type { RunStatus } from '@studio-api';
import { cn, statusMeta } from '@/lib/utils';

export function StatusBadge({ status }: { status: RunStatus }) {
  const meta = statusMeta[status];
  return <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-[2px] border border-current/10 px-2.5 py-1 text-xs font-medium', meta.className)}>
    {status === 'completed' ? <Check className="size-3" strokeWidth={2.5} /> : <span className={cn('size-1.5 bg-current', status === 'running' && 'animate-pulse-soft')} />}{meta.label}
  </span>;
}
export function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-[2px] border border-border/70 bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground', className)}>{children}</span>;
}
