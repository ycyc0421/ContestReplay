import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, KeyRound, Pencil, Plus, ShieldCheck, Trash2, Wifi } from 'lucide-react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { OJ_PLATFORM_META, parseOjCookieInput, type OjPlatformKind, type ParsedCookieImport } from '@/lib/cookie-parser';
import { invalidateOjAccountGraph, queryKeys } from '@/state/query-keys';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog, Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';
import { CookieImporter } from '@/design-system/cookie-importer';
import { CollapsibleSection } from '@/design-system/collapsible-section';

type Account = Awaited<ReturnType<typeof studioApi.ojAccounts>>['accounts'][number];
type Editor = { account?: Account };

const PLATFORMS: OjPlatformKind[] = ['codeforces', 'qoj', 'vjudge', 'hydro'];

function AccountEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const account = editor.account;
  const [id, setId] = useState('');
  const [label, setLabel] = useState(account?.label ?? '');
  const [platform, setPlatform] = useState<OjPlatformKind>(account?.platform ?? 'codeforces');
  const [handle, setHandle] = useState(account?.handle ?? '');
  const [pool, setPool] = useState(account?.pool ?? 'default');
  const [transport, setTransport] = useState<Account['transport']>(account?.transport ?? 'cookie');
  const [baseUrl, setBaseUrl] = useState(account?.base_url ?? '');
  const [executablePath, setExecutablePath] = useState(account?.executable_path ?? '');
  const [rawCookie, setRawCookie] = useState('');
  const [parsedCookie, setParsedCookie] = useState<ParsedCookieImport | null>(null);
  const [probeState, setProbeState] = useState<{ ok: boolean; authenticated: boolean; message: string }>();
  const client = useQueryClient();

  const meta = OJ_PLATFORM_META[platform];
  const effectiveCookie = parsedCookie?.normalizedHeader ?? '';
  const effectiveLabel = label.trim() || (handle.trim() ? `${meta.label} · ${handle.trim()}` : '');

  const probe = useMutation({
    mutationFn: () => studioApi.probeOjAccount({
      platform,
      ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
      secret: effectiveCookie,
    }),
    onSuccess: result => {
      setProbeState({ ok: result.ok, authenticated: result.authenticated, message: result.message });
      if (result.detected_handle && !handle.trim()) {
        setHandle(result.detected_handle);
      } else if (result.detected_handle && result.detected_handle.toLowerCase() !== handle.trim().toLowerCase()) {
        setHandle(result.detected_handle);
        toast.info(`已按探测结果更新用户名为 ${result.detected_handle}`);
      }
      if (result.authenticated) toast.success('会话验证通过', { description: result.message });
      else toast.warning('会话未通过验证', { description: result.message });
    },
    onError: (error: Error) => {
      setProbeState({ ok: false, authenticated: false, message: error.message });
      toast.error('验证失败', { description: error.message });
    },
  });

  const save = useMutation({
    mutationFn: () => {
      const common = {
        label: effectiveLabel,
        handle: handle.trim(),
        ...(pool.trim() ? { pool: pool.trim() } : {}),
        ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
      };
      if (account) {
        return studioApi.updateOjAccount(account.id, {
          ...common,
          ...(account.transport === 'submitter' ? { executable_path: executablePath.trim() } : {}),
        });
      }
      const identity = { ...common, ...(id.trim() ? { id: id.trim() } : {}), platform };
      return transport === 'cookie'
        ? studioApi.createOjAccount({ ...identity, transport, secret: effectiveCookie })
        : studioApi.createOjAccount({ ...identity, transport, executable_path: executablePath.trim() });
    },
    onSuccess: async () => {
      await invalidateOjAccountGraph(client);
      toast.success(account ? 'OJ 账号已更新' : 'OJ 账号已创建');
      onClose();
    },
    onError: (error: Error) => toast.error('无法保存 OJ 账号', { description: error.message }),
  });

  const canProbe = !account && transport === 'cookie' && Boolean(effectiveCookie) && (!meta.requiresBaseUrl || Boolean(baseUrl.trim()));
  const canSave = Boolean(
    handle.trim() &&
    (!meta.requiresBaseUrl || baseUrl.trim()) &&
    (account || transport !== 'cookie' || Boolean(effectiveCookie)) &&
    (transport !== 'submitter' || Boolean(executablePath.trim())),
  );

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader
          title={account ? `编辑 ${account.label}` : '登记 OJ 评测账号'}
          description="只需选平台、粘贴浏览器导出的 Cookie 并填写登录用户名；高级参数已折叠，凭据只写不读。"
        />
        <form className="space-y-5" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
          {/* Step 1: Platform Picker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm font-medium">
              <span>1. 选择 OJ 平台</span>
              <span className="text-xs font-normal text-muted-foreground">默认域名：{meta.defaultDomain}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {PLATFORMS.map(kind => {
                const item = OJ_PLATFORM_META[kind];
                const active = platform === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    disabled={!!account}
                    aria-pressed={active}
                    onClick={() => {
                      setPlatform(kind);
                      setProbeState(undefined);
                      if (rawCookie) setParsedCookie(parseOjCookieInput(rawCookie, kind, baseUrl));
                    }}
                    className={cn(
                      'rounded-[3px] border px-3 py-2.5 text-left transition-colors disabled:opacity-55',
                      active ? 'border-primary bg-accent text-foreground' : 'bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
                    )}
                  >
                    <div className="text-xs font-semibold">{item.label}</div>
                    <div className="mt-0.5 truncate font-mono text-[10px] opacity-70">{item.defaultDomain}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {meta.requiresBaseUrl && (
            <Field label={`${meta.label} 站点地址（Base URL）`} hint="必填">
              <Input
                className="font-mono text-xs"
                value={baseUrl}
                onChange={event => {
                  const nextUrl = event.target.value;
                  setBaseUrl(nextUrl);
                  setProbeState(undefined);
                  if (rawCookie) setParsedCookie(parseOjCookieInput(rawCookie, platform, nextUrl));
                }}
                placeholder="https://hydro.ac"
              />
            </Field>
          )}

          {/* Step 2: Smart Cookie Importer (or Submitter path) */}
          {!account && transport === 'cookie' && (
            <CookieImporter
              label="2. 登录 Cookie（支持 cookies.txt / cURL / Header / JSON）"
              platform={platform}
              baseUrl={baseUrl}
              rawValue={rawCookie}
              onChange={(raw, parsed) => {
                setRawCookie(raw);
                setParsedCookie(parsed);
                setProbeState(undefined);
              }}
            />
          )}

          {transport === 'submitter' && (
            <Field label="Submitter 可执行文件绝对路径" hint="仅在宿主机执行，不进入沙盒">
              <Input
                className="font-mono text-xs"
                value={executablePath}
                onChange={event => setExecutablePath(event.target.value)}
                placeholder="/usr/local/bin/oj-submit"
              />
            </Field>
          )}

          {/* Step 3: Platform-specific Username + Probe */}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label={account ? meta.userLabel : `3. ${meta.userLabel}`} hint="用于核对远端提交归属，须与登录账号一致">
              <Input
                className="font-mono text-xs"
                value={handle}
                onChange={event => setHandle(event.target.value)}
                placeholder={meta.userPlaceholder}
              />
            </Field>
            {!account && transport === 'cookie' && (
              <Button
                type="button"
                variant="secondary"
                loading={probe.isPending}
                disabled={!canProbe}
                onClick={() => probe.mutate()}
              >
                <Wifi className="size-3.5" />验证并识别用户名
              </Button>
            )}
          </div>

          {probeState && (
            <div className={cn(
              'flex items-start gap-2 rounded-[3px] border px-3.5 py-2.5 text-xs leading-5',
              probeState.authenticated ? 'border-primary/30 bg-primary/5 text-foreground' : 'border-warning/40 bg-warning/5 text-warning',
            )}>
              {probeState.authenticated ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />}
              <span>{probeState.message}</span>
            </div>
          )}

          {/* Advanced Collapsible */}
          <CollapsibleSection
            title="高级选项"
            summary={`备注名、账号 ID、账号池（${pool || 'default'}）、提交通道`}
            defaultOpen={Boolean(account)}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="备注名称" hint={`留空默认「${meta.label} · 用户名」`}>
                <Input
                  value={label}
                  onChange={event => setLabel(event.target.value)}
                  placeholder={`${meta.label} · ${handle.trim() || '用户名'}`}
                />
              </Field>
              {!account && (
                <Field label="自定义账号 ID" hint="留空自动生成">
                  <Input className="font-mono text-xs" value={id} onChange={event => setId(event.target.value)} placeholder="例如 cf-main" />
                </Field>
              )}
              <Field label="账号池" hint="多账号并发轮询分组">
                <Input className="font-mono text-xs" value={pool} onChange={event => setPool(event.target.value)} placeholder="default" />
              </Field>
              {!meta.requiresBaseUrl && (
                <Field label="自定义 Base URL" hint="自托管镜像时填写">
                  <Input
                    className="font-mono text-xs"
                    value={baseUrl}
                    onChange={event => {
                      const nextUrl = event.target.value;
                      setBaseUrl(nextUrl);
                      if (rawCookie) setParsedCookie(parseOjCookieInput(rawCookie, platform, nextUrl));
                    }}
                    placeholder={`默认 https://${meta.defaultDomain}`}
                  />
                </Field>
              )}
              <Field label="提交通道">
                <Select value={transport} onValueChange={value => setTransport(value as Account['transport'])} disabled={!!account}>
                  <SelectItem value="cookie">Cookie 会话（推荐）</SelectItem>
                  <SelectItem value="submitter">授权 Submitter 可执行程序</SelectItem>
                </Select>
              </Field>
            </div>
          </CollapsibleSection>

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" loading={save.isPending} disabled={!canSave}>
              {account ? '保存修改' : '创建账号'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateAccountDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const [rawCookie, setRawCookie] = useState('');
  const [parsedCookie, setParsedCookie] = useState<ParsedCookieImport | null>(null);
  const client = useQueryClient();
  const effectiveCookie = parsedCookie?.normalizedHeader ?? '';
  const rotate = useMutation({
    mutationFn: () => studioApi.rotateOjAccount(account.id, effectiveCookie),
    onSuccess: async () => {
      await invalidateOjAccountGraph(client);
      toast.success('OJ 会话 Cookie 已轮换');
      onClose();
    },
    onError: (error: Error) => toast.error('轮换失败', { description: error.message }),
  });

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader
          title={`轮换 ${account.label}`}
          description="粘贴或导入新的登录 Cookie；账号 ID、用户名、站点地址与账号池保持不变。"
        />
        <form className="space-y-5" onSubmit={event => { event.preventDefault(); rotate.mutate(); }}>
          <CookieImporter
            label="新 Cookie / Session"
            platform={account.platform}
            baseUrl={account.base_url}
            rawValue={rawCookie}
            onChange={(raw, parsed) => { setRawCookie(raw); setParsedCookie(parsed); }}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" loading={rotate.isPending} disabled={!effectiveCookie}>确认轮换</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OjAccountsPanel() {
  const query = useQuery({ queryKey: queryKeys.ojAccounts, queryFn: studioApi.ojAccounts });
  const [editor, setEditor] = useState<Editor>();
  const [rotating, setRotating] = useState<Account>();
  const [deleting, setDeleting] = useState<Account>();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => studioApi.deleteOjAccount(id),
    onSuccess: async () => {
      await invalidateOjAccountGraph(client);
      toast.success('OJ 账号已删除');
      setDeleting(undefined);
    },
    onError: (error: Error) => {
      toast.error('无法删除账号', { description: error.message });
      setDeleting(undefined);
    },
  });
  const accounts = query.data?.accounts ?? [];
  return <>
    <div className="mb-5 flex flex-col gap-3 border-y py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3 text-xs leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>支持直接粘贴浏览器导出的 cookies.txt、cURL 或 Cookie 头。并发批次会互斥租用同一账号，删除时自动检查配置引用。</p>
      </div>
      <Button className="shrink-0" onClick={() => setEditor({})}><Plus className="size-4" />登记 OJ 账号</Button>
    </div>
    {query.isLoading ? <div className="skeleton h-56 rounded-card border bg-card" />
      : query.isError ? <Card><EmptyState icon={KeyRound} title="无法读取 OJ 账号" description={(query.error as Error).message} action={<Button variant="secondary" onClick={() => void query.refetch()}>重试</Button>} /></Card>
      : accounts.length === 0 ? <Card><EmptyState icon={KeyRound} title="尚未登记 OJ 账号" description="Codeforces、QOJ、VJudge 和 Hydro 共用本机 write-only 账号池；支持多格式 Cookie 导入与一键探测验证。" action={<Button onClick={() => setEditor({})}><Plus className="size-4" />登记第一个账号</Button>} /></Card>
      : <Card className="overflow-hidden"><div className="divide-y">{accounts.map(account => {
        const meta = OJ_PLATFORM_META[account.platform];
        return <div key={account.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(180px,1.1fr)_minmax(180px,1fr)_140px_110px_140px] lg:items-center">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{account.label}</div>
            <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{account.id}</div>
          </div>
          <div className="min-w-0">
            <div className="truncate font-mono text-xs">{account.handle}</div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground">{account.base_url ?? meta.defaultDomain}</div>
          </div>
          <div className="flex flex-wrap gap-1.5"><Badge>{meta.label}</Badge><Badge>{account.pool}</Badge></div>
          <div className={account.ready ? 'text-xs text-primary' : 'text-xs text-warning'}>
            {account.ready ? '● 已就绪' : '○ 未就绪'}
            <div className="mt-1 text-[10px] text-muted-foreground">{account.transport === 'cookie' ? 'Cookie 会话' : 'Submitter'}</div>
          </div>
          <div className="flex gap-0.5 lg:justify-end">
            <Tooltip content="编辑信息"><Button variant="ghost" size="icon" aria-label={`编辑 OJ 账号 ${account.label}`} onClick={() => setEditor({ account })}><Pencil className="size-4" /></Button></Tooltip>
            {account.transport === 'cookie' && <Tooltip content="轮换 Cookie"><Button variant="ghost" size="icon" aria-label={`轮换 OJ 账号 ${account.label}`} onClick={() => setRotating(account)}><KeyRound className="size-4" /></Button></Tooltip>}
            <Tooltip content="删除账号"><Button variant="ghost" size="icon" aria-label={`删除 OJ 账号 ${account.label}`} onClick={() => setDeleting(account)}><Trash2 className="size-4" /></Button></Tooltip>
          </div>
        </div>;
      })}</div></Card>}
    {editor && <AccountEditor key={editor.account?.id ?? 'new'} editor={editor} onClose={() => setEditor(undefined)} />}
    {rotating && <RotateAccountDialog key={rotating.id} account={rotating} onClose={() => setRotating(undefined)} />}
    {deleting && <ConfirmDialog open onOpenChange={open => { if (!open) setDeleting(undefined); }} title={`删除 ${deleting.label}？`} description="若任何 Contest 仍引用此账号或其账号池，后端会拒绝删除。已锁定的历史运行不受影响。" confirmLabel="删除账号" loading={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} />}
  </>;
}
