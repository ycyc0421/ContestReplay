import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { Activity, Braces, FilePlus2, FolderCog, KeyRound, Menu, Moon, ShieldCheck, Sun, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Toaster } from 'sonner';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';

const nav = [
  { to: '/', label: '运行总览', icon: Activity, exact: true },
  { to: '/batches/new', label: '新建批次', icon: FilePlus2, exact: false },
  { to: '/configs', label: '配置工具', icon: FolderCog, exact: false },
  { to: '/providers', label: 'Providers', icon: KeyRound, exact: false },
] as const;

function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem('cr.theme') === 'dark' ||
    (!localStorage.getItem('cr.theme') && window.matchMedia('(prefers-color-scheme: dark)').matches));
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); localStorage.setItem('cr.theme', dark ? 'dark' : 'light'); }, [dark]);
  return <motion.button whileTap={{ scale: .92 }} className="rounded-[2px] p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => setDark(v => !v)} aria-label={dark ? '切换浅色主题' : '切换深色主题'}>
    <motion.span key={dark ? 'sun' : 'moon'} initial={{ opacity: 0, rotate: -25 }} animate={{ opacity: 1, rotate: 0 }} className="block">{dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}</motion.span></motion.button>;
}
function Brand() {
  return <Link to="/" className="group flex items-center gap-3">
    <motion.span whileHover={{ rotate: -4, scale: 1.04 }} className="flex size-9 items-center justify-center rounded-[3px] bg-primary text-primary-foreground shadow-none"><Braces className="size-5" strokeWidth={2.2} /></motion.span>
    <span><span className="block text-[15px] font-semibold tracking-[-0.025em]">ContestReplay</span><span className="mt-0.5 block font-mono text-[9px] font-medium uppercase tracking-[0.23em] text-muted-foreground">Replay console</span></span>
  </Link>;
}
function NavItems({ onNavigate, id }: { onNavigate?: () => void; id: string }) {
  const pathname = useLocation({ select: location => location.pathname });
  return <nav className="space-y-1" aria-label="主导航">{nav.map(({ to, label, icon: Icon, exact }) => {
    const active = to === '/' && pathname.startsWith('/runs/') ? true : exact ? pathname === to : pathname.startsWith(to);
    return <Link key={to} to={to} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cn('relative flex h-10 items-center gap-3 rounded-none px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground', active && 'text-primary')}>
      {active && <motion.span layoutId={`${id}-active`} transition={{ type: 'spring', stiffness: 450, damping: 36 }} className="absolute inset-0 border-l-2 border-primary bg-accent" />}
      <Icon className="relative size-[17px]" /><span className="relative">{label}</span>{active && <motion.span layoutId={`${id}-dot`} className="relative ml-auto h-4 w-px bg-primary" />}
    </Link>;
  })}</nav>;
}
export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useLocation({ select: location => location.pathname });
  return <TooltipProvider delayDuration={350}><div className="min-h-screen">
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r bg-sidebar px-4 py-5 lg:flex">
      <div className="px-2"><Brand /></div>
      <div className="mt-10"><div className="mb-3 flex items-center justify-between px-3 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"><span>Workspace</span><span>01—04</span></div><NavItems id="desktop" /></div>
      <div className="mt-auto overflow-hidden rounded-[3px] border bg-card p-3.5">
        <div className="flex items-center gap-2 text-xs font-medium"><ShieldCheck className="size-4 text-primary" />仅在本机运行</div>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">配置、日志和凭据不会上传至公共服务。</p>
        <div className="mt-3 flex gap-1">{[0, 1, 2, 3, 4].map(i => <span key={i} className={cn('h-0.5 flex-1', i === 0 ? 'bg-primary' : 'bg-border')} />)}</div>
      </div>
      <div className="mt-4 flex items-center justify-between px-2 font-mono text-[10px] text-muted-foreground"><span>CR · v0.2</span><span className="flex items-center gap-1.5"><i className="size-1.5 bg-primary" />LOCAL</span></div>
    </aside>
    <div className="lg:pl-[232px]">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-y border-t-2 border-t-primary bg-background/90 px-4 backdrop-blur-md sm:px-7 lg:px-9">
        <div className="lg:hidden"><Brand /></div>
        <div className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground lg:flex"><span className="size-1.5 bg-primary" />Workspace online<span className="mx-1 text-border">/</span><span>127.0.0.1</span></div>
        <div className="flex items-center gap-1"><ThemeToggle /><button className="rounded-[2px] p-2 text-muted-foreground transition hover:bg-muted lg:hidden" onClick={() => setMobileOpen(v => !v)} aria-label={mobileOpen ? '关闭导航' : '打开导航'}>{mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}</button></div>
      </header>
      <AnimatePresence initial={false}>{mobileOpen && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-b bg-sidebar lg:hidden"><div className="p-3"><NavItems id="mobile" onNavigate={() => setMobileOpen(false)} /></div></motion.div>}</AnimatePresence>
      <main className="workspace-grid mx-auto min-h-[calc(100vh-4rem)] w-full max-w-[1500px] px-4 py-7 sm:px-7 sm:py-9 lg:px-9">
        <motion.div key={pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .2, ease: [0.22, 1, 0.36, 1] }}><Outlet /></motion.div>
      </main>
    </div>
    <Toaster position="bottom-right" toastOptions={{ className: '!font-sans' }} closeButton />
  </div></TooltipProvider>;
}
