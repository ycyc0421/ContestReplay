import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, Bot, Copy, FileCheck2, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentVariantsResponse, CatalogAgent } from '@studio-api';
import { studioApi } from '@/lib/api';
import { invalidateConfigGraph, queryKeys } from '@/state/query-keys';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input, Field } from '@/components/ui/fields';
import { ConfirmDialog, Dialog, DialogContent, DialogHeader, Note } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/empty-state';
import { AnimatedPanel } from '@/design-system/motion';
import { SegmentedTabs } from '@/design-system/segmented-tabs';

interface ConfigLibraryProps {
  activeTab: 'agents' | 'contests';
  onTabChange: (tab: 'agents' | 'contests') => void;
  search: string;
  onSearchChange: (value: string) => void;
  loadingPath?: string;
  onEditAgent: (path: string) => void;
  onEditContest: (path: string) => void;
  onDeletedAgent?: (path: string) => void;
  onDeletedContest?: (path: string) => void;
  onCreateAgent?: () => void;
  onCreateContest?: () => void;
}

function CloneAgentDialog({ agent, onClose }: { agent: CatalogAgent; onClose: () => void }) {
  const [id, setId] = useState(`${agent.id}-copy`);
  const [name, setName] = useState(agent.name ? `${agent.name} / Copy` : '');
  const client = useQueryClient();
  const clone = useMutation({
    mutationFn: () => studioApi.cloneAgent({
      source_path: agent.path,
      id: id.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
    }),
    onSuccess: async result => {
      await invalidateConfigGraph(client);
      toast.success('Agent 变体已克隆', { description: result.path });
      onClose();
    },
    onError: (error: Error) => toast.error('克隆失败', { description: error.message }),
  });
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader
          title={`克隆 ${agent.name ?? agent.id}`}
          description="生成一份独立 Agent Manifest；原配置与历史 Revision 保持不变。"
        />
        <form className="space-y-5" onSubmit={event => { event.preventDefault(); clone.mutate(); }}>
          <Field label="新 Agent ID"><Input className="font-mono text-xs" value={id} onChange={event => setId(event.target.value)} /></Field>
          <Field label="展示名称" hint="可选"><Input value={name} onChange={event => setName(event.target.value)} /></Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" loading={clone.isPending} disabled={!id.trim()}><Copy className="size-4" />确认克隆</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const effortOptions = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const speedOptions = ['standard', 'fast', 'ultrafast'];
function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}
function Choice({ label, checked, disabled, onToggle }: { label: string; checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={checked
        ? 'rounded-[2px] border border-primary bg-primary px-3 py-2 font-mono text-xs text-primary-foreground transition-colors disabled:opacity-50'
        : 'rounded-[2px] border bg-card px-3 py-2 font-mono text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50'}
    >
      {label}
    </button>
  );
}

