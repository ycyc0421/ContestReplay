import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { Activity, BarChart3, Braces, FilePlus2, FolderCog, Link2, Menu, Moon, ShieldCheck, Sun, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Toaster } from 'sonner';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PANEL_TRANSITION, SPRING_INDICATOR } from '@/design-system/motion';

const navGroups = [
  {
    label: '评测工作台',
    range: '01—03',
    items: [
      { num: '01', to: '/', label: '运行总览', icon: Activity, exact: true },
      { num: '02', to: '/batches/new', label: '新建批次', icon: FilePlus2, exact: false },
      { num: '03', to: '/results', label: '结果分析', icon: BarChart3, exact: false },
    ],
  },
  {
    label: '资产与连接',
    range: '04—05',
    items: [
      { num: '04', to: '/configs', label: '配置库', icon: FolderCog, exact: false },
      { num: '05', to: '/connections', label: '连接与凭据', icon: Link2, exact: false, aliases: ['/providers'] },
    ],
  },
] as const;

function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem('cr.theme') === 'dark' ||
    (!localStorage.getItem('cr.theme') && window.matchMedia('(prefers-color-scheme: dark)').matches));
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); localStorage.setItem('cr.theme', dark ? 'dark' : 'light'); }, [dark]);
  return <motion.button whileTap={{ scale: .92 }} className="rounded-[3px] p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => setDark(v => !v)} aria-label={dark ? '切换浅色主题' : '切换深色主题'}>
    <motion.span key={dark ? 'sun' : 'moon'} initial={{ opacity: 0, rotate: -25 }} animate={{ opacity: 1, rotate: 0 }} className="block">{dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}</motion.span></motion.button>;
}
function Brand() {
  return <Link to="/" className="group flex items-center gap-3">
    <motion.span whileHover={{ rotate: -4, scale: 1.04 }} className="flex size-9 items-center justify-center rounded-[3px] bg-primary text-primary-foreground shadow-none"><Braces className="size-5" strokeWidth={2.2} /></motion.span>
    <span><span className="block text-[15px] font-semibold tracking-[-0.025em]">ContestReplay</span><span className="mt-0.5 block font-mono text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Local Studio</span></span>
  </Link>;
}
function NavItems({ onNavigate, id }: { onNavigate?: () => void; id: string }) {
  const pathname = useLocation({ select: location => location.pathname });
  return <nav className="space-y-6" aria-label="主导航">
    {navGroups.map(group => <div key={group.label}>
      <div className="mb-2 flex items-center justify-between px-3 text-[11px] font-medium text-muted-foreground">
        <span>{group.label}</span><span className="font-mono text-[9px] tracking-[0.14em] opacity-75">{group.range}</span>
      </div>
      <div className="space-y-1">{group.items.map(item => {
        const Icon = item.icon;
        const aliases = 'aliases' in item ? item.aliases : [];
        const active = item.to === '/' && pathname.startsWith('/runs/')
          ? true
          : item.exact
            ? pathname === item.to
            : pathname.startsWith(item.to) || aliases.some(alias => pathname.startsWith(alias));
        return <Link key={item.to} to={item.to} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cn('relative flex h-10 items-center gap-2.5 rounded-[3px] px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground', active && 'text-foreground hover:bg-transparent')}>
          {active && <motion.span layoutId={`${id}-active`} transition={SPRING_INDICATOR} className="absolute inset-0 rounded-[3px] border-l-2 border-primary bg-accent" />}
          <span className="relative font-mono text-[10px] opacity-55">{item.num}</span>
          <Icon className="relative size-[16px]" />
          <span className="relative">{item.label}</span>
          {active && <motion.span layoutId={`${id}-dot`} transition={SPRING_INDICATOR} className="relative ml-auto h-3.5 w-0.5 bg-primary" />}
        </Link>;
      })}</div>
    </div>)}
  </nav>;
}
export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useLocation({ select: location => location.pathname });
  const reduced = useReducedMotion();
  return <TooltipProvider delayDuration={350}><div className="min-h-screen">
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[236px] flex-col border-r bg-sidebar px-4 py-5 lg:flex">
      <div className="px-2"><Brand /></div>
      <div className="mt-9"><NavItems id="desktop" /></div>
      <div className="mt-auto overflow-hidden rounded-[3px] border bg-card p-3.5">
        <div className="flex items-center gap-2 text-xs font-medium"><ShieldCheck className="size-4 text-primary" />仅在本机运行</div>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">配置、日志与凭据仅存储在本地工作区，不上传公共服务。</p>
      </div>
      <div className="mt-4 flex items-center justify-between px-2 font-mono text-[10px] text-muted-foreground"><span>CR · v0.3</span><span className="flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-primary" />LOCAL</span></div>
    </aside>
    <div className="lg:pl-[236px]">
      <header className="sticky top-0 z-20 flex h-15 items-center justify-between border-b bg-background/90 px-4 backdrop-blur-md sm:px-7 lg:px-9">
        <div className="lg:hidden"><Brand /></div>
        <div className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex"><span className="size-1.5 rounded-full bg-primary" /><span>本机工作区在线</span><span className="text-border">/</span><span className="font-mono text-[11px]">127.0.0.1</span></div>
        <div className="flex items-center gap-1"><ThemeToggle /><button className="rounded-[3px] p-2 text-muted-foreground transition hover:bg-muted lg:hidden" onClick={() => setMobileOpen(v => !v)} aria-label={mobileOpen ? '关闭导航' : '打开导航'}>{mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}</button></div>
      </header>
      {reduced ? (
        mobileOpen ? <div className="border-b bg-sidebar lg:hidden"><div className="p-3"><NavItems id="mobile" onNavigate={() => setMobileOpen(false)} /></div></div> : null
      ) : (
        <AnimatePresence initial={false}>{mobileOpen && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={PANEL_TRANSITION} className="overflow-hidden border-b bg-sidebar lg:hidden"><div className="p-3"><NavItems id="mobile" onNavigate={() => setMobileOpen(false)} /></div></motion.div>}</AnimatePresence>
      )}
      <main className="workspace-grid mx-auto min-h-[calc(100vh-3.75rem)] w-full max-w-[1500px] px-4 py-7 sm:px-7 sm:py-9 lg:px-9">
        <motion.div key={pathname} initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? { duration: 0 } : PANEL_TRANSITION}><Outlet /></motion.div>
      </main>
    </div>
    <Toaster position="bottom-right" toastOptions={{ className: '!font-sans' }} closeButton />
  </div></TooltipProvider>;
}
