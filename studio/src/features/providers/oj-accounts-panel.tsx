import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, KeyRound, Pencil, Plus, ShieldCheck, Trash2, Wifi } from 'lucide-react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  OJ_PLATFORM_META,
  parseOjCookieInput,
  resolveTargetEndpoint,
  type OjPlatformKind,
} from '@/lib/cookie-parser';
import { invalidateOjAccountGraph, queryKeys } from '@/state/query-keys';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog, Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { EmptyState } from '@/components/empty-state';
import { Tooltip } from '@/components/ui/tooltip';
import { CollapsibleSection } from '@/design-system/collapsible-section';
import { CookieImporter } from '@/design-system/cookie-importer';

type Account = Awaited<ReturnType<typeof studioApi.ojAccounts>>['accounts'][number];
type Editor = { mode: 'create' | 'edit'; account?: Account };

const PLATFORMS: OjPlatformKind[] = ['codeforces', 'qoj', 'vjudge', 'hydro'];

interface ProbeState {
  ok: boolean;
  authenticated: boolean;
  origin: string;
  message: string;
  suggestedHandle?: string;
}

function AccountEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const account = editor.account;
  const [platform, setPlatform] = useState<OjPlatformKind>(account?.platform ?? 'codeforces');
  const [id, setId] = useState('');
  const [label, setLabel] = useState(account?.label ?? '');
  const [handle, setHandle] = useState(account?.handle ?? '');
  const [pool, setPool] = useState(account?.pool ?? 'default');
  const [transport, setTransport] = useState<Account['transport']>(account?.transport ?? 'cookie');
  const [baseUrl, setBaseUrl] = useState(account?.base_url ?? '');
  const [executablePath, setExecutablePath] = useState(account?.executable_path ?? '');
  const [rawCookie, setRawCookie] = useState('');
  const [probeState, setProbeState] = useState<ProbeState>();
  const probeGenRef = useRef(0);
  const client = useQueryClient();

  const meta = OJ_PLATFORM_META[platform];
  // Single source of truth: parsed cookie is always derived from CURRENT (rawCookie, platform, baseUrl)
  const parsedCookie = useMemo(
    () => parseOjCookieInput(rawCookie, platform, baseUrl),
    [rawCookie, platform, baseUrl],
  );
  const targetEndpoint = useMemo(
    () => resolveTargetEndpoint(platform, baseUrl),
    [platform, baseUrl],
  );
  const effectiveCookie = parsedCookie?.normalizedHeader ?? '';
  const effectiveLabel = label.trim() || (handle.trim() ? `${meta.label} · ${handle.trim()}` : '');

  const invalidateProbe = () => {
    probeGenRef.current += 1;
    setProbeState(undefined);
  };

  const handlePlatformChange = (nextPlatform: OjPlatformKind) => {
    if (nextPlatform === platform) return;
    // Clear all destination-bound state so cookies/URLs/handles never cross platforms
    setPlatform(nextPlatform);
    setBaseUrl('');
    setRawCookie('');
    setHandle('');
    invalidateProbe();
  };

  const probe = useMutation({
    mutationFn: async () => {
      const gen = ++probeGenRef.current;
      try {
        const result = await studioApi.probeOjAccount({
          platform,
          ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
          secret: effectiveCookie,
        });
        return { gen, ok: true as const, result };
      } catch (err) {
        return { gen, ok: false as const, error: err instanceof Error ? err : new Error(String(err)) };
      }
    },
    onSuccess: payload => {
      if (probeGenRef.current !== payload.gen) return;
      if (!payload.ok) {
        setProbeState({
          ok: false,
          authenticated: false,
          origin: targetEndpoint.origin,
          message: payload.error.message,
        });
        toast.error('验证失败', { description: payload.error.message });
        return;
      }
      const { result } = payload;
      const currentHandle = handle.trim();
      let suggestedHandle: string | undefined;
      if (result.detected_handle) {
        if (!currentHandle) {
          setHandle(result.detected_handle);
        } else if (result.detected_handle.toLowerCase() !== currentHandle.toLowerCase()) {
          // Do NOT silently overwrite a manually typed handle; require explicit acceptance.
          suggestedHandle = result.detected_handle;
        }
      }
      setProbeState({
        ok: result.ok,
        authenticated: result.authenticated,
        origin: result.origin || targetEndpoint.origin,
        message: result.message,
        suggestedHandle,
      });
      if (result.authenticated) toast.success('会话验证通过', { description: result.message });
      else toast.warning('会话未通过验证', { description: result.message });
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
              <span className="font-mono text-xs font-normal text-muted-foreground">目标站点：{targetEndpoint.origin}</span>
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
                    onClick={() => handlePlatformChange(kind)}
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
                  setBaseUrl(event.target.value);
                  setRawCookie('');
                  invalidateProbe();
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
              onRawChange={nextRaw => {
                setRawCookie(nextRaw);
                invalidateProbe();
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

          {/* Step 3: Platform-specific Username + Probe with explicit destination origin */}
          <div className="space-y-2">
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
            {!account && transport === 'cookie' && (
              <p className="text-[11px] text-muted-foreground">
                探测将仅向 <span className="font-mono text-foreground">{targetEndpoint.origin}</span> 发起只读登录态检查，不落盘任何凭据。
              </p>
            )}
          </div>

          {probeState && (
            <div className={cn(
              'flex flex-col gap-2 rounded-[3px] border px-3.5 py-2.5 text-xs leading-5',
              probeState.authenticated ? 'border-primary/30 bg-primary/5 text-foreground' : 'border-warning/40 bg-warning/5 text-warning',
            )}>
              <div className="flex items-start gap-2">
                {probeState.authenticated ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />}
                <span>{probeState.message}</span>
              </div>
              {probeState.suggestedHandle && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-muted-foreground">
                  <span>
                    探测到登录用户名为 <span className="font-mono font-medium text-foreground">{probeState.suggestedHandle}</span>，与当前填写不一致。
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setHandle(probeState.suggestedHandle!);
                      setProbeState(prev => prev ? { ...prev, suggestedHandle: undefined } : prev);
                    }}
                  >
                    采用探测用户名
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Advanced Collapsible */}
          <CollapsibleSection
            title="高级选项"
            summary={`备注名、账号 ID、账号池（${pool || 'default'}）、自定义镜像与提交通道`}
            defaultOpen={Boolean(account || (!meta.requiresBaseUrl && baseUrl.trim()))}
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
                      setBaseUrl(event.target.value);
                      setRawCookie('');
                      invalidateProbe();
                    }}
                    placeholder={`默认 https://${meta.defaultDomain}`}
                  />
                </Field>
              )}
              <Field label="提交通道">
                <Select
                  value={transport}
                  onValueChange={value => {
                    setTransport(value as Account['transport']);
                    setRawCookie('');
                    invalidateProbe();
                  }}
                  disabled={!!account}
                >
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
  const client = useQueryClient();
  const parsedCookie = useMemo(
    () => parseOjCookieInput(rawCookie, account.platform, account.base_url),
    [rawCookie, account.platform, account.base_url],
  );
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
            onRawChange={setRawCookie}
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
      toast.error('无法删除 OJ 账号', { description: error.message });
      setDeleting(undefined);
    },
  });
  const accounts = query.data?.accounts ?? [];

  return <>
    <div className="mb-5 flex flex-col justify-between gap-3 border-y py-4 sm:flex-row sm:items-center">
      <div className="flex gap-3 text-xs leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>支持直接粘贴 cookies.txt / cURL / JSON 或 Cookie 头，并可一键验证登录态与自动识别用户名；所有会话只写不读，按账号池独占租约调度。</p>
      </div>
      <Button className="shrink-0" onClick={() => setEditor({ mode: 'create' })}><Plus className="size-4" />新增 OJ 账号</Button>
    </div>

    {query.isLoading ? <div className="skeleton h-48 rounded-card border bg-card" />
      : query.isError ? <Card><EmptyState icon={KeyRound} title="无法读取 OJ 账号池" description={(query.error as Error).message} action={<Button variant="secondary" onClick={() => void query.refetch()}>重试</Button>} /></Card>
      : accounts.length === 0 ? <Card><EmptyState icon={KeyRound} title="尚未登记 OJ 账号" description="登记 Codeforces、QOJ、VJudge 或 Hydro 评测账号；只需粘贴浏览器 Cookie 并确认用户名即可完成。" action={<Button onClick={() => setEditor({ mode: 'create' })}><Plus className="size-4" />登记第一个账号</Button>} /></Card>
      : <Card className="overflow-hidden">
          <div className="hidden grid-cols-[minmax(160px,1.2fr)_minmax(180px,1.2fr)_130px_140px] gap-4 border-b bg-muted/35 px-5 py-3 text-xs font-medium text-muted-foreground md:grid">
            <span>账号 / 用户名</span><span>平台 / 账号池</span><span>状态</span><span className="text-right">操作</span>
          </div>
          <div className="divide-y">{accounts.map(account => (
            <div key={account.id} className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(160px,1.2fr)_minmax(180px,1.2fr)_130px_140px] md:items-center">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{account.label}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{account.handle} · {account.id}</div>
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap gap-1.5">
                  <Badge>{OJ_PLATFORM_META[account.platform]?.label ?? account.platform}</Badge>
                  <Badge>池：{account.pool}</Badge>
                  <Badge>{account.transport === 'cookie' ? 'Cookie' : 'Submitter'}</Badge>
                </div>
                {account.base_url && <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{account.base_url}</div>}
              </div>
              <div className="text-xs">
                {account.ready
                  ? <span className="inline-flex items-center gap-1.5 text-foreground"><ShieldCheck className="size-3.5 text-primary" />就绪</span>
                  : <span className="text-warning">未就绪</span>}
              </div>
              <div className="flex gap-0.5 md:justify-end">
                <Tooltip content="编辑账号信息"><Button variant="ghost" size="icon" aria-label={`编辑 OJ 账号 ${account.label}`} onClick={() => setEditor({ mode: 'edit', account })}><Pencil className="size-4" /></Button></Tooltip>
                {account.transport === 'cookie' && (
                  <Tooltip content="轮换会话 Cookie"><Button variant="ghost" size="icon" aria-label={`轮换 OJ 账号 ${account.label}`} onClick={() => setRotating(account)}><KeyRound className="size-4" /></Button></Tooltip>
                )}
                <Tooltip content="删除账号"><Button variant="ghost" size="icon" aria-label={`删除 OJ 账号 ${account.label}`} onClick={() => setDeleting(account)}><Trash2 className="size-4" /></Button></Tooltip>
              </div>
            </div>
          ))}</div>
        </Card>}

    {editor && <AccountEditor key={`${editor.mode}-${editor.account?.id ?? 'new'}`} editor={editor} onClose={() => setEditor(undefined)} />}
    {rotating && <RotateAccountDialog key={rotating.id} account={rotating} onClose={() => setRotating(undefined)} />}
    {deleting && <ConfirmDialog open onOpenChange={open => { if (!open) setDeleting(undefined); }} title={`删除 ${deleting.label}？`} description="如果有 Contest 或活跃批次仍在引用此账号，后端会拒绝删除。" confirmLabel="删除账号" loading={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} />}
  </>;
}
