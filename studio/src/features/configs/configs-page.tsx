import { Bot, FileCheck2, LockKeyhole } from 'lucide-react';
import { motion } from 'motion/react';
import { Card, PageHeader } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { AgentForm } from './agent-form';
import { ContestForm } from './contest-form';

export function ConfigsPage() {
  return <>
    <PageHeader eyebrow="03 / Configuration" title="配置工具" description="定义确定的比赛输入。配置即契约，保存后即可进入执行矩阵。" />
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,800px)_minmax(260px,1fr)]">
      <motion.div layout="size" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}><Card className="overflow-hidden">
        <Tabs defaultValue="agent"><div className="border-b bg-muted/25 px-4 py-3"><TabsList className="w-full sm:w-auto"><TabsTrigger value="agent" className="flex-1 sm:flex-none"><Bot className="size-4" />新建 Agent</TabsTrigger><TabsTrigger value="contest" className="flex-1 sm:flex-none"><FileCheck2 className="size-4" />新建 Contest</TabsTrigger></TabsList></div>
          <div className="p-5 sm:p-7"><TabsContent forceMount value="agent" className="data-[state=active]:animate-panel-in"><AgentForm /></TabsContent><TabsContent forceMount value="contest" className="data-[state=active]:animate-panel-in"><ContestForm /></TabsContent></div>
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
