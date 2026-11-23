import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, Check, Clipboard, FileTerminal, RotateCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { queryKeys } from '@/state/query-keys';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SPRING_INDICATOR } from '@/design-system/motion';

function useIncrementalLog(runId: string, stream: 'stdout' | 'stderr', active: boolean) {
  const [offset, setOffset] = useState(0);
  const [content, setContent] = useState('');
  const [totalBytes, setTotalBytes] = useState(0);
  const [draining, setDraining] = useState(true);
  const processed = useRef('');
  const fetchCounter = useRef(0);
  const requiredGen = useRef(1);
  const prevActive = useRef(active);
  const query = useQuery({
    queryKey: queryKeys.logSlice(runId, stream, offset),
    queryFn: async () => {
      const gen = ++fetchCounter.current;
      const slice = await studioApi.logSlice(runId, stream, offset);
      return { slice, gen };
    },
    refetchInterval: active || draining ? 1_000 : false,
  });
  useEffect(() => {
    if (prevActive.current && !active) {
      requiredGen.current = fetchCounter.current + 1;
      setDraining(true);
      void query.refetch();
    } else if (!prevActive.current && active) {
      setDraining(true);
    }
    prevActive.current = active;
  }, [active, query.refetch]);
  useEffect(() => {
    const data = query.data;
    if (!data) return;
    const { slice, gen } = data;
    if (slice.stream !== stream) return;
    if (slice.offset !== offset && !(slice.offset === 0 && offset > 0)) return;
    const marker = `${runId}:${stream}:${slice.offset}:${slice.next_offset}:${slice.total_bytes}:${slice.chunk.length}`;
    if (processed.current !== marker) {
      processed.current = marker;
      setTotalBytes(slice.total_bytes);
      if (slice.offset === 0 && offset > 0) setContent(slice.chunk);
      else if (slice.chunk) setContent(value => value + slice.chunk);
      if (slice.next_offset > slice.offset) {
        setOffset(slice.next_offset);
        return;
      }
    }
    if (!active && draining && slice.next_offset === slice.offset && !slice.has_more && gen >= requiredGen.current) {
      setDraining(false);
    }
  }, [query.data, offset, draining, active, runId, stream]);
  return {
    ...query,
    content,
    totalBytes,
    drain: () => {
      requiredGen.current = fetchCounter.current + 1;
      setDraining(true);
      void query.refetch();
    },
  };
}

function LogStreamPanel({ runId, stream, running, onStreamChange }: {
  runId: string; stream: 'stdout' | 'stderr'; running: boolean; onStreamChange: (stream: 'stdout' | 'stderr') => void;
}) {
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
    <div className="flex flex-col border-b border-white/10 sm:flex-row sm:items-center sm:justify-between">
      <div role="tablist" aria-label="日志流" className="flex items-center px-3 pt-1">
        {(['stdout', 'stderr'] as const).map(name => {
          const active = stream === name;
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onStreamChange(name)}
              className={cn(
                'relative inline-flex h-11 items-center gap-1.5 px-3 font-mono text-xs transition-colors',
                active ? 'text-[#f0f0eb]' : 'text-white/40 hover:text-white/75',
              )}
            >
              <FileTerminal className="size-3.5" />
              {name}
              {active && <motion.span layoutId={`log-stream-${runId}`} transition={SPRING_INDICATOR} className="absolute inset-x-3 bottom-0 h-0.5 bg-[#d8d8d2]" />}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1 px-3 py-2"><Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" onClick={() => setFollow(value => !value)}><ArrowDown className={cn('size-3.5 transition-colors', follow && 'text-[#f0f0eb]')} />{follow ? '跟随中' : '跟随'}</Button>
        <Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" onClick={() => logs.drain()}><RotateCw className="size-3.5" />刷新</Button>
        <Button variant="ghost" size="sm" className="text-white/50 hover:bg-white/10 hover:text-white" disabled={!content} onClick={() => void copy()}><AnimatePresence mode="wait" initial={false}><motion.span key={copied ? 'check' : 'copy'} initial={{ opacity: 0, scale: .7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .7 }}>{copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}</motion.span></AnimatePresence>{copied ? '已复制' : '复制'}</Button></div>
    </div>
    <div className="relative"><pre ref={logRef} onScroll={event => { const element = event.currentTarget; if (follow && element.scrollTop + element.clientHeight + 24 < element.scrollHeight) setFollow(false); }} className="log-view scrollbar-thin h-[min(64vh,720px)] min-h-[360px] overflow-auto whitespace-pre p-5 font-mono text-xs leading-[1.75] text-[#c4c5c1]">{content || (logs.isLoading ? '正在读取日志…' : logs.isError ? `读取失败：${(logs.error as Error).message}` : `暂无 ${stream} 输出。`)}</pre><div className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-[#141516] to-transparent" /></div>
    <div className="flex items-center justify-between border-t border-white/10 px-5 py-2.5 font-mono text-[10px] text-white/35"><span>{lines} 行 · {formatBytes(logs.totalBytes)} · UTF-8</span><span className="flex items-center gap-1.5">{running && <i className="size-1.5 animate-pulse bg-[#f0f0eb]" />}{running ? '增量同步 · 1s' : '本地日志'}</span></div>
  </Card>;
}

export function RunLogs({ runId, running }: { runId: string; running: boolean }) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  return <LogStreamPanel key={`${runId}:${stream}`} runId={runId} stream={stream} running={running} onStreamChange={setStream} />;
}
