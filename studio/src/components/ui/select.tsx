import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Select({ children, ...props }: ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root {...props}><SelectPrimitive.Trigger className="flex h-10 w-full items-center justify-between rounded-[2px] border bg-card px-3 text-left text-sm shadow-xs outline-none transition hover:border-muted-foreground/35 focus:border-primary focus:ring-1 focus:ring-primary/15 data-[placeholder]:text-muted-foreground [&[data-state=open]_svg]:rotate-180">
    <SelectPrimitive.Value /><SelectPrimitive.Icon><ChevronDown className="size-4 text-muted-foreground transition-transform data-[state=open]:rotate-180" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger><SelectPrimitive.Portal><SelectPrimitive.Content position="popper" sideOffset={6} className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[3px] border bg-card p-1 text-card-foreground shadow-xl data-[state=open]:animate-select-in data-[state=closed]:animate-select-out">
    <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
  </SelectPrimitive.Content></SelectPrimitive.Portal></SelectPrimitive.Root>;
}
export function SelectItem({ children, className, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item className={cn('relative flex h-9 cursor-default select-none items-center rounded-[2px] py-2 pl-3 pr-8 text-sm outline-none transition-colors focus:bg-accent focus:text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator className="absolute right-2.5"><Check className="size-4 text-primary" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}
