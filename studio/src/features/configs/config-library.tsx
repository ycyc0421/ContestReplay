import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Bot, Copy, FileCheck2, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentItemResponse, AgentVariantsResponse, CatalogAgent, CatalogContest, ContestItemResponse } from '@studio-api';
import { studioApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input, Field } from '@/components/ui/fields';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog, Dialog, DialogContent, DialogHeader, Note } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';

interface ConfigLibraryProps {
  onEditAgent: (item: AgentItemResponse) => void;
  onEditContest: (item: ContestItemResponse) => void;
  onDeletedAgent?: (path: string) => void;
  onDeletedContest?: (path: string) => void;
}

function invalidateConfigQueries(client: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['catalog'] }),
    client.invalidateQueries({ queryKey: ['matrix'] }),
    client.invalidateQueries({ queryKey: ['preflight'] }),
    client.invalidateQueries({ queryKey: ['coverage'] }),
    client.invalidateQueries({ queryKey: ['agent-item'] }),
    client.invalidateQueries({ queryKey: ['contest-item'] }),
  ]);
}

function CloneAgentDialog({ agent, onClose }: { agent: CatalogAgent; onClose: () => void }) {
  const [id, setId] = useState(`${agent.id}-copy`);
  const [name, setName] = useState(agent.name ? `${agent.name} / Copy` : '');
  const client = useQueryClient();
  const clone = useMutation({ mutationFn: () => studioApi.cloneAgent({ source_path: agent.path, id: id.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
    onSuccess: async result => { await invalidateConfigQueries(client); toast.success('Agent 变体已克隆', { description: result.path }); onClose(); },
    onError: (error: Error) => toast.error('克隆失败', { description: error.message }) });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader title={`克隆 ${agent.name ?? agent.id}`} description="生成一份独立 Agent Manifest；原配置与历史 Revision 保持不变。" /><form className="space-y-5" onSubmit={event => { event.preventDefault(); clone.mutate(); }}><Field label="新 Agent ID"><Input className="font-mono text-xs" value={id} onChange={event => setId(event.target.value)} /></Field><Field label="展示名称" hint="可选"><Input value={name} onChange={event => setName(event.target.value)} /></Field><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={clone.isPending} disabled={!id.trim()}><Copy className="size-4" />确认克隆</Button></div></form></DialogContent></Dialog>;
}

const effortOptions = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const speedOptions = ['standard', 'fast', 'ultrafast'];
function toggleValue(values: string[], value: string) { return values.includes(value) ? values.filter(item => item !== value) : [...values, value]; }
function Choice({ label, checked, disabled, onToggle }: { label: string; checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return <button type="button" role="checkbox" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onToggle} className={checked ? 'border bg-primary px-3 py-2 font-mono text-xs text-primary-foreground disabled:opacity-50' : 'border bg-card px-3 py-2 font-mono text-xs text-muted-foreground hover:border-primary/40 disabled:opacity-50'}>{label}</button>;
}
type VariantSelection = { efforts: string[]; speeds: string[] };
function VariantDialog({ agent, existingPaths, onClose }: { agent: CatalogAgent; existingPaths: Set<string>; onClose: () => void }) {
  const item = useQuery({ queryKey: ['agent-item', agent.path], queryFn: () => studioApi.agentItem(agent.path) });
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
  const generate = useMutation({ mutationFn: (vars: { dryRun: boolean; selection: VariantSelection; selectionKey: string }) => {
    if (!rawDocument) return Promise.reject(new Error('Agent 文档尚未就绪'));
    return studioApi.agentVariants({ base_document: rawDocument, reasoning_efforts: vars.selection.efforts, speed_tiers: vars.selection.speeds, dry_run: vars.dryRun });
  }, onSuccess: async (result, vars) => {
    if (vars.dryRun) {
      // Ignore stale dry-run responses if selection changed while pending.
      if (latestSelectionKey.current === vars.selectionKey) {
        setPreviewState({ selectionKey: vars.selectionKey, selection: vars.selection, response: result });
      }
      return;
    }
    await invalidateConfigQueries(client);
    toast.success(`已创建 ${result.variants.length} 个 Agent 变体`);
    onClose();
  }, onError: (error: Error) => toast.error('变体生成失败', { description: error.message }) });
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
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-3xl"><DialogHeader title={`派生 ${agent.name ?? agent.id}`} description="按 effort × speed tier 生成独立配置。先 Dry-run 校验全部变体，再一次性写入；失败不会留下半批文件。" />
    {item.isLoading ? <div className="skeleton h-48 border" /> : isLegacy ? <Note>此配置使用旧版 Agent 格式（未包含 contestreplay.dev/agent Manifest），无法直接派生变体矩阵。请先基于 Saved Provider 创建新版 Manifest Agent。</Note> : <div className="space-y-5"><div><div className="mb-2 text-xs font-medium">推理强度</div><div className="flex flex-wrap gap-2">{availableEfforts.map(value => <Choice key={value} label={`effort ${value}`} checked={efforts.includes(value)} disabled={generate.isPending} onToggle={() => { setEfforts(current => toggleValue(current, value)); setPreviewState(undefined); }} />)}</div></div>
      <div><div className="mb-2 text-xs font-medium">速度档位</div><div className="flex flex-wrap gap-2">{speedOptions.map(value => <Choice key={value} label={`speed ${value}`} checked={speeds.includes(value)} disabled={generate.isPending} onToggle={() => { setSpeeds(current => toggleValue(current, value)); setPreviewState(undefined); }} />)}</div></div>
      {matchingPreview && <div className="max-h-64 overflow-auto border scrollbar-thin"><div className="border-b bg-muted/40 px-3 py-2 font-mono text-[9px] uppercase text-muted-foreground">{matchingPreview.response.dry_run ? 'Dry-run preview' : 'Created variants'}</div>{matchingPreview.response.variants.map(variant => <div key={variant.id} className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"><div className="min-w-0 flex-1"><div className="text-xs font-medium">{variant.id}</div><div className="mt-1 font-mono text-[9px] text-muted-foreground">{variant.revision?.slice(0, 12) ?? variant.digests.effective_sha256.slice(0, 12)}</div></div>{variant.warnings.length > 0 && <Badge>{variant.warnings.length} warnings</Badge>}</div>)}</div>}
      {hasCollision && <p className="border-l-2 border-warning pl-3 text-xs text-warning">输出 ID 与源配置或已有文件冲突（{collidingIds.join('、')}）。请调整组合，避免 Dry-run 后创建失败。</p>}
      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between"><span className="text-xs text-muted-foreground">{efforts.length} efforts × {speeds.length} speeds = {count} variants</span><div className="flex gap-2"><Button variant="secondary" disabled={!item.data || count === 0 || hasCollision || generate.isPending} loading={generate.isPending && generate.variables?.dryRun === true} onClick={() => generate.mutate({ dryRun: true, selection: { efforts: [...efforts], speeds: [...speeds] }, selectionKey })}>Dry-run 预览</Button><Button disabled={!matchingPreview?.response.dry_run || hasCollision || generate.isPending} loading={generate.isPending && generate.variables?.dryRun === false} onClick={() => { if (!matchingPreview) return; generate.mutate({ dryRun: false, selection: matchingPreview.selection, selectionKey: matchingPreview.selectionKey }); }}><Sparkles className="size-4" />创建 {matchingPreview?.response.variants.length ?? count} 个变体</Button></div></div>
    </div>}
  </DialogContent></Dialog>;
}

export function ConfigLibrary({ onEditAgent, onEditContest, onDeletedAgent, onDeletedContest }: ConfigLibraryProps) {
  const [kind, setKind] = useState('agents');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState('');
  const [cloning, setCloning] = useState<CatalogAgent>();
  const [variants, setVariants] = useState<CatalogAgent>();
  const [deleting, setDeleting] = useState<{ kind: 'agent' | 'contest'; path: string; label: string }>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const agents = useQuery({ queryKey: ['catalog', 'agents'], queryFn: studioApi.catalogAgents, refetchOnMount: 'always' });
  const contests = useQuery({ queryKey: ['catalog', 'contests'], queryFn: studioApi.catalogContests, refetchOnMount: 'always' });
  const remove = useMutation({ mutationFn: (target: NonNullable<typeof deleting>) => target.kind === 'agent' ? studioApi.deleteAgent(target.path) : studioApi.deleteContest(target.path),
    onSuccess: async (_, target) => {
      await invalidateConfigQueries(client);
      if (target.kind === 'agent') onDeletedAgent?.(target.path);
      else onDeletedContest?.(target.path);
      toast.success('配置已删除');
      setDeleting(undefined);
    },
    onError: (error: Error) => { toast.error('无法删除配置', { description: error.message }); setDeleting(undefined); } });
  const editAgent = async (agent: CatalogAgent) => {
    setLoading(agent.path);
    try { onEditAgent(await studioApi.agentItem(agent.path)); }
    catch (error) { toast.error('无法读取 Agent', { description: (error as Error).message }); }
    finally { setLoading(''); }
  };
  const editContest = async (contest: CatalogContest) => {
    setLoading(contest.path);
    try { onEditContest(await studioApi.contestItem(contest.path)); }
    catch (error) { toast.error('无法读取 Contest', { description: (error as Error).message }); }
    finally { setLoading(''); }
  };
  const addToBatch = (kind: 'agent' | 'contest', path: string) => {
    sessionStorage.setItem('cr.batch.pending', JSON.stringify({ kind, path }));
    void navigate({ to: '/batches/new' });
  };
  const filteredAgents = (agents.data?.agents ?? []).filter(agent => `${agent.id} ${agent.name ?? ''} ${agent.model} ${agent.vendor ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const filteredContests = (contests.data?.contests ?? []).filter(contest => `${contest.id} ${contest.title} ${contest.judge_kind}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <Card className="overflow-hidden"><div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between"><Tabs value={kind} onValueChange={setKind}><TabsList><TabsTrigger value="agents"><Bot className="size-3.5" />Agents {agents.data?.agents.length ?? '—'}</TabsTrigger><TabsTrigger value="contests"><FileCheck2 className="size-3.5" />Contests {contests.data?.contests.length ?? '—'}</TabsTrigger></TabsList></Tabs><label className="relative sm:w-80"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label="搜索已有配置" className="pl-9" placeholder="搜索 ID、名称、模型或判题方式" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
      {kind === 'agents' ? <div className="divide-y">{filteredAgents.map(agent => <div key={agent.path} className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(180px,1fr)_minmax(170px,1fr)_100px_240px] lg:items-center"><div><div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{agent.name ?? agent.id}</span>{!agent.valid && <Badge>invalid</Badge>}</div><div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{agent.id}</div></div><div className="min-w-0"><div className="truncate font-mono text-xs">{agent.model}</div><div className="mt-1 text-[10px] text-muted-foreground">{agent.vendor ?? '未标厂商'} · {agent.harness} · {agent.speed_tier ?? 'standard'}</div></div><div>{agent.provider_available ? <Badge>Provider ready</Badge> : <span className="text-xs text-warning">Provider 未就绪</span>}</div><div className="flex flex-wrap gap-0.5 lg:justify-end"><Tooltip content="加入新批次"><Button variant="ghost" size="icon" aria-label={`将 ${agent.id} 加入批次`} disabled={!agent.valid} onClick={() => addToBatch('agent', agent.path)}><Plus className="size-4" /></Button></Tooltip><Tooltip content="派生变体矩阵"><Button variant="ghost" size="icon" aria-label={`派生 ${agent.id} 变体`} disabled={!agent.valid} onClick={() => setVariants(agent)}><Sparkles className="size-4" /></Button></Tooltip><Tooltip content="克隆"><Button variant="ghost" size="icon" aria-label={`克隆 ${agent.id}`} onClick={() => setCloning(agent)}><Copy className="size-4" /></Button></Tooltip><Tooltip content="编辑"><Button variant="ghost" size="icon" aria-label={`编辑 ${agent.id}`} loading={loading === agent.path} onClick={() => void editAgent(agent)}><Pencil className="size-4" /></Button></Tooltip><Tooltip content="删除"><Button variant="ghost" size="icon" aria-label={`删除 ${agent.id}`} onClick={() => setDeleting({ kind: 'agent', path: agent.path, label: agent.name ?? agent.id })}><Trash2 className="size-4" /></Button></Tooltip></div>{agent.issues.length > 0 && <p className="text-xs text-warning lg:col-span-4">{agent.issues.join('；')}</p>}</div>)}{filteredAgents.length === 0 && <p className="p-8 text-center text-xs text-muted-foreground">没有匹配的 Agent 配置。</p>}</div>
      : <div className="divide-y">{filteredContests.map(contest => <div key={contest.path} className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(200px,1.3fr)_minmax(160px,1fr)_100px_140px] lg:items-center"><div><div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{contest.title}</span>{!contest.valid && <Badge>invalid</Badge>}</div><div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{contest.id} · data v{contest.data_version}</div></div><div className="text-xs text-muted-foreground">{contest.judge_kind} · {contest.problem_count} 题 · {Math.round(contest.time_limit_ms / 60000)} 分钟</div><Badge>{contest.scoring_mode ?? 'default'}</Badge><div className="flex gap-0.5 lg:justify-end"><Tooltip content="加入新批次"><Button variant="ghost" size="icon" aria-label={`将 ${contest.id} 加入批次`} disabled={!contest.valid} onClick={() => addToBatch('contest', contest.path)}><Plus className="size-4" /></Button></Tooltip><Tooltip content="编辑"><Button variant="ghost" size="icon" aria-label={`编辑 ${contest.id}`} loading={loading === contest.path} onClick={() => void editContest(contest)}><Pencil className="size-4" /></Button></Tooltip><Tooltip content="删除"><Button variant="ghost" size="icon" aria-label={`删除 ${contest.id}`} onClick={() => setDeleting({ kind: 'contest', path: contest.path, label: contest.title })}><Trash2 className="size-4" /></Button></Tooltip></div>{contest.issues.length > 0 && <p className="text-xs text-warning lg:col-span-4">{contest.issues.join('；')}</p>}</div>)}{filteredContests.length === 0 && <p className="p-8 text-center text-xs text-muted-foreground">没有匹配的 Contest 配置。</p>}</div>}
    </Card>
    {cloning && <CloneAgentDialog agent={cloning} onClose={() => setCloning(undefined)} />}
    {variants && <VariantDialog key={variants.path} agent={variants} existingPaths={new Set((agents.data?.agents ?? []).map(item => item.path))} onClose={() => setVariants(undefined)} />}
    {deleting && <ConfirmDialog open onOpenChange={open => { if (!open) setDeleting(undefined); }} title={`删除 ${deleting.label}？`} description="只会删除这份配置清单，不会改写历史运行、锁定计划或结果。Contest 的私有答案与题面材料不会被删除。" confirmLabel="删除配置" loading={remove.isPending} onConfirm={() => remove.mutate(deleting)} />}
  </>;
}
