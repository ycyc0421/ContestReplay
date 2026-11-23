import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react';
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const SPRING_INDICATOR: Transition = { type: 'spring', stiffness: 500, damping: 38, mass: 0.85 };
export const PANEL_TRANSITION: Transition = { duration: 0.16, ease: [0.22, 1, 0.36, 1] };

/**
 * Unified content transition primitive.
 * Intentionally avoids Framer Motion layout="size" (which applies scaleY distortion to text/forms).
 */
export function AnimatedPanel({
  panelKey,
  children,
  className,
  role,
  id,
  ariaLabelledBy,
}: {
  panelKey: string | number;
  children: ReactNode;
  className?: string;
  role?: string;
  id?: string;
  ariaLabelledBy?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={panelKey}
        id={id}
        role={role}
        aria-labelledby={ariaLabelledBy}
        initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -3 }}
        transition={reduced ? { duration: 0 } : PANEL_TRANSITION}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Opaque right-side slide-over drawer (Scheme A).
 * Built on Radix Dialog for focus trapping, ESC handling, and accessible dialog semantics.
 * Restores focus cleanly to the initiating trigger (or <main> fallback) on close.
 */
export function SlideDrawer({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  headerActions,
  footer,
  widthClass = 'max-w-[780px]',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: string;
  title: string;
  description?: string;
  headerActions?: ReactNode;
  footer?: ReactNode;
  widthClass?: string;
  children: ReactNode;
}) {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
    }
    wasOpenRef.current = open;
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <DialogPrimitive.Content
          {...(!description ? { 'aria-describedby': undefined } : {})}
          onCloseAutoFocus={event => {
            event.preventDefault();
            const target = openerRef.current;
            if (target && target.isConnected && typeof target.focus === 'function') {
              target.focus();
            } else {
              const main = document.querySelector('main');
              if (main instanceof HTMLElement) {
                if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
                main.focus();
              }
            }
          }}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-card text-card-foreground shadow-2xl outline-none data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out',
            widthClass,
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b bg-background/80 px-6 py-4">
            <div className="min-w-0">
              {eyebrow && (
                <div className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-primary">
                  {eyebrow}
                </div>
              )}
              <DialogPrimitive.Title className="truncate text-lg font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-xs leading-5 text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {headerActions}
              <DialogPrimitive.Close
                aria-label="关闭抽屉"
                className="rounded-[3px] p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {children}
          </div>

          {footer && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-background/85 px-6 py-3.5">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
