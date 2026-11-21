import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('inline-flex h-10 items-center rounded-[3px] bg-muted p-1 text-muted-foreground', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn('relative inline-flex h-8 items-center justify-center gap-2 rounded-[2px] px-3 text-sm font-medium transition-[color,background-color,box-shadow] hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-primary data-[state=active]:shadow-xs', className)} {...props} />;
}
export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('outline-none data-[state=inactive]:hidden', className)} {...props} />;
}
