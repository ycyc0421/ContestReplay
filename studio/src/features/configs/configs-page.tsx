import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, FileCheck2, FilePlus2, LockKeyhole, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { AgentItemResponse, ContestItemResponse } from '@studio-api';
import { Card, PageHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { AgentForm } from './agent-form';
import { ContestForm } from './contest-form';
import { ConfigLibrary } from './config-library';

export function ConfigsPage() {
  const [tab, setTab] = useState('agent');
  const [agent, setAgent] = useState<AgentItemResponse>();
  const [contest, setContest] = useState<ContestItemResponse>();
  const client = useQueryClient();
  const refresh = () => {
    void Promise.all([
      client.invalidateQueries({ queryKey: ['catalog'] }),
      client.invalidateQueries({ queryKey: ['matrix'] }),
      client.invalidateQueries({ queryKey: ['preflight'] }),
      client.invalidateQueries({ queryKey: ['coverage'] }),
      client.invalidateQueries({ queryKey: ['agent-item'] }),
      client.invalidateQueries({ queryKey: ['contest-item'] }),
    ]);
  };
  const editAgent = (item: AgentItemResponse) => { setAgent(item); setTab('agent'); document.getElementById('config-editor')?.scrollIntoView({ block: 'start' }); };
  const editContest = (item: ContestItemResponse) => { setContest(item); setTab('contest'); document.getElementById('config-editor')?.scrollIntoView({ block: 'start' }); };
  const deletedAgent = (path: string) => { setAgent(current => current?.path === path ? undefined : current); refresh(); };
  const deletedContest = (path: string) => { setContest(current => current?.path === path ? undefined : current); refresh(); };
  return <>
    <PageHeader eyebrow="06 / Configuration library" title="配置库" description="检索、编辑、克隆并派生可复现的比赛输入；不再需要手工查找 Manifest 文件。" actions={<div className="flex gap-2"><Button variant="secondary" onClick={() => { setAgent(undefined); setTab('agent'); }}><Bot className="size-4" />新建 Agent</Button><Button onClick={() => { setContest(undefined); setTab('contest'); }}><FilePlus2 className="size-4" />新建 Contest</Button></div>} />
    <div className="mb-8"><ConfigLibrary onEditAgent={editAgent} onEditContest={editContest} onDeletedAgent={deletedAgent} onDeletedContest={deletedContest} /></div>
    <div id="config-editor" className="grid scroll-mt-24 items-start gap-6 xl:grid-cols-[minmax(0,800px)_minmax(260px,1fr)]">
      <motion.div layout="size" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}><Card className="overflow-hidden">
        <Tabs value={tab} onValueChange={setTab}><div className="flex items-center justify-between border-b bg-muted/25 px-4 py-3"><TabsList className="w-full sm:w-auto"><TabsTrigger value="agent" className="flex-1 sm:flex-none"><Bot className="size-4" />{agent ? '编辑 Agent' : '新建 Agent'}</TabsTrigger><TabsTrigger value="contest" className="flex-1 sm:flex-none"><FileCheck2 className="size-4" />{contest ? '编辑 Contest' : '新建 Contest'}</TabsTrigger></TabsList>{(tab === 'agent' ? agent : contest) && <Button variant="ghost" size="sm" onClick={() => tab === 'agent' ? setAgent(undefined) : setContest(undefined)}><X className="size-3.5" />结束编辑</Button>}</div>
          <div className="p-5 sm:p-7"><TabsContent forceMount value="agent" className="data-[state=active]:animate-panel-in"><AgentForm key={agent?.path ?? 'new-agent'} initial={agent} onSaved={refresh} /></TabsContent><TabsContent forceMount value="contest" className="data-[state=active]:animate-panel-in"><ContestForm key={contest?.path ?? 'new-contest'} initial={contest} onSaved={refresh} /></TabsContent></div>
        </Tabs></Card></motion.div>
      <motion.aside initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: .08 }}><Card className="p-5 xl:sticky xl:top-24">
        <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-primary">Evaluation contract</div><h2 className="mt-2 text-sm font-semibold">一次配置，一场可复现的比赛</h2>
        <div className="mt-6 space-y-5">{[
          ['01', '定义输入', '明确 Harness、模型、题面和判题后端。'],
          ['02', '锁定修订', '计划记录配置内容、材料摘要和协议版本。'],
          ['03', '进入矩阵', '将多个 Agent 与 Contest 组合为批次任务。'],
        ].map(([index, title, description]) => <div key={index} className="grid grid-cols-[28px_1fr] gap-3"><span className="font-mono text-[10px] text-primary">{index}</span><div><div className="text-xs font-medium">{title}</div><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{description}</p></div></div>)}</div>
        <Separator className="my-6" /><div className="flex gap-3"><LockKeyhole className="mt-0.5 size-4 shrink-0 text-primary" /><div><div className="text-xs font-medium">凭据边界</div><p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">密钥只由本机连接服务使用，不进入 Manifest、日志或沙盒。私有题面与判题材料不会通过静态资源公开。</p></div></div>
      </Card></motion.aside>
    </div>
  </>;
}
