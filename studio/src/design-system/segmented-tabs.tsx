import type { ComponentType } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { SPRING_INDICATOR } from './motion';

export interface SegmentedTabItem<T extends string = string> {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  count?: number | string;
  disabled?: boolean;
}

/**
 * Global unified tab control with a shared spring sliding indicator.
 * Used consistently across ConfigLibrary, ConnectionsPage, ResultsPage, RunPage, and composers.
 */
export function SegmentedTabs<T extends string>({
  id,
  value,
  onValueChange,
  items,
  ariaLabel,
  className,
  size = 'md',
}: {
  id: string;
  value: T;
  onValueChange: (value: T) => void;
  items: readonly SegmentedTabItem<T>[];
  ariaLabel?: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex max-w-full flex-wrap items-center rounded-[3px] border bg-muted/75 p-1 text-muted-foreground',
        className,
      )}
    >
      {items.map(item => {
        const active = item.value === value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => {
              if (!item.disabled && item.value !== value) onValueChange(item.value);
            }}
            className={cn(
              'relative inline-flex items-center justify-center gap-2 rounded-[2px] font-medium transition-colors duration-150 focus-visible:z-10 disabled:cursor-not-allowed disabled:opacity-45',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3.5 text-sm',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-tabs-${id}`}
                transition={SPRING_INDICATOR}
                className="absolute inset-0 rounded-[2px] border border-border/80 bg-card shadow-xs"
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5 whitespace-nowrap">
              {Icon && <Icon className="size-3.5 shrink-0" />}
              <span>{item.label}</span>
              {item.count !== undefined && (
                <span className="font-mono text-[10px] opacity-70">{item.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
