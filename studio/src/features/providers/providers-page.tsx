import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/fields';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog, Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';

type Provider = Awaited<ReturnType<typeof studioApi.providers>>['providers'][number];
type Editor = { mode: 'create' | 'edit'; provider?: Provider };
function SecretInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [visible, setVisible] = useState(false);
  return <Field label={label} hint="只写入，保存后不可查看"><div className="relative"><Input aria-label={label} type={visible ? 'text' : 'password'} autoComplete="off" value={value} onChange={event => onChange(event.target.value)} className="pr-10 font-mono" />
    <button type="button" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground" aria-label={visible ? '隐藏秘密' : '显示秘密'} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></Field>;
}
function ProviderEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const provider = editor.provider;
  const [id, setId] = useState('');
  const [label, setLabel] = useState(provider?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? 'https://api.openai.com/v1');
  const [secret, setSecret] = useState('');
  const client = useQueryClient();
  const save = useMutation({ mutationFn: () => editor.mode === 'create'
    ? studioApi.createProvider({ ...(id.trim() ? { id: id.trim() } : {}), label: label.trim(), protocol: 'responses', base_url: baseUrl.trim(), secret })
    : studioApi.updateProvider(provider!.id, { label: label.trim(), base_url: baseUrl.trim() }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['providers'] }); toast.success(editor.mode === 'create' ? 'Provider 已创建' : 'Provider 已更新'); onClose(); },
    onError: (error: Error) => toast.error('无法保存 Provider', { description: error.message }) });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader title={editor.mode === 'create' ? '新建 Provider' : '编辑 Provider'} description="Provider 描述 API 协议、接入地址和本机凭据。秘密不会出现在响应、Manifest 或日志中。" />
    <form className="space-y-5" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      {editor.mode === 'create' && <Field label="Provider ID" hint="可选"><Input className="font-mono text-xs" placeholder="留空则自动生成" value={id} onChange={event => setId(event.target.value)} /></Field>}
      <Field label="显示名称"><Input placeholder="OpenAI 生产环境" value={label} onChange={event => setLabel(event.target.value)} /></Field>
      <Field label="API 协议"><Input value="Responses" disabled /></Field>
      <Field label="Base URL" hint={editor.mode === 'edit' ? '跨 origin 修改需新建 Provider' : 'HTTPS 或回环 HTTP'}><Input className="font-mono text-xs" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></Field>
      {editor.mode === 'create' && <SecretInput label="API Key" value={secret} onChange={setSecret} />}
      <div className="flex gap-3 border-l-2 border-primary/25 bg-muted/25 px-3 py-3 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />秘密仅写入本机凭据库。Studio 不提供回读，沙盒内只访问受限中继。</div>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={save.isPending} disabled={!label.trim() || !baseUrl.trim() || (editor.mode === 'create' && !secret.trim())}>{editor.mode === 'create' ? '创建 Provider' : '保存修改'}</Button></div>
    </form>
  </DialogContent></Dialog>;
}
function RotateDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const [secret, setSecret] = useState('');
  const client = useQueryClient();
  const rotate = useMutation({ mutationFn: () => studioApi.rotateProvider(provider.id, secret), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['providers'] }); toast.success('凭据已轮换'); onClose();
  }, onError: (error: Error) => toast.error('轮换失败', { description: error.message }) });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader title="轮换 API Key" description={`为 ${provider.label} 写入新秘密。现有 Provider ID 和 Base URL 保持不变。`} />
    <form className="space-y-5" onSubmit={event => { event.preventDefault(); rotate.mutate(); }}><SecretInput label="新 API Key" value={secret} onChange={setSecret} />
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={rotate.isPending} disabled={!secret.trim()}>确认轮换</Button></div></form>
  </DialogContent></Dialog>;
}

