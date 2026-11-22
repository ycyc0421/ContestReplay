import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, KeyRound, Pencil, Play, Plus, RotateCw, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog, Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { SecretInput } from '@/components/ui/secret-input';
import { Tooltip } from '@/components/ui/tooltip';

type Target = Awaited<ReturnType<typeof studioApi.pushTargets>>['targets'][number];
type EventType = Target['events'][number];
const eventTypes: { id: EventType; label: string }[] = [
  { id: 'run.progress', label: '运行进度' }, { id: 'run.completed', label: '运行完赛' }, { id: 'batch.completed', label: '批次完成' },
];

function TargetEditor({ target, onClose }: { target?: Target; onClose: () => void }) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState(target?.label ?? '');
  const [url, setUrl] = useState(target?.url ?? 'https://');
  const [enabled, setEnabled] = useState(target?.enabled !== false ? 'enabled' : 'disabled');
  const [events, setEvents] = useState<EventType[]>(target?.events ?? ['run.completed', 'batch.completed']);
  const [authMode, setAuthMode] = useState(target?.auth_mode ?? 'none');
  const [secret, setSecret] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(target?.timeout_ms ?? 10000);
  const [maxRetries, setMaxRetries] = useState(target?.max_retries ?? 3);
  const client = useQueryClient();
  const save = useMutation({ mutationFn: () => target ? studioApi.updatePushTarget(target.id, { label: label.trim(), url: url.trim(), enabled: enabled === 'enabled', events, timeout_ms: timeoutMs, max_retries: maxRetries })
    : studioApi.createPushTarget({ ...(id.trim() ? { id: id.trim() } : {}), label: label.trim(), url: url.trim(), enabled: enabled === 'enabled', events, auth_mode: authMode, ...(authMode !== 'none' ? { secret } : {}), timeout_ms: timeoutMs, max_retries: maxRetries }),
  onSuccess: async () => { await client.invalidateQueries({ queryKey: ['push-targets'] }); toast.success(target ? 'Push Target 已更新' : 'Push Target 已创建'); onClose(); },
  onError: (error: Error) => toast.error('无法保存 Push Target', { description: error.message }) });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-2xl"><DialogHeader title={target ? `编辑 ${target.label}` : '新建 Push Target'} description="将脱敏的 run.completed、run.progress 或 batch.completed 事件推送到你明确授权的 HTTP endpoint。" /><form className="space-y-5" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    <div className="grid gap-4 sm:grid-cols-2">{!target && <Field label="Target ID" hint="可选"><Input className="font-mono text-xs" value={id} onChange={event => setId(event.target.value)} /></Field>}<Field label="显示名称"><Input value={label} onChange={event => setLabel(event.target.value)} /></Field><Field label="Webhook URL"><Input className="font-mono text-xs" value={url} onChange={event => setUrl(event.target.value)} /></Field>
      <Field label="状态"><Select value={enabled} onValueChange={setEnabled}><SelectItem value="enabled">启用</SelectItem><SelectItem value="disabled">停用</SelectItem></Select></Field><Field label="认证方式"><Select value={authMode} onValueChange={value => setAuthMode(value as Target['auth_mode'])} disabled={!!target}><SelectItem value="none">无认证</SelectItem><SelectItem value="bearer">Bearer Token</SelectItem><SelectItem value="hmac-sha256">HMAC-SHA256</SelectItem></Select></Field></div>
    <div><div className="mb-2 text-sm font-medium">推送事件</div><div className="flex flex-wrap gap-2">{eventTypes.map(event => { const checked = events.includes(event.id); return <button key={event.id} type="button" role="checkbox" aria-checked={checked} aria-label={event.label} onClick={() => setEvents(current => checked ? current.filter(item => item !== event.id) : [...current, event.id])} className={checked ? 'border bg-primary px-3 py-2 text-xs text-primary-foreground' : 'border px-3 py-2 text-xs text-muted-foreground'}>{event.label}</button>; })}</div></div>
    {!target && authMode !== 'none' && <SecretInput label="Webhook Secret" value={secret} onChange={setSecret} />}
    <div className="grid gap-4 sm:grid-cols-2"><Field label="超时" hint="毫秒"><Input type="number" min={100} max={30000} value={timeoutMs} onChange={event => setTimeoutMs(Number(event.target.value))} /></Field><Field label="最大重试" hint="0–5"><Input type="number" min={0} max={5} value={maxRetries} onChange={event => setMaxRetries(Number(event.target.value))} /></Field></div>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={save.isPending} disabled={!label.trim() || !url.trim() || !events.length || (!target && authMode !== 'none' && secret.trim().length < 8)}>{target ? '保存修改' : '创建 Target'}</Button></div>
  </form></DialogContent></Dialog>;
}

function RotateTargetDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const [secret, setSecret] = useState('');
  const client = useQueryClient();
  const rotate = useMutation({ mutationFn: () => studioApi.rotatePushTarget(target.id, secret), onSuccess: async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ['push-targets'] }), client.invalidateQueries({ queryKey: ['push-deliveries'] })]);
    toast.success('Webhook Secret 已轮换'); onClose();
  }, onError: (error: Error) => toast.error('轮换失败', { description: error.message }) });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader title={`轮换 ${target.label}`} description="写入新的 Webhook Secret；认证方式保持不变。" /><form className="space-y-5" onSubmit={event => { event.preventDefault(); rotate.mutate(); }}><SecretInput label="新 Webhook Secret" value={secret} onChange={setSecret} /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={rotate.isPending} disabled={secret.trim().length < 8}>确认轮换</Button></div></form></DialogContent></Dialog>;
}

export function PushTargetsPanel() {
  const targetsQuery = useQuery({ queryKey: ['push-targets'], queryFn: studioApi.pushTargets });
  const deliveriesQuery = useQuery({ queryKey: ['push-deliveries'], queryFn: studioApi.pushDeliveries, refetchInterval: 5000 });
  const [editor, setEditor] = useState<{ target?: Target }>();
  const [rotating, setRotating] = useState<Target>();
  const [deleting, setDeleting] = useState<Target>();
  const client = useQueryClient();
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['push-targets'] }), client.invalidateQueries({ queryKey: ['push-deliveries'] })]); };
  const testTarget = useMutation({ mutationFn: (id: string) => studioApi.testPushTarget(id), onSuccess: async delivery => { await refresh(); delivery.status === 'delivered' ? toast.success('Ping 已送达') : toast.error('Ping 投递失败', { description: delivery.error }); }, onError: (error: Error) => toast.error('Ping 失败', { description: error.message }) });
  const remove = useMutation({ mutationFn: (id: string) => studioApi.deletePushTarget(id), onSuccess: async () => { await refresh(); toast.success('Push Target 已删除'); setDeleting(undefined); }, onError: (error: Error) => { toast.error('删除失败', { description: error.message }); setDeleting(undefined); } });
  const targets = targetsQuery.data?.targets ?? [];
  const deliveries = deliveriesQuery.data?.deliveries ?? [];
  return <>
    <div className="mb-5 flex flex-col gap-3 border-y py-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /><p>只推送允许公开的事件字段，不包含秘密、原始日志或私有答案。HMAC 与 Bearer 秘密同样只写不读。</p></div><Button className="shrink-0" onClick={() => setEditor({})}><Plus className="size-4" />新建 Target</Button></div>
    {targetsQuery.isLoading ? <div className="skeleton h-48 border bg-card" /> : targetsQuery.isError ? <Card><EmptyState icon={Bell} title="无法读取 Push Targets" description={(targetsQuery.error as Error).message} action={<Button variant="secondary" onClick={() => void targetsQuery.refetch()}>重试</Button>} /></Card> : targets.length === 0 ? <Card><EmptyState icon={Bell} title="尚未配置 Push Target" description="配置本机自动化接收端后，运行进度和完赛事件可以触发后续归档与分析。" action={<Button onClick={() => setEditor({})}><Plus className="size-4" />创建第一个 Target</Button>} /></Card> : <Card className="overflow-hidden"><div className="divide-y">{targets.map(target => <div key={target.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(160px,1fr)_minmax(220px,1.5fr)_minmax(170px,1fr)_150px] lg:items-center"><div><div className="text-sm font-medium">{target.label}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">{target.id}</div></div><div className="min-w-0"><div className="truncate font-mono text-xs">{target.url}</div><div className="mt-1 text-[10px] text-muted-foreground">{target.auth_mode} · {target.timeout_ms}ms · {target.max_retries} retries</div></div><div className="flex flex-wrap gap-1.5"><Badge>{target.enabled ? 'enabled' : 'disabled'}</Badge>{target.events.map(event => <Badge key={event}>{event}</Badge>)}</div><div className="flex gap-0.5 lg:justify-end"><Tooltip content="发送 Ping"><Button variant="ghost" size="icon" aria-label={`测试 ${target.label}`} loading={testTarget.isPending && testTarget.variables === target.id} onClick={() => testTarget.mutate(target.id)}><Play className="size-4" /></Button></Tooltip><Tooltip content="编辑"><Button variant="ghost" size="icon" aria-label={`编辑 Push Target ${target.label}`} onClick={() => setEditor({ target })}><Pencil className="size-4" /></Button></Tooltip>{target.auth_mode !== 'none' && <Tooltip content="轮换 Secret"><Button variant="ghost" size="icon" aria-label={`轮换 Push Target ${target.label}`} onClick={() => setRotating(target)}><KeyRound className="size-4" /></Button></Tooltip>}<Tooltip content="删除"><Button variant="ghost" size="icon" aria-label={`删除 Push Target ${target.label}`} onClick={() => setDeleting(target)}><Trash2 className="size-4" /></Button></Tooltip></div></div>)}</div></Card>}
    <Card className="mt-6 overflow-hidden"><div className="flex items-center justify-between border-b px-4 py-3"><div><h2 className="text-sm font-semibold">最近投递</h2><p className="mt-1 text-[11px] text-muted-foreground">保留状态、HTTP 响应、重试次数和脱敏错误</p></div><Button variant="ghost" size="icon" aria-label="刷新投递记录" onClick={() => void deliveriesQuery.refetch()}><RotateCw className="size-4" /></Button></div>{deliveries.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">暂无投递记录。</p> : <div className="divide-y">{deliveries.map(delivery => <div key={delivery.delivery_id} className="grid gap-2 px-4 py-3 text-xs md:grid-cols-[150px_1fr_100px_100px] md:items-center"><span className="font-mono text-[10px] text-muted-foreground">{formatDate(delivery.timestamp)}</span><div><span className="font-medium">{delivery.target_id}</span><span className="ml-2 font-mono text-[10px] text-muted-foreground">{delivery.event}</span>{delivery.error && <div className="mt-1 text-[10px] text-warning">{delivery.error}</div>}</div><span className={cn('font-mono text-[10px]', delivery.status === 'failed' && 'text-danger')}>{delivery.status}{delivery.http_status ? ` · ${delivery.http_status}` : ''}</span><span className="font-mono text-[10px] text-muted-foreground">{delivery.attempts} 次 · {delivery.duration_ms}ms</span></div>)}</div>}</Card>
    {editor && <TargetEditor key={editor.target?.id ?? 'new'} target={editor.target} onClose={() => setEditor(undefined)} />}
    {rotating && <RotateTargetDialog key={rotating.id} target={rotating} onClose={() => setRotating(undefined)} />}
    {deleting && <ConfirmDialog open onOpenChange={open => { if (!open) setDeleting(undefined); }} title={`删除 ${deleting.label}？`} description="删除后不再接收新事件；已有投递记录与运行结果不受影响。" confirmLabel="删除 Target" loading={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} />}
  </>;
}
