import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border bg-card text-card-foreground shadow-none', className)} {...props} />;
}
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: React.ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
    <div>{eyebrow && <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</div>}
      <h1 className="text-[28px] font-semibold tracking-[-0.04em] sm:text-[32px]">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p></div>
    {actions && <div className="shrink-0">{actions}</div>}
  </div>;
}
