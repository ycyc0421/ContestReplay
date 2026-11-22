import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog, Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { SecretInput } from '@/components/ui/secret-input';
import { Tooltip } from '@/components/ui/tooltip';

type Account = Awaited<ReturnType<typeof studioApi.ojAccounts>>['accounts'][number];
type Editor = { account?: Account };

function AccountEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const account = editor.account;
  const [id, setId] = useState('');
  const [label, setLabel] = useState(account?.label ?? '');
  const [platform, setPlatform] = useState<Account['platform']>(account?.platform ?? 'codeforces');
  const [handle, setHandle] = useState(account?.handle ?? '');
  const [pool, setPool] = useState(account?.pool ?? 'default');
  const [transport, setTransport] = useState<Account['transport']>(account?.transport ?? 'cookie');
  const [baseUrl, setBaseUrl] = useState(account?.base_url ?? '');
  const [executablePath, setExecutablePath] = useState(account?.executable_path ?? '');
  const [secret, setSecret] = useState('');
  const client = useQueryClient();
  const save = useMutation({ mutationFn: () => {
    const common = { label: label.trim(), handle: handle.trim(), ...(pool.trim() ? { pool: pool.trim() } : {}), ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}) };
    if (account) return studioApi.updateOjAccount(account.id, { ...common, ...(account.transport === 'submitter' ? { executable_path: executablePath.trim() } : {}) });
    const identity = { ...common, ...(id.trim() ? { id: id.trim() } : {}), platform };
    return transport === 'cookie' ? studioApi.createOjAccount({ ...identity, transport, secret }) : studioApi.createOjAccount({ ...identity, transport, executable_path: executablePath.trim() });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ['oj-accounts'] }); toast.success(account ? 'OJ 账号已更新' : 'OJ 账号已创建'); onClose(); },
  onError: (error: Error) => toast.error('无法保存 OJ 账号', { description: error.message }) });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-2xl"><DialogHeader title={account ? `编辑 ${account.label}` : '登记 OJ 账号'} description="Contest 只引用账号 ID 或账号池。Cookie 只写入本机凭据库；submitter 使用经授权的宿主可执行协议。" /><form className="space-y-5" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    <div className="grid gap-4 sm:grid-cols-2">{!account && <Field label="账号 ID" hint="可选"><Input className="font-mono text-xs" value={id} onChange={event => setId(event.target.value)} placeholder="留空自动生成" /></Field>}<Field label="显示名称"><Input value={label} onChange={event => setLabel(event.target.value)} placeholder="CF 专用评测账号" /></Field>
      <Field label="平台"><Select value={platform} onValueChange={value => setPlatform(value as Account['platform'])} disabled={!!account}>{['codeforces', 'qoj', 'vjudge', 'hydro'].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</Select></Field><Field label="Handle"><Input className="font-mono text-xs" value={handle} onChange={event => setHandle(event.target.value)} /></Field>
      <Field label="账号池"><Input className="font-mono text-xs" value={pool} onChange={event => setPool(event.target.value)} /></Field><Field label="Base URL" hint="自托管实例时填写"><Input className="font-mono text-xs" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://…" /></Field></div>
    <Field label="提交通道"><Select value={transport} onValueChange={value => setTransport(value as Account['transport'])} disabled={!!account}><SelectItem value="cookie">Cookie / Session</SelectItem><SelectItem value="submitter">授权 Submitter 可执行程序</SelectItem></Select></Field>
    {transport === 'cookie' ? !account && <SecretInput label="Cookie / Session" value={secret} onChange={setSecret} /> : <Field label="Submitter 绝对路径" hint="不会进入沙盒"><Input className="font-mono text-xs" value={executablePath} onChange={event => setExecutablePath(event.target.value)} placeholder="/usr/local/bin/oj-submit" /></Field>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={save.isPending} disabled={!label.trim() || !handle.trim() || (!account && transport === 'cookie' && !secret.trim()) || (transport === 'submitter' && !executablePath.trim())}>{account ? '保存修改' : '创建账号'}</Button></div>
  </form></DialogContent></Dialog>;
}

function RotateAccountDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const [secret, setSecret] = useState('');
  const client = useQueryClient();
  const rotate = useMutation({ mutationFn: () => studioApi.rotateOjAccount(account.id, secret), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['oj-accounts'] }); toast.success('OJ 凭据已轮换'); onClose();
  }, onError: (error: Error) => toast.error('轮换失败', { description: error.message }) });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader title={`轮换 ${account.label}`} description="写入新的 Cookie / Session；账号 ID、origin 和 pool 保持不变。" /><form className="space-y-5" onSubmit={event => { event.preventDefault(); rotate.mutate(); }}><SecretInput label="新 Cookie / Session" value={secret} onChange={setSecret} /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={rotate.isPending} disabled={!secret.trim()}>确认轮换</Button></div></form></DialogContent></Dialog>;
}

