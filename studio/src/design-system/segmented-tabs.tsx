import { useRef, type ComponentType, type KeyboardEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
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
 * Global unified tab control implementing the WAI-ARIA Tabs pattern:
 * - Roving tabIndex (only active tab is in Tab sequence)
 * - ArrowLeft / ArrowRight / Home / End keyboard navigation
 * - Shared spring sliding pill indicator (respecting prefers-reduced-motion)
 */
export function SegmentedTabs<T extends string>({
  id,
  value,
  onValueChange,
  items,
  ariaLabel,
  panelIdPrefix,
  className,
  size = 'md',
}: {
  id: string;
  value: T;
  onValueChange: (value: T) => void;
  items: readonly SegmentedTabItem<T>[];
  ariaLabel?: string;
  panelIdPrefix?: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const reduced = useReducedMotion();
  const buttonRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const enabledItems = items.filter(item => !item.disabled);

  const activateAt = (nextItem: SegmentedTabItem<T>) => {
    if (nextItem.value !== value) onValueChange(nextItem.value);
    buttonRefs.current.get(nextItem.value)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentValue: T) => {
    if (!enabledItems.length) return;
    const idx = enabledItems.findIndex(item => item.value === currentValue);
    if (idx < 0) return;

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      activateAt(enabledItems[(idx + 1) % enabledItems.length]!);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      activateAt(enabledItems[(idx - 1 + enabledItems.length) % enabledItems.length]!);
    } else if (event.key === 'Home') {
      event.preventDefault();
      activateAt(enabledItems[0]!);
    } else if (event.key === 'End') {
      event.preventDefault();
      activateAt(enabledItems[enabledItems.length - 1]!);
    }
  };

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
            ref={el => {
              if (el) buttonRefs.current.set(item.value, el);
              else buttonRefs.current.delete(item.value);
            }}
            id={`${id}-tab-${item.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelIdPrefix ? `${panelIdPrefix}-${item.value}` : undefined}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onKeyDown={event => handleKeyDown(event, item.value)}
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
                transition={reduced ? { duration: 0 } : SPRING_INDICATOR}
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
