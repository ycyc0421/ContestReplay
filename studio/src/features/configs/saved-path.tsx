import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
export function SavedPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(path); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return <div className="rounded-[3px] border border-primary/20 bg-primary/5 animate-fade-in p-4">
    <div className="flex items-center justify-between gap-3"><span className="text-xs font-medium text-success">配置已保存</span><button type="button" onClick={copy} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? '已复制' : '复制路径'}</button></div>
    <code className="mt-2 block break-all font-mono text-xs">{path}</code>
    <Link to="/batches/new" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">用于新建批次<ArrowUpRight className="size-3.5" /></Link>
  </div>;
}