export function OjAccountsPanel() {
  const query = useQuery({ queryKey: ['oj-accounts'], queryFn: studioApi.ojAccounts });
  const [editor, setEditor] = useState<Editor>();
  const [rotating, setRotating] = useState<Account>();
  const [deleting, setDeleting] = useState<Account>();
  const client = useQueryClient();
  const remove = useMutation({ mutationFn: (id: string) => studioApi.deleteOjAccount(id), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['oj-accounts'] }); toast.success('OJ 账号已删除'); setDeleting(undefined); }, onError: (error: Error) => { toast.error('无法删除账号', { description: error.message }); setDeleting(undefined); } });
  const accounts = query.data?.accounts ?? [];
  return <>
    <div className="mb-5 flex flex-col gap-3 border-y py-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /><p>账号按平台、origin 和 pool 绑定。并发队列会互斥租用同一账号，删除时检查所有配置引用。</p></div><Button className="shrink-0" onClick={() => setEditor({})}><Plus className="size-4" />登记 OJ 账号</Button></div>
    {query.isLoading ? <div className="skeleton h-56 border bg-card" /> : query.isError ? <Card><EmptyState icon={KeyRound} title="无法读取 OJ 账号" description={(query.error as Error).message} action={<Button variant="secondary" onClick={() => void query.refetch()}>重试</Button>} /></Card> : accounts.length === 0 ? <Card><EmptyState icon={KeyRound} title="尚未登记 OJ 账号" description="Codeforces、QOJ、VJudge 和 Hydro 共用同一 write-only 账号池；Cookie 和 submitter 通道可以并存。" action={<Button onClick={() => setEditor({})}><Plus className="size-4" />登记第一个账号</Button>} /></Card> : <Card className="overflow-hidden"><div className="divide-y">{accounts.map(account => <div key={account.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(170px,1fr)_minmax(180px,1fr)_140px_110px_140px] lg:items-center"><div><div className="text-sm font-medium">{account.label}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">{account.id}</div></div><div><div className="font-mono text-xs">{account.handle}</div><div className="mt-1 truncate text-[10px] text-muted-foreground">{account.base_url ?? '平台默认 origin'}</div></div><div className="flex gap-1.5"><Badge>{account.platform}</Badge><Badge>{account.pool}</Badge></div><div className={account.ready ? 'text-xs text-primary' : 'text-xs text-warning'}>{account.ready ? '● 已就绪' : '○ 未就绪'}<div className="mt-1 font-mono text-[9px] text-muted-foreground">{account.transport}</div></div><div className="flex gap-0.5 lg:justify-end"><Tooltip content="编辑元数据"><Button variant="ghost" size="icon" aria-label={`编辑 OJ 账号 ${account.label}`} onClick={() => setEditor({ account })}><Pencil className="size-4" /></Button></Tooltip>{account.transport === 'cookie' && <Tooltip content="轮换 Cookie"><Button variant="ghost" size="icon" aria-label={`轮换 OJ 账号 ${account.label}`} onClick={() => setRotating(account)}><KeyRound className="size-4" /></Button></Tooltip>}<Tooltip content="删除账号"><Button variant="ghost" size="icon" aria-label={`删除 OJ 账号 ${account.label}`} onClick={() => setDeleting(account)}><Trash2 className="size-4" /></Button></Tooltip></div></div>)}</div></Card>}
    {editor && <AccountEditor key={editor.account?.id ?? 'new'} editor={editor} onClose={() => setEditor(undefined)} />}
    {rotating && <RotateAccountDialog key={rotating.id} account={rotating} onClose={() => setRotating(undefined)} />}
    {deleting && <ConfirmDialog open onOpenChange={open => { if (!open) setDeleting(undefined); }} title={`删除 ${deleting.label}？`} description="若任何 Contest 仍引用此账号或其账号池，后端会拒绝删除。已锁定的历史运行不受影响。" confirmLabel="删除账号" loading={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} />}
  </>;
}
