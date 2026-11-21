import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva('inline-flex items-center justify-center gap-2 rounded-[3px] font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150 active:scale-[.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0', {
  variants: {
    variant: {
      primary: 'border border-primary bg-primary text-primary-foreground hover:opacity-85',
      secondary: 'border bg-card text-foreground shadow-xs hover:border-muted-foreground/30 hover:bg-muted',
      ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
      danger: 'bg-red-600 text-white shadow-xs hover:bg-red-700',
    },
    size: { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', icon: 'size-9' },
  },
  defaultVariants: { variant: 'primary', size: 'md' },
});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}
export function Button({ className, variant, size, asChild, loading, children, disabled, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {asChild ? children : <>{loading && <LoaderCircle className="size-4 animate-spin" />}{children}</>}
  </Comp>;
}
