import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { AgentItemResponse } from '@studio-api';
import { Braces, Eye, FileCode2, KeyRound, RefreshCw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, studioApi } from '@/lib/api';
import { queryKeys } from '@/state/query-keys';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Note } from '@/components/ui/dialog';
import { AnimatedPanel } from '@/design-system/motion';
import { SegmentedTabs } from '@/design-system/segmented-tabs';
import { SavedPath } from './saved-path';
import { formatLabel, useCapabilities, type ConfigFormat, type HarnessField, type StudioCapabilities } from './capabilities';

const schema = z.object({
  id: z.string().trim().min(1, '请输入 Agent ID').regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, 'ID 仅支持字母、数字、点、下划线与连字符'),
  name: z.string().trim().max(120), speedTier: z.enum(['standard', 'fast', 'ultrafast']),
  vendor: z.string(), connection: z.string(), harness: z.string().min(1), model: z.string().trim().min(1, '请输入模型标识'),
  baseUrl: z.string(), keyEnv: z.string(), nativeConfig: z.string(), harnessOptions: z.record(z.string(), z.string()),
});
type Values = z.infer<typeof schema>;
const vendors = [['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['google', 'Google'], ['other', '其他 / 自定义']] as const;

function defaultsFor(fields: HarnessField[]) {
  return Object.fromEntries(fields.map(field => [field.id, field.default ?? '']));
}
function SectionIndex({ index, title, description }: { index: string; title: string; description: string }) {
  return <div className="mb-5 grid grid-cols-[30px_1fr] gap-3"><span className="font-mono text-[10px] text-muted-foreground">{index}</span><div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div></div>;
}
function ConnectionField({ capabilities, value, onChange, register, error }: {
  capabilities: StudioCapabilities; value: string; onChange: (value: string) => void; error?: string;
  register: ReturnType<typeof useForm<Values>>['register'];
}) {
  const providers = useQuery({ queryKey: queryKeys.providers, queryFn: studioApi.providers, enabled: capabilities.features.connections });
  if (capabilities.features.connections) return <div className="space-y-3"><Field label="Provider" hint="可复用接入配置" error={error}>
    <Select value={value} onValueChange={onChange}><SelectItem value="default">选择已保存的 Provider</SelectItem>{providers.data?.providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.label} · {provider.protocol}</SelectItem>)}</Select>
  </Field><div className="flex flex-col gap-3 border-l border-primary/25 pl-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-[11px] leading-5 text-muted-foreground">模型 API 接入在「连接与凭据」中统一管理；密钥只写入，不会回显。</p><div className="flex shrink-0 gap-1"><Button type="button" variant="ghost" size="sm" asChild><Link to="/connections" search={{ tab: 'providers' }}><KeyRound className="size-3.5" />管理接入</Link></Button><Button type="button" variant="ghost" size="sm" onClick={() => void providers.refetch()}><RefreshCw className={providers.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button></div></div>
    {providers.data && !providers.data.providers.length && <p className="text-xs text-warning">尚未登记 Provider，请先创建。</p>}</div>;
  return <div className="space-y-5"><div className="grid gap-5 sm:grid-cols-[1fr_220px]"><Field label="API Base URL" hint="旧版连接字段"><Input className="font-mono text-xs" {...register('baseUrl')} /></Field>
    <Field label="凭据环境变量名"><Input className="font-mono text-xs" {...register('keyEnv')} /></Field></div>
    <p className="border-l border-primary/30 pl-3 text-[11px] leading-5 text-muted-foreground">当前 runner 使用宿主环境变量提供凭据。实现连接库契约后，这里会自动替换为可复用连接，不再要求理解变量名。</p></div>;
}

type NativeConfig = { content?: string; path?: string; sha256?: string; format?: 'toml' | 'yaml' | 'json'; schema?: string };
type HarnessDocument = { kind?: string; options?: Record<string, unknown>; env?: Record<string, string>; native_config?: NativeConfig };
type AgentDocument = {
  kind?: string; schema_version?: number; id?: string; agent_id?: string; name?: string; vendor?: string; provider?: string; connection?: string; model?: string; speed_tier?: 'standard' | 'fast' | 'ultrafast';
  harness?: string | HarnessDocument; api?: string; base_url?: string; api_key_env?: string; reasoning_effort?: string; service_tier?: string; temperature?: number; config?: string;
};

function LegacyAgentReadOnly({ initial }: { initial: AgentItemResponse }) {
  const source = (initial.document && typeof initial.document === 'object' && !Array.isArray(initial.document) ? initial.document : {}) as AgentDocument;
  const harnessKind = typeof source.harness === 'string' ? source.harness : source.harness?.kind ?? initial.harness ?? '—';
  const rows: [string, string | undefined][] = [
    ['文件路径', `${initial.path} (${initial.format})`],
    ['Agent ID', source.id ?? source.agent_id ?? initial.id],
    ['展示名称', source.name ?? initial.name],
    ['Harness', harnessKind],
    ['模型标识', source.model ?? initial.model],
    ['速度档位', source.speed_tier ?? initial.speed_tier ?? 'standard'],
    ['API 协议', source.api],
    ['Base URL', source.base_url],
    ['凭据环境变量', source.api_key_env],
    ['推理强度', source.reasoning_effort],
    ['服务档位', source.service_tier],
    ['Temperature', source.temperature !== undefined ? String(source.temperature) : undefined],
    ['外部配置', source.config],
  ];
  return <div className="space-y-5">
    <Note>此配置使用旧版 Agent 格式（非 <span className="font-mono">contestreplay.dev/agent</span> Manifest v1），以只读方式展示以避免保存时丢失旧字段或违反 Manifest 校验。如需在 Studio 中编辑或派生变体，请点击右上角「新建 Agent」创建基于 Provider 的新版配置。</Note>
    <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-3 border-y py-5 text-xs">
      {rows.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}
    </dl>
    {initial.issues.length > 0 && <p className="text-xs text-warning">{initial.issues.join('；')}</p>}
  </div>;
}

function AgentManifestForm({ capabilities, initial, onSaved }: { capabilities: StudioCapabilities; initial?: AgentItemResponse; onSaved?: (intent?: 'save' | 'batch') => Promise<void> | void }) {
  const [saved, setSaved] = useState<string>();
  const [harnessTab, setHarnessTab] = useState<'guided' | 'native' | 'preview'>('guided');
  const navigate = useNavigate();
  const intent = useRef<'save' | 'batch'>('save');
  const [preview, setPreview] = useState<{ content: string; format: ConfigFormat; revision?: string }>();
  const source = initial?.document as AgentDocument | undefined;
  const sourceHarness = source?.harness && typeof source.harness === 'object' ? source.harness : undefined;
  const initialHarness = capabilities.harnesses.find(item => item.id === sourceHarness?.kind) ?? capabilities.harnesses[0]!;
  const initialOptions: Record<string, string> = Object.fromEntries(Object.entries(sourceHarness?.options ?? {}).map(([key, value]) => [key, String(value)]));
  const [removeNative, setRemoveNative] = useState(false);
  const { register, control, handleSubmit, watch, setValue, setError, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: {
    id: source?.id ?? '', name: source?.name ?? '', speedTier: source?.speed_tier ?? 'standard',
    vendor: source ? (source.vendor ?? 'unspecified') : (capabilities.features.agent_vendor ? 'openai' : 'unspecified'),
    connection: source?.provider ?? source?.connection ?? 'default', harness: initialHarness.id, model: source?.model ?? '',
    baseUrl: source?.base_url ?? 'https://api.openai.com/v1', keyEnv: source?.api_key_env ?? 'OPENAI_API_KEY', nativeConfig: sourceHarness?.native_config?.content ?? '',
    harnessOptions: { ...defaultsFor(initialHarness.fields), ...initialOptions },
  } });
  const harnessId = watch('harness');
  const harness = capabilities?.harnesses.find(item => item.id === harnessId) ?? initialHarness;
  const values = watch();
  const sameHarness = values.harness === sourceHarness?.kind;
  const hasExternalNative = Boolean(sameHarness && sourceHarness?.native_config?.path);
  useEffect(() => { if (!hasExternalNative) setRemoveNative(false); }, [hasExternalNative]);
  const document = useMemo(() => {
    const identity = { id: values.id, ...(values.name.trim() ? { name: values.name.trim() } : {}),
      ...(values.speedTier !== 'standard' ? { speed_tier: values.speedTier } : {}),
      ...(capabilities.features.agent_vendor && values.vendor && values.vendor !== 'unspecified' ? { vendor: values.vendor } : {}), model: values.model };
    const options = Object.fromEntries(Object.entries(values.harnessOptions).filter(([, value]) => value && value !== 'default').map(([key, value]) => {
      const field = harness?.fields.find(item => item.id === key);
      if (field?.kind === 'number') {
        const parsed = Number(value);
        return [key, Number.isFinite(parsed) ? parsed : value];
      }
      return [key, value];
    }));
    const nativeOverride = harness?.supports_overrides && !removeNative
      ? values.nativeConfig.trim()
        ? { format: harness.native_format, ...(sameHarness && sourceHarness?.native_config?.schema ? { schema: sourceHarness.native_config.schema } : {}), content: values.nativeConfig }
        : hasExternalNative ? sourceHarness!.native_config : undefined
      : undefined;
    return { ...identity, kind: 'contestreplay.dev/agent', schema_version: 1,
      ...(capabilities.features.connections ? { provider: values.connection } : {}),
      harness: { kind: values.harness, version: harness?.version, options,
        ...(sameHarness && sourceHarness?.env ? { env: sourceHarness.env } : {}),
        ...(nativeOverride ? { native_config: nativeOverride } : {}) },
    };
  }, [capabilities, values, harness, sourceHarness, sameHarness, hasExternalNative, removeNative]);
  if (!harness) return <Note>未找到所选 Harness 的能力描述。</Note>;
  const changeHarness = (id: string) => {
    const next = capabilities.harnesses.find(item => item.id === id);
    setValue('harness', id); setValue('harnessOptions', defaultsFor(next?.fields ?? [])); setRemoveNative(false); setPreview(undefined);
  };
  const submit = handleSubmit(async form => {
    try {
      if (capabilities.features.connections && form.connection === 'default') { setError('connection', { message: '请选择已保存的 Provider' }); return; }
      const result = initial ? await studioApi.updateAgent(initial.path, initial.format, document)
        : capabilities.features.agent_manifests ? await studioApi.saveAgentDocument(document)
        : await studioApi.saveAgent(`${form.id}.toml`, { id: form.id, harness: form.harness, api: 'responses', model: form.model,
          base_url: form.baseUrl || undefined, api_key_env: form.keyEnv || undefined,
          ...(form.harnessOptions.reasoning_effort && form.harnessOptions.reasoning_effort !== 'default' ? { reasoning_effort: form.harnessOptions.reasoning_effort } : {}) });
      if (intent.current === 'batch') {
        void onSaved?.('batch');
        toast.success('Agent 已保存，正在加入批次');
        void navigate({ to: '/batches/new', search: { addAgent: result.path } });
      } else { setSaved(result.path); toast.success(initial ? 'Agent 配置已更新' : 'Agent 配置已保存'); await onSaved?.('save'); }
    } catch (error) {
      if (error instanceof ApiError) {
        const fieldMap: Record<string, keyof Values> = {
          id: 'id', name: 'name', model: 'model', vendor: 'vendor', provider: 'connection', connection: 'connection', speed_tier: 'speedTier',
        };
        for (const issue of error.issues) {
          const target = fieldMap[issue.path[0] ?? ''];
          if (target) setError(target, { message: issue.message });
        }
      }
      toast.error('无法保存 Agent', { description: (error as Error).message });
    }
  });
  const renderHarnessField = (field: HarnessField) => <Field key={field.id} label={field.label} hint={field.required ? undefined : '可选'}>
    {field.kind === 'select' ? <Controller control={control} name={`harnessOptions.${field.id}`} render={({ field: controlled }) => <Select value={controlled.value} onValueChange={controlled.onChange}>
      {field.options?.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</Select>} />
      : <Input type={field.kind === 'number' ? 'number' : 'text'} placeholder={field.placeholder} {...register(`harnessOptions.${field.id}`)} />}
    {field.description && <p className="text-[11px] leading-5 text-muted-foreground">{field.description}</p>}
  </Field>;
  return <form onSubmit={submit} className="space-y-8">
    <section><SectionIndex index="01" title="身份与模型" description="Agent ID 标识具体配置；厂商仅用于筛选与比较，不改变 API 行为。" />
      <div className="grid gap-5 sm:grid-cols-2"><Field label="Agent ID" error={errors.id?.message}><Input placeholder="codex-gpt53-high" disabled={!!initial} {...register('id')} /></Field>
        <Field label="展示名称" hint="可选，不改变 Revision"><Input placeholder="GPT · High · Fast" {...register('name')} /></Field></div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2"><Field label="模型厂商" hint={capabilities.features.agent_vendor ? '研究元数据' : '等待后端契约'}><Controller control={control} name="vendor" render={({ field }) => <Select value={field.value} onValueChange={field.onChange} disabled={!capabilities.features.agent_vendor}>
          <SelectItem value="unspecified">{capabilities.features.agent_vendor ? '未指定' : '当前后端暂不支持'}</SelectItem>{vendors.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</Select>} /></Field><Field label="速度档位" hint="计入成绩披露与 Revision"><Controller control={control} name="speedTier" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectItem value="standard">Standard</SelectItem><SelectItem value="fast">Fast</SelectItem><SelectItem value="ultrafast">Ultrafast</SelectItem></Select>} /></Field></div>
      <div className="mt-5"><Field label="模型标识" hint="上游精确 ID" error={errors.model?.message}><Input className="font-mono text-xs" placeholder="model-id-or-snapshot" {...register('model')} /></Field></div>
    </section><Separator />
    <section><SectionIndex index="02" title="Provider" description="Provider 描述实际上游协议和凭据；模型厂商与 API 提供方可以不同。" />
      <Controller control={control} name="connection" render={({ field }) => <ConnectionField capabilities={capabilities} value={field.value} onChange={field.onChange} register={register} error={errors.connection?.message} />} />
    </section><Separator />
    <section><SectionIndex index="03" title="Harness" description="可配置项由适配器声明，原始覆盖与最终配置严格分离。" />
      <div className="mb-5"><Field label="Harness"><Controller control={control} name="harness" render={({ field }) => <Select value={field.value} onValueChange={changeHarness}>
        {capabilities.harnesses.map(item => <SelectItem key={item.id} value={item.id}>{item.label} · {item.version}</SelectItem>)}</Select>} /></Field></div>
      <SegmentedTabs
        id={`agent-harness-${initial?.path ?? 'new'}`}
        size="sm"
        value={harnessTab}
        onValueChange={setHarnessTab}
        items={[
          { value: 'guided', label: '参数', icon: Settings2 },
          { value: 'native', label: '原生覆盖', icon: FileCode2 },
          { value: 'preview', label: '最终预览', icon: Eye },
        ]}
      />
      <div className="pt-5">
        <AnimatedPanel panelKey={harnessTab}>
          {harnessTab === 'guided' && <>
            <div className="grid gap-5 sm:grid-cols-2">{harness.fields.map(renderHarnessField)}</div>
            {!harness.fields.length && <p className="text-xs text-muted-foreground">此 Harness 没有额外的结构化参数。</p>}
          </>}
          {harnessTab === 'native' && (capabilities.features.native_overrides && harness.supports_overrides ? <div className="space-y-3">
            {hasExternalNative && !values.nativeConfig.trim() && !removeNative && <div className="border-l-2 border-primary/35 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">已保留外部原生覆盖文件：<span className="font-mono">{sourceHarness?.native_config?.path}</span>{sourceHarness?.native_config?.sha256 ? <span className="ml-2 font-mono text-[10px]">sha256:{sourceHarness.native_config.sha256.slice(0, 12)}…</span> : null}</div>}
            <Field label={`${formatLabel(harness.native_format)} 参数覆盖`} hint="不能覆盖 runner 安全字段">
            <Textarea className="min-h-44" value={values.nativeConfig} onChange={event => { setValue('nativeConfig', event.target.value); setRemoveNative(false); setPreview(undefined); }} placeholder="# 输入 Harness 原生配置覆盖" /></Field>
            {hasExternalNative && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={removeNative} onChange={event => { setRemoveNative(event.target.checked); setPreview(undefined); }} />移除已绑定的外部原生覆盖文件</label>}
          </div> : <Note>当前后端尚未开放原生配置覆盖。新契约启用后，此处将接受 {formatLabel(harness.native_format)} patch，并由服务端校验。</Note>)}
          {harnessTab === 'preview' && (capabilities.features.native_overrides ? <div className="space-y-3"><Button type="button" variant="secondary" size="sm" onClick={async () => {
            try { setPreview(await studioApi.previewAgent(document, initial?.path)); } catch (error) { toast.error('预览失败', { description: (error as Error).message }); }
          }}><Braces className="size-3.5" />生成脱敏预览</Button>{preview && <pre className="max-h-96 overflow-auto border bg-[#141516] p-4 font-mono text-xs leading-6 text-[#e7e7e3]">{preview.content}</pre>}</div>
            : <Note>Effective Config 需要由 runner 合并并脱敏，前端不会伪造最终配置。</Note>)}
        </AnimatedPanel>
      </div>
    </section>
    <div className="flex flex-wrap gap-2"><Button type="submit" variant="secondary" loading={isSubmitting} onClick={() => { intent.current = 'save'; }}>{initial ? '保存修改' : '仅保存'}</Button>
      <Button type="submit" loading={isSubmitting} onClick={() => { intent.current = 'batch'; }}>{initial ? '保存并加入新批次' : '保存并加入批次'}</Button></div>{saved && <SavedPath path={saved} />}
  </form>;
}

export function AgentForm({ initial, onSaved }: { initial?: AgentItemResponse; onSaved?: (intent?: 'save' | 'batch') => Promise<void> | void }) {
  const capabilities = useCapabilities();
  if (capabilities.isLoading) return <div className="skeleton h-[560px] border bg-muted/30" />;
  if (capabilities.isError || !capabilities.data) return <Note>无法读取 Harness 能力描述：{(capabilities.error as Error)?.message ?? '未知错误'}</Note>;
  const source = initial?.document as AgentDocument | undefined;
  if (initial && source?.kind !== 'contestreplay.dev/agent') return <LegacyAgentReadOnly initial={initial} />;
  return <AgentManifestForm capabilities={capabilities.data} initial={initial} onSaved={onSaved} />;
}
