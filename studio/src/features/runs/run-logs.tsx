import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, Check, Clipboard, FileTerminal, RotateCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

function useIncrementalLog(runId: string, stream: 'stdout' | 'stderr', active: boolean) {
  const [offset, setOffset] = useState(0);
  const [content, setContent] = useState('');
  const [totalBytes, setTotalBytes] = useState(0);
  const processed = useRef('');
  useEffect(() => { setOffset(0); setContent(''); setTotalBytes(0); processed.current = ''; }, [runId, stream]);
  const query = useQuery({
    queryKey: ['log-slice', runId, stream, offset],
    queryFn: () => studioApi.logSlice(runId, stream, offset),
    refetchInterval: active ? 1_000 : false,
  });
  useEffect(() => {
    const data = query.data;
    if (!data) return;
    const marker = `${data.offset}:${data.next_offset}:${data.total_bytes}`;
    if (processed.current === marker) return;
    processed.current = marker;
    setTotalBytes(data.total_bytes);
    if (data.offset === 0 && offset > 0) setContent(data.chunk);
    else if (data.chunk) setContent(value => value + data.chunk);
    if (data.next_offset > data.offset) setOffset(data.next_offset);
  }, [query.data, offset]);
  return { ...query, content, totalBytes };
}

export function RunLogs({ runId, running }: { runId: string; running: boolean }) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const logs = useIncrementalLog(runId, stream, running);
  const content = logs.content;
  useEffect(() => { if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [content, stream, follow]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(content); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { toast.error('无法复制日志'); }
  };
  const lines = content ? content.split('\n').length : 0;
  return <Card className="overflow-hidden border-[#343537] bg-[#141516] text-[#e7e7e3] shadow-[0_16px_50px_rgba(0,0,0,.14)]">
    <Tabs value={stream} onValueChange={value => setStream(value as 'stdout' | 'stderr')}><div className="flex flex-col border-b border-white/10 sm:flex-row sm:items-center sm:justify-between">
      <TabsList className="h-auto rounded-none bg-transparent p-0 px-3 pt-2">{(['stdout', 'stderr'] as const).map(name => <TabsTrigger key={name} value={name} className="relative h-11 rounded-none bg-transparent px-3 font-mono text-xs text-white/40 shadow-none hover:text-white/75 data-[state=active]:bg-transparent data-[state=active]:text-[#f0f0eb] data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-transparent after:transition-colors data-[state=active]:after:bg-[#d8d8d2]"><FileTerminal className="size-3.5" />{name}</TabsTrigger>)}</TabsList>
      <div className="flex items-center gap-1 px-3 py-2"><Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" onClick={() => setFollow(value => !value)}><ArrowDown className={cn('size-3.5 transition-colors', follow && 'text-[#f0f0eb]')} />{follow ? '跟随中' : '跟随'}</Button>
        <Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" onClick={() => void logs.refetch()}><RotateCw className="size-3.5" />刷新</Button>
        <Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" disabled={!content} onClick={() => void copy()}><AnimatePresence mode="wait" initial={false}><motion.span key={copied ? 'check' : 'copy'} initial={{ opacity: 0, scale: .7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .7 }}>{copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}</motion.span></AnimatePresence>{copied ? '已复制' : '复制'}</Button></div>
    </div></Tabs>
    <div className="relative"><pre ref={logRef} onScroll={event => { const element = event.currentTarget; if (follow && element.scrollTop + element.clientHeight + 24 < element.scrollHeight) setFollow(false); }} className="log-view scrollbar-thin h-[min(64vh,720px)] min-h-[360px] overflow-auto whitespace-pre p-5 font-mono text-xs leading-[1.75] text-[#c4c5c1]">{content || (logs.isLoading ? '正在读取日志…' : logs.isError ? `读取失败：${(logs.error as Error).message}` : `暂无 ${stream} 输出。`)}</pre><div className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-[#141516] to-transparent" /></div>
    <div className="flex items-center justify-between border-t border-white/10 px-5 py-2.5 font-mono text-[10px] text-white/35"><span>{lines} lines · {formatBytes(logs.totalBytes)} · UTF-8</span><span className="flex items-center gap-1.5">{running && <i className="size-1.5 animate-pulse bg-[#f0f0eb]" />}{running ? 'INCREMENTAL · 1s' : 'LOCAL LOG'}</span></div>
  </Card>;
}
