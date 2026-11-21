import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm, loading }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; confirmLabel: string;
  onConfirm: () => void; loading?: boolean;
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#080d18]/55 backdrop-blur-[3px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
      <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[4px] border bg-card p-6 shadow-2xl data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out">
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-[2px] p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="关闭"><X className="size-4" /></DialogPrimitive.Close>
        <div className="mb-4 flex size-10 items-center justify-center rounded-[3px] bg-red-500/10 text-danger"><AlertTriangle className="size-5" /></div>
        <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-2 text-sm leading-6 text-muted-foreground">{description}</DialogPrimitive.Description>
        <div className="mt-6 flex justify-end gap-2"><Button variant="secondary" onClick={() => onOpenChange(false)}>返回</Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>{confirmLabel}</Button></div>
      </DialogPrimitive.Content></DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export function DialogContent({ children, className }: { children: ReactNode; className?: string }) {
  return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#080d18]/55 backdrop-blur-[3px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
    <DialogPrimitive.Content className={cn('fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[4px] border bg-card p-6 shadow-2xl data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out', className)}>
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-[2px] p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="关闭"><X className="size-4" /></DialogPrimitive.Close>{children}
    </DialogPrimitive.Content></DialogPrimitive.Portal>;
}
export function DialogHeader({ title, description }: { title: string; description: string }) {
  return <div className="mb-6 pr-8"><DialogPrimitive.Title className="text-lg font-semibold tracking-tight">{title}</DialogPrimitive.Title><DialogPrimitive.Description className="mt-2 text-sm leading-6 text-muted-foreground">{description}</DialogPrimitive.Description></div>;
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="rounded-[3px] border border-primary/15 bg-accent/55 px-4 py-3 text-sm leading-6 text-muted-foreground">{children}</div>;
}