export function ProvidersPage() {
  const query = useQuery({ queryKey: ['providers'], queryFn: studioApi.providers });
  const [editor, setEditor] = useState<Editor>();
  const [rotating, setRotating] = useState<Provider>();
  const [deleting, setDeleting] = useState<Provider>();
  const client = useQueryClient();
  const remove = useMutation({ mutationFn: (id: string) => studioApi.deleteProvider(id), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['providers'] }); toast.success('Provider 已删除'); setDeleting(undefined);
  }, onError: (error: Error) => { toast.error('无法删除 Provider', { description: error.message }); setDeleting(undefined); } });
  const providers = query.data?.providers ?? [];
  return <>
    <PageHeader eyebrow="04 / Provider registry" title="Providers" description="管理可复用的 API 接入配置。模型 Vendor 与 API Provider 可以独立组合。" actions={<Button onClick={() => setEditor({ mode: 'create' })}><Plus className="size-4" />新建 Provider</Button>} />
    <div className="mb-5 flex gap-3 border-y py-4 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /><p>秘密只通过 write-only 接口写入本机凭据库。此处显示的都是可公开元数据，修改 Provider 不会改写已有 Agent Manifest。</p></div>
    {query.isLoading ? <div className="skeleton h-56 border bg-card" /> : query.isError ? <Card><EmptyState icon={KeyRound} title="无法读取 Providers" description={(query.error as Error).message} action={<Button variant="secondary" onClick={() => void query.refetch()}>重试</Button>} /></Card>
      : providers.length === 0 ? <Card><EmptyState icon={KeyRound} title="尚未登记 Provider" description="创建可复用的 API 接入配置，之后在 Agent 中直接选择，无需理解环境变量。" action={<Button onClick={() => setEditor({ mode: 'create' })}><Plus className="size-4" />创建第一个 Provider</Button>} /></Card>
      : <Card className="overflow-hidden"><div className="hidden grid-cols-[minmax(160px,1fr)_minmax(240px,1.5fr)_120px_150px] gap-4 border-b bg-muted/35 px-5 py-3 font-mono text-[9px] uppercase tracking-wider text-muted-foreground md:grid"><span>Provider</span><span>Endpoint</span><span>凭据</span><span className="text-right">操作</span></div>
        <div className="divide-y">{providers.map(provider => <div key={provider.id} className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(160px,1fr)_minmax(240px,1.5fr)_120px_150px] md:items-center"><div><div className="text-sm font-medium">{provider.label}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">{provider.id} · {provider.protocol}</div></div>
          <div className="min-w-0"><div className="truncate font-mono text-[11px]">{provider.base_url}</div><div className="mt-1 text-[10px] text-muted-foreground">origin · {provider.approved_origin}</div></div>
          <div className="text-xs text-muted-foreground">{(provider as Provider & { credential_available?: boolean }).credential_available === false ? <span className="text-warning">凭据不可用</span> : <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-primary" />已保管</span>}</div>
          <div className="flex gap-0.5 md:justify-end"><Tooltip content="编辑元数据"><Button variant="ghost" size="icon" aria-label={`编辑 ${provider.label}`} onClick={() => setEditor({ mode: 'edit', provider })}><Pencil className="size-4" /></Button></Tooltip><Tooltip content="轮换 API Key"><Button variant="ghost" size="icon" aria-label={`轮换 ${provider.label} 凭据`} onClick={() => setRotating(provider)}><KeyRound className="size-4" /></Button></Tooltip><Tooltip content="删除 Provider"><Button variant="ghost" size="icon" aria-label={`删除 ${provider.label}`} onClick={() => setDeleting(provider)}><Trash2 className="size-4" /></Button></Tooltip></div>
        </div>)}</div></Card>}
    {editor && <ProviderEditor key={`${editor.mode}-${editor.provider?.id ?? 'new'}`} editor={editor} onClose={() => setEditor(undefined)} />}
    {rotating && <RotateDialog provider={rotating} onClose={() => setRotating(undefined)} />}
    {deleting && <ConfirmDialog open onOpenChange={open => { if (!open) setDeleting(undefined); }} title={`删除 ${deleting.label}？`} description="如果仍有 Agent 引用此 Provider，后端会拒绝删除。删除不会影响已经锁定的历史运行记录。" confirmLabel="删除 Provider" loading={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} />}
  </>;
}
