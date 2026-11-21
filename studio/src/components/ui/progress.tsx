import * as ProgressPrimitive from '@radix-ui/react-progress';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
export function Progress({ value, className, label }: { value: number; className?: string; label?: string }) {
  const normalized = Math.max(0, Math.min(100, value));
  return <ProgressPrimitive.Root value={normalized} aria-label={label} className={cn('relative h-1.5 w-full overflow-hidden bg-muted', className)}>
    <ProgressPrimitive.Indicator asChild><motion.div className="h-full bg-primary" initial={false} animate={{ width: `${normalized}%` }} transition={{ duration: .3, ease: 'easeOut' }} /></ProgressPrimitive.Indicator>
  </ProgressPrimitive.Root>;
}
