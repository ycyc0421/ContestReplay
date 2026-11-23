import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { PANEL_TRANSITION } from './motion';

export function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  children,
  className,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('rounded-[3px] border bg-muted/20', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('text-foreground', !open && 'text-muted-foreground')}>{title}</span>
          {summary && !open && (
            <span className="truncate font-normal text-muted-foreground/80">· {summary}</span>
          )}
        </span>
        <ChevronDown className={cn('size-4 shrink-0 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={PANEL_TRANSITION}
            className="overflow-hidden"
          >
            <div className="border-t px-4 py-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
