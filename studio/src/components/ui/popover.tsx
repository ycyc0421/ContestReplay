import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export function PopoverContent({ className, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return <PopoverPrimitive.Portal><PopoverPrimitive.Content sideOffset={6} align="end" className={cn('z-50 w-64 rounded-[3px] border bg-card p-4 text-card-foreground shadow-xl animate-select-in', className)} {...props} /></PopoverPrimitive.Portal>;
}
