import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return <label className={cn('block space-y-2', className)}>
    <span className="flex items-center justify-between gap-3 text-sm font-medium"><span>{label}</span>{hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}</span>
    {children}{error && <span role="alert" className="block text-xs text-danger animate-fade-in">{error}</span>}
  </label>;
}
const inputClass = 'w-full rounded-[2px] border bg-card px-3 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted-foreground/65 hover:border-muted-foreground/35 focus:border-primary focus:ring-1 focus:ring-primary/15 disabled:opacity-50';
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClass, 'h-10', className)} {...props} />;
}
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputClass, 'min-h-28 resize-y py-2.5 font-mono text-[13px] leading-6', className)} {...props} />;
}
