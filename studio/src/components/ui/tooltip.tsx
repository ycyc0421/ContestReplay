import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
export const TooltipProvider = TooltipPrimitive.Provider;
export function Tooltip({ children, content, ...props }: ComponentProps<typeof TooltipPrimitive.Root> & { children: ReactNode; content: ReactNode }) {
  return <TooltipPrimitive.Root {...props}><TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger><TooltipPrimitive.Portal>
    <TooltipPrimitive.Content sideOffset={6} className={cn('z-50 rounded-[2px] bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md data-[state=delayed-open]:animate-tooltip-in data-[state=instant-open]:animate-tooltip-in data-[state=closed]:animate-tooltip-out')}>{content}<TooltipPrimitive.Arrow className="fill-foreground" /></TooltipPrimitive.Content>
  </TooltipPrimitive.Portal></TooltipPrimitive.Root>;
}