type VariantSelection = { efforts: string[]; speeds: string[] };
function VariantDialog({ agent, existingPaths, onClose }: { agent: CatalogAgent; existingPaths: Set<string>; onClose: () => void }) {
  const item = useQuery({ queryKey: queryKeys.agentItem(agent.path), queryFn: () => studioApi.agentItem(agent.path) });
  const supportsEffort = agent.harness === 'codex';
  const [efforts, setEfforts] = useState(supportsEffort ? ['high'] : ['default']);
  const [speeds, setSpeeds] = useState(supportsEffort ? ['standard'] : ['fast']);
  const [previewState, setPreviewState] = useState<{ selectionKey: string; selection: VariantSelection; response: AgentVariantsResponse }>();
  const client = useQueryClient();
  const selectionKey = JSON.stringify({ efforts, speeds });
  const latestSelectionKey = useRef(selectionKey);
  latestSelectionKey.current = selectionKey;
  const rawDocument = item.data?.document && typeof item.data.document === 'object' && !Array.isArray(item.data.document)
    ? item.data.document as Record<string, unknown>
    : undefined;
  const isLegacy = Boolean(rawDocument && rawDocument.kind !== 'contestreplay.dev/agent');
  const generate = useMutation({
    mutationFn: (vars: { dryRun: boolean; selection: VariantSelection; selectionKey: string }) => {
      if (!rawDocument) return Promise.reject(new Error('Agent 文档尚未就绪'));
      return studioApi.agentVariants({
        base_document: rawDocument,
        reasoning_efforts: vars.selection.efforts,
        speed_tiers: vars.selection.speeds,
        dry_run: vars.dryRun,
      });
    },
    onSuccess: async (result, vars) => {
      if (vars.dryRun) {
        if (latestSelectionKey.current === vars.selectionKey) {
          setPreviewState({ selectionKey: vars.selectionKey, selection: vars.selection, response: result });
        }
        return;
      }
      await invalidateConfigGraph(client);
      toast.success(`已创建 ${result.variants.length} 个 Agent 变体`);
      onClose();
    },
    onError: (error: Error) => toast.error('变体生成失败', { description: error.message }),
  });
  const plannedIds = efforts.flatMap(effort => speeds.map(speed => {
    const slugParts = [agent.id];
    if (effort !== 'default') slugParts.push(effort);
    if (speed !== 'standard' || speeds.length > 1) slugParts.push(speed);
    return slugParts.join('-');
  }));
  const collidingIds = [...new Set(plannedIds.filter(id => id === agent.id || existingPaths.has(`agents/${id}.toml`)))];
  const hasCollision = collidingIds.length > 0;
  const count = efforts.length * speeds.length;
  const availableEfforts = supportsEffort ? effortOptions : ['default'];
  const matchingPreview = previewState?.selectionKey === selectionKey ? previewState : undefined;

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader
          title={`派生 ${agent.name ?? agent.id}`}
          description="按推理强度 × 速度档位生成独立配置。先 Dry-run 校验全部变体，再一次性写入；失败不会留下半批文件。"
        />
        {item.isLoading ? <div className="skeleton h-48 border" />
          : isLegacy ? <Note>此配置使用旧版 Agent 格式（未包含 contestreplay.dev/agent Manifest），无法直接派生变体矩阵。请先基于模型 API 接入创建新版 Manifest Agent。</Note>
          : <div className="space-y-5">
              <div>
                <div className="mb-2 text-xs font-medium">推理强度</div>
                <div className="flex flex-wrap gap-2">
                  {availableEfforts.map(value => (
                    <Choice
                      key={value}
                      label={`effort ${value}`}
                      checked={efforts.includes(value)}
                      disabled={generate.isPending}
                      onToggle={() => { setEfforts(current => toggleValue(current, value)); setPreviewState(undefined); }}
                    />
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium">速度档位</div>
                <div className="flex flex-wrap gap-2">
                  {speedOptions.map(value => (
                    <Choice
                      key={value}
                      label={`speed ${value}`}
                      checked={speeds.includes(value)}
                      disabled={generate.isPending}
                      onToggle={() => { setSpeeds(current => toggleValue(current, value)); setPreviewState(undefined); }}
                    />
                  ))}
                </div>
              </div>
              {matchingPreview && (
                <div className="scrollbar-thin max-h-64 overflow-auto rounded-[3px] border">
                  <div className="border-b bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                    {matchingPreview.response.dry_run ? 'Dry-run 校验预览' : '已创建变体'}
                  </div>
                  {matchingPreview.response.variants.map(variant => (
                    <div key={variant.id} className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium">{variant.id}</div>
                        <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                          {variant.revision?.slice(0, 12) ?? variant.digests.effective_sha256.slice(0, 12)}
                        </div>
                      </div>
                      {variant.warnings.length > 0 && <Badge>{variant.warnings.length} 条提示</Badge>}
                    </div>
                  ))}
                </div>
              )}
              {hasCollision && (
                <p className="border-l-2 border-warning pl-3 text-xs text-warning">
                  输出 ID 与源配置或已有文件冲突（{collidingIds.join('、')}）。请调整组合，避免 Dry-run 后创建失败。
                </p>
              )}
              <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-muted-foreground">{efforts.length} 强度 × {speeds.length} 档位 = 共 {count} 个变体</span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    disabled={!item.data || count === 0 || hasCollision || generate.isPending}
                    loading={generate.isPending && generate.variables?.dryRun === true}
                    onClick={() => generate.mutate({ dryRun: true, selection: { efforts: [...efforts], speeds: [...speeds] }, selectionKey })}
                  >
                    Dry-run 预览
                  </Button>
                  <Button
                    disabled={!matchingPreview?.response.dry_run || hasCollision || generate.isPending}
                    loading={generate.isPending && generate.variables?.dryRun === false}
                    onClick={() => {
                      if (!matchingPreview) return;
                      generate.mutate({ dryRun: false, selection: matchingPreview.selection, selectionKey: matchingPreview.selectionKey });
                    }}
                  >
                    <Sparkles className="size-4" />创建 {matchingPreview?.response.variants.length ?? count} 个变体
                  </Button>
                </div>
              </div>
            </div>}
      </DialogContent>
    </Dialog>
  );
}

const judgeLabels: Record<string, string> = {
  local: '本地答案',
  codeforces: 'Codeforces',
  qoj: 'QOJ',
  vjudge: 'VJudge',
  hydro: 'Hydro',
};

export function ConfigLibrary({
  activeTab,
  onTabChange,
  search,
  onSearchChange,
  loadingPath,
  onEditAgent,
  onEditContest,
  onDeletedAgent,
  onDeletedContest,
  onCreateAgent,
  onCreateContest,
}: ConfigLibraryProps) {
  const [cloning, setCloning] = useState<CatalogAgent>();
  const [variants, setVariants] = useState<CatalogAgent>();
  const [deleting, setDeleting] = useState<{ kind: 'agent' | 'contest'; path: string; label: string }>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const agents = useQuery({ queryKey: queryKeys.catalogAgents, queryFn: studioApi.catalogAgents, refetchOnMount: 'always' });
  const contests = useQuery({ queryKey: queryKeys.catalogContests, queryFn: studioApi.catalogContests, refetchOnMount: 'always' });
  const remove = useMutation({
    mutationFn: (target: NonNullable<typeof deleting>) =>
      target.kind === 'agent' ? studioApi.deleteAgent(target.path) : studioApi.deleteContest(target.path),
    onSuccess: async (_, target) => {
      await invalidateConfigGraph(client);
      if (target.kind === 'agent') onDeletedAgent?.(target.path);
      else onDeletedContest?.(target.path);
      toast.success('配置已删除');
      setDeleting(undefined);
    },
    onError: (error: Error) => {
      toast.error('无法删除配置', { description: error.message });
      setDeleting(undefined);
    },
  });

  const addToBatch = (kind: 'agent' | 'contest', path: string) => {
    void navigate({
      to: '/batches/new',
      search: kind === 'agent' ? { addAgent: path } : { addContest: path },
    });
  };

  const normalizedQuery = search.trim().toLowerCase();
  const filteredAgents = (agents.data?.agents ?? []).filter(agent =>
    !normalizedQuery || `${agent.id} ${agent.name ?? ''} ${agent.model} ${agent.vendor ?? ''} ${agent.harness}`.toLowerCase().includes(normalizedQuery),
  );
  const filteredContests = (contests.data?.contests ?? []).filter(contest =>
    !normalizedQuery || `${contest.id} ${contest.title} ${contest.judge_kind}`.toLowerCase().includes(normalizedQuery),
  );

  return <>
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedTabs
          id="config-library"
          panelIdPrefix="config-library-panel"
          ariaLabel="配置库分类"
          value={activeTab}
          onValueChange={onTabChange}
          items={[
            { value: 'agents', label: 'Agents', icon: Bot, count: agents.data?.agents.length ?? '—' },
            { value: 'contests', label: 'Contests', icon: FileCheck2, count: contests.data?.contests.length ?? '—' },
          ]}
        />
        <label className="relative sm:w-80">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索已有配置"
            className="pl-9"
            placeholder="搜索名称、模型或判题平台"
            value={search}
            onChange={event => onSearchChange(event.target.value)}
          />
        </label>
      </div>

      <AnimatedPanel panelKey={activeTab} role="tabpanel" id={`config-library-panel-${activeTab}`} ariaLabelledBy={`config-library-tab-${activeTab}`}>
        {activeTab === 'agents' ? (
          agents.isLoading ? (
            <div className="space-y-2 p-4">{[1, 2, 3].map(i => <div key={i} className="skeleton h-16 rounded-[3px] border bg-muted/30" />)}</div>
          ) : agents.isError ? (
            <EmptyState
              icon={AlertTriangle}
              title="无法读取 Agent 配置列表"
              description={(agents.error as Error)?.message ?? '目录请求失败'}
              action={<Button variant="secondary" onClick={() => void agents.refetch()}>重试</Button>}
            />
          ) : filteredAgents.length === 0 ? (
            <EmptyState
              icon={Bot}
              title={normalizedQuery ? '没有匹配的 Agent 配置' : '尚未创建 Agent 配置'}
              description={normalizedQuery ? '试试清空搜索词或切换其他模型关键字。' : '点击右上角「新建 Agent」创建第一份评测配置。'}
              action={!normalizedQuery && onCreateAgent ? <Button variant="secondary" onClick={onCreateAgent}><Plus className="size-4" />新建 Agent</Button> : undefined}
            />
          ) : (
            <div className="divide-y">
              {filteredAgents.map(agent => {
                const hasDistinctName = Boolean(agent.name && agent.name.trim() && agent.name.trim() !== agent.id);
                return (
                  <div key={agent.path} className="grid gap-3 px-5 py-4 transition-colors hover:bg-muted/25 lg:grid-cols-[minmax(200px,1.2fr)_minmax(180px,1fr)_120px_220px] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold">{hasDistinctName ? agent.name : agent.id}</span>
                        {!agent.valid && <Badge className="border-danger/30 bg-danger/10 text-danger">配置无效</Badge>}
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {hasDistinctName ? `${agent.id} · ${agent.path}` : agent.path}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs">{agent.model}</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {agent.vendor ?? '未标厂商'} · {agent.harness} · {agent.speed_tier ?? 'standard'}
                      </div>
                    </div>
                    <div>
                      {agent.provider_available
                        ? <Badge>Provider 就绪</Badge>
                        : <span className="text-xs text-warning">Provider 未就绪</span>}
                    </div>
                    <div className="flex flex-wrap gap-0.5 lg:justify-end">
                      <Tooltip content="加入新批次">
                        <Button variant="ghost" size="icon" aria-label={`将 ${agent.id} 加入批次`} disabled={!agent.valid} onClick={() => addToBatch('agent', agent.path)}>
                          <Plus className="size-4" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="派生变体矩阵">
                        <Button variant="ghost" size="icon" aria-label={`派生 ${agent.id} 变体`} disabled={!agent.valid} onClick={() => setVariants(agent)}>
                          <Sparkles className="size-4" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="克隆">
                        <Button variant="ghost" size="icon" aria-label={`克隆 ${agent.id}`} onClick={() => setCloning(agent)}>
                          <Copy className="size-4" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="编辑">
                        <Button variant="ghost" size="icon" aria-label={`编辑 ${agent.id}`} loading={loadingPath === agent.path} onClick={() => onEditAgent(agent.path)}>
                          <Pencil className="size-4" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="删除">
                        <Button variant="ghost" size="icon" aria-label={`删除 ${agent.id}`} onClick={() => setDeleting({ kind: 'agent', path: agent.path, label: agent.name ?? agent.id })}>
                          <Trash2 className="size-4" />
                        </Button>
                      </Tooltip>
                    </div>
                    {agent.issues.length > 0 && <p className="text-xs text-warning lg:col-span-4">{agent.issues.join('；')}</p>}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          contests.isLoading ? (
            <div className="space-y-2 p-4">{[1, 2, 3].map(i => <div key={i} className="skeleton h-16 rounded-[3px] border bg-muted/30" />)}</div>
          ) : contests.isError ? (
            <EmptyState
              icon={AlertTriangle}
              title="无法读取 Contest 配置列表"
              description={(contests.error as Error)?.message ?? '目录请求失败'}
              action={<Button variant="secondary" onClick={() => void contests.refetch()}>重试</Button>}
            />
          ) : filteredContests.length === 0 ? (
            <EmptyState
              icon={FileCheck2}
              title={normalizedQuery ? '没有匹配的 Contest 配置' : '尚未创建 Contest 配置'}
              description={normalizedQuery ? '试试清空搜索词或换个赛事关键字。' : '点击右上角「新建 Contest」录入题面与判题方式。'}
              action={!normalizedQuery && onCreateContest ? <Button variant="secondary" onClick={onCreateContest}><Plus className="size-4" />新建 Contest</Button> : undefined}
            />
          ) : (
            <div className="divide-y">
              {filteredContests.map(contest => (
                <div key={contest.path} className="grid gap-3 px-5 py-4 transition-colors hover:bg-muted/25 lg:grid-cols-[minmax(220px,1.3fr)_minmax(180px,1fr)_110px_140px] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">{contest.title}</span>
                      {!contest.valid && <Badge className="border-danger/30 bg-danger/10 text-danger">配置无效</Badge>}
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {contest.id} · v{contest.data_version} · {contest.path}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {judgeLabels[contest.judge_kind] ?? contest.judge_kind} · {contest.problem_count} 题 · {Math.round(contest.time_limit_ms / 60000)} 分钟
                  </div>
                  <div><Badge>{contest.scoring_mode ?? '默认计分'}</Badge></div>
                  <div className="flex gap-0.5 lg:justify-end">
                    <Tooltip content="加入新批次">
                      <Button variant="ghost" size="icon" aria-label={`将 ${contest.id} 加入批次`} disabled={!contest.valid} onClick={() => addToBatch('contest', contest.path)}>
                        <Plus className="size-4" />
                      </Button>
                    </Tooltip>
                    <Tooltip content="编辑">
                      <Button variant="ghost" size="icon" aria-label={`编辑 ${contest.id}`} loading={loadingPath === contest.path} onClick={() => onEditContest(contest.path)}>
                        <Pencil className="size-4" />
                      </Button>
                    </Tooltip>
                    <Tooltip content="删除">
                      <Button variant="ghost" size="icon" aria-label={`删除 ${contest.id}`} onClick={() => setDeleting({ kind: 'contest', path: contest.path, label: contest.title })}>
                        <Trash2 className="size-4" />
                      </Button>
                    </Tooltip>
                  </div>
                  {contest.issues.length > 0 && <p className="text-xs text-warning lg:col-span-4">{contest.issues.join('；')}</p>}
                </div>
              ))}
            </div>
          )
        )}
      </AnimatedPanel>
    </Card>

    {cloning && <CloneAgentDialog key={cloning.path} agent={cloning} onClose={() => setCloning(undefined)} />}
    {variants && <VariantDialog key={variants.path} agent={variants} existingPaths={new Set((agents.data?.agents ?? []).map(item => item.path))} onClose={() => setVariants(undefined)} />}
    {deleting && (
      <ConfirmDialog
        open
        onOpenChange={open => { if (!open) setDeleting(undefined); }}
        title={`删除 ${deleting.label}？`}
        description="只会删除这份配置清单，不会改写历史运行、锁定计划或结果。Contest 的私有答案与题面材料不会被删除。"
        confirmLabel="删除配置"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(deleting)}
      />
    )}
  </>;
}
