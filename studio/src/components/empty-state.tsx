import type { LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: string; action?: ReactNode }) {
  return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative flex flex-col items-center overflow-hidden px-6 py-16 text-center">
    <div className="pointer-events-none absolute inset-x-8 top-8 flex flex-col gap-5 opacity-50">{[0, 1, 2].map(i => <div key={i} className="flex items-center gap-3"><span className="font-mono text-[8px] text-muted-foreground">0{i + 1}</span><div className="h-px flex-1 bg-border" /></div>)}</div>
    <motion.div initial={{ scale: .9, rotate: -3 }} animate={{ scale: 1, rotate: 0 }} transition={{ delay: .08 }} className="relative mb-5 flex size-14 items-center justify-center rounded-[3px] border border-primary/25 bg-accent text-primary shadow-none"><Icon className="size-6" /></motion.div>
    <h3 className="relative font-semibold tracking-tight">{title}</h3><p className="relative mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
    {action && <div className="relative mt-5">{action}</div>}</motion.div>;
}
