import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { Braces, Eye, FileCode2, KeyRound, RefreshCw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Note } from '@/components/ui/dialog';
import { SavedPath } from './saved-path';
import { formatLabel, useCapabilities, type ConfigFormat, type HarnessField, type StudioCapabilities } from './capabilities';

const schema = z.object({
  id: z.string().trim().min(1, '请输入 Agent ID').regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, 'ID 仅支持字母、数字、点、下划线与连字符'),
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
  const providers = useQuery({ queryKey: ['providers'], queryFn: studioApi.providers, enabled: capabilities.features.connections });
  if (capabilities.features.connections) return <div className="space-y-3"><Field label="Provider" hint="可复用接入配置" error={error}>
    <Select value={value} onValueChange={onChange}><SelectItem value="default">选择已保存的 Provider</SelectItem>{providers.data?.providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.label} · {provider.protocol}</SelectItem>)}</Select>
  </Field><div className="flex flex-col gap-3 border-l border-primary/25 pl-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-[11px] leading-5 text-muted-foreground">Provider 可以在前端安全创建和修改；秘密只写入，不会回显。</p><div className="flex shrink-0 gap-1"><Button type="button" variant="ghost" size="sm" asChild><Link to="/providers"><KeyRound className="size-3.5" />管理 Providers</Link></Button><Button type="button" variant="ghost" size="sm" onClick={() => void providers.refetch()}><RefreshCw className={providers.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button></div></div>
    {providers.data && !providers.data.providers.length && <p className="text-xs text-warning">尚未登记 Provider，请先创建。</p>}</div>;
  return <div className="space-y-5"><div className="grid gap-5 sm:grid-cols-[1fr_220px]"><Field label="API Base URL" hint="旧版连接字段"><Input className="font-mono text-xs" {...register('baseUrl')} /></Field>
    <Field label="凭据环境变量名"><Input className="font-mono text-xs" {...register('keyEnv')} /></Field></div>
    <p className="border-l border-primary/30 pl-3 text-[11px] leading-5 text-muted-foreground">当前 runner 使用宿主环境变量提供凭据。实现连接库契约后，这里会自动替换为可复用连接，不再要求理解变量名。</p></div>;
}

function AgentManifestForm({ capabilities }: { capabilities: StudioCapabilities }) {
  const [saved, setSaved] = useState<string>();
  const navigate = useNavigate();
  const intent = useRef<'save' | 'batch'>('save');
  const [preview, setPreview] = useState<{ content: string; format: ConfigFormat; revision?: string }>();
  const initialHarness = capabilities.harnesses[0]!;
  const { register, control, handleSubmit, watch, setValue, setError, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: {
    id: '', vendor: capabilities.features.agent_vendor ? 'openai' : 'unspecified',
    connection: 'default', harness: initialHarness.id, model: '',
    baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', nativeConfig: '', harnessOptions: defaultsFor(initialHarness?.fields ?? []),
  } });
  const harnessId = watch('harness');
  const harness = capabilities?.harnesses.find(item => item.id === harnessId) ?? initialHarness;
  const values = watch();
  const document = useMemo(() => capabilities ? ({
    kind: 'contestreplay.dev/agent', schema_version: 1, id: values.id, ...(capabilities.features.agent_vendor ? { vendor: values.vendor } : {}),
    model: values.model, ...(capabilities.features.connections ? { provider: values.connection } : {}),
    harness: { kind: values.harness, version: harness?.version, options: Object.fromEntries(Object.entries(values.harnessOptions).filter(([, value]) => value && value !== 'default')),
      ...(values.nativeConfig.trim() ? { native_config: { format: harness?.native_format, content: values.nativeConfig } } : {}) },
  }) : {}, [capabilities, values, harness]);
  if (!harness) return <Note>未找到所选 Harness 的能力描述。</Note>;
  const changeHarness = (id: string) => {
    const next = capabilities.harnesses.find(item => item.id === id);
    setValue('harness', id); setValue('harnessOptions', defaultsFor(next?.fields ?? [])); setPreview(undefined);
  };
  const submit = handleSubmit(async form => {
    try {
      if (capabilities.features.connections && form.connection === 'default') { setError('connection', { message: '请选择已保存的 Provider' }); return; }
      const result = capabilities.features.agent_manifests ? await studioApi.saveAgentDocument(document)
        : await studioApi.saveAgent(`${form.id}.toml`, { id: form.id, harness: form.harness, api: 'responses', model: form.model,
          base_url: form.baseUrl || undefined, api_key_env: form.keyEnv || undefined,
          ...(form.harnessOptions.reasoning_effort && form.harnessOptions.reasoning_effort !== 'default' ? { reasoning_effort: form.harnessOptions.reasoning_effort } : {}) });
      if (intent.current === 'batch') {
        sessionStorage.setItem('cr.batch.pending', JSON.stringify({ kind: 'agent', path: result.path }));
        toast.success('Agent 已保存，正在加入批次'); void navigate({ to: '/batches/new' });
      } else { setSaved(result.path); toast.success('Agent 配置已保存'); }
    } catch (error) { toast.error('无法保存 Agent', { description: (error as Error).message }); }
  });
  const renderHarnessField = (field: HarnessField) => <Field key={field.id} label={field.label} hint={field.required ? undefined : '可选'}>
    {field.kind === 'select' ? <Controller control={control} name={`harnessOptions.${field.id}`} render={({ field: controlled }) => <Select value={controlled.value} onValueChange={controlled.onChange}>
      {field.options?.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</Select>} />
      : <Input type={field.kind === 'number' ? 'number' : 'text'} placeholder={field.placeholder} {...register(`harnessOptions.${field.id}`)} />}
    {field.description && <p className="text-[11px] leading-5 text-muted-foreground">{field.description}</p>}
  </Field>;
  return <form onSubmit={submit} className="space-y-8">
    <section><SectionIndex index="01" title="身份与模型" description="Agent ID 标识具体配置；厂商仅用于筛选与比较，不改变 API 行为。" />
      <div className="grid gap-5 sm:grid-cols-2"><Field label="Agent ID" error={errors.id?.message}><Input placeholder="codex-gpt53-high" {...register('id')} /></Field>
        <Field label="模型厂商" hint={capabilities.features.agent_vendor ? '研究元数据' : '等待后端契约'}><Controller control={control} name="vendor" render={({ field }) => <Select value={field.value} onValueChange={field.onChange} disabled={!capabilities.features.agent_vendor}>
          {!capabilities.features.agent_vendor && <SelectItem value="unspecified">当前后端暂不支持</SelectItem>}{vendors.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</Select>} /></Field></div>
      <div className="mt-5"><Field label="模型标识" hint="上游精确 ID" error={errors.model?.message}><Input className="font-mono text-xs" placeholder="model-id-or-snapshot" {...register('model')} /></Field></div>
    </section><Separator />
    <section><SectionIndex index="02" title="Provider" description="Provider 描述实际上游协议和凭据；模型厂商与 API 提供方可以不同。" />
      <Controller control={control} name="connection" render={({ field }) => <ConnectionField capabilities={capabilities} value={field.value} onChange={field.onChange} register={register} error={errors.connection?.message} />} />
    </section><Separator />
    <section><SectionIndex index="03" title="Harness" description="可配置项由适配器声明，原始覆盖与最终配置严格分离。" />
      <div className="mb-5"><Field label="Harness"><Controller control={control} name="harness" render={({ field }) => <Select value={field.value} onValueChange={changeHarness}>
        {capabilities.harnesses.map(item => <SelectItem key={item.id} value={item.id}>{item.label} · {item.version}</SelectItem>)}</Select>} /></Field></div>
      <Tabs defaultValue="guided"><TabsList><TabsTrigger value="guided"><Settings2 className="size-3.5" />参数</TabsTrigger><TabsTrigger value="native"><FileCode2 className="size-3.5" />原生覆盖</TabsTrigger><TabsTrigger value="preview"><Eye className="size-3.5" />最终预览</TabsTrigger></TabsList>
        <div className="pt-5"><TabsContent value="guided" className="data-[state=active]:animate-panel-in"><div className="grid gap-5 sm:grid-cols-2">{harness.fields.map(renderHarnessField)}</div>
          {!harness.fields.length && <p className="text-xs text-muted-foreground">此 Harness 没有额外的结构化参数。</p>}
</TabsContent>
        <TabsContent value="native" className="data-[state=active]:animate-panel-in">{capabilities.features.native_overrides && harness.supports_overrides ? <Field label={`${formatLabel(harness.native_format)} 参数覆盖`} hint="不能覆盖 runner 安全字段">
          <Textarea className="min-h-44" value={values.nativeConfig} onChange={event => { setValue('nativeConfig', event.target.value); setPreview(undefined); }} placeholder="# 输入 Harness 原生配置覆盖" /></Field>
          : <Note>当前后端尚未开放原生配置覆盖。新契约启用后，此处将接受 {formatLabel(harness.native_format)} patch，并由服务端校验。</Note>}</TabsContent>
        <TabsContent value="preview" className="data-[state=active]:animate-panel-in">{capabilities.features.native_overrides ? <div className="space-y-3"><Button type="button" variant="secondary" size="sm" onClick={async () => {
          try { setPreview(await studioApi.previewAgent(document)); } catch (error) { toast.error('预览失败', { description: (error as Error).message }); }
        }}><Braces className="size-3.5" />生成脱敏预览</Button>{preview && <pre className="max-h-96 overflow-auto border bg-[#141516] p-4 font-mono text-xs leading-6 text-[#e7e7e3]">{preview.content}</pre>}</div>
          : <Note>Effective Config 需要由 runner 合并并脱敏，前端不会伪造最终配置。</Note>}</TabsContent></div>
      </Tabs>
    </section>
    <div className="flex flex-wrap gap-2"><Button type="submit" variant="secondary" loading={isSubmitting} onClick={() => { intent.current = 'save'; }}>仅保存</Button>
      <Button type="submit" loading={isSubmitting} onClick={() => { intent.current = 'batch'; }}>保存并加入批次</Button></div>{saved && <SavedPath path={saved} />}
  </form>;
}

export function AgentForm() {
  const capabilities = useCapabilities();
  if (capabilities.isLoading) return <div className="skeleton h-[560px] border bg-muted/30" />;
  if (capabilities.isError || !capabilities.data) return <Note>无法读取 Harness 能力描述：{(capabilities.error as Error)?.message ?? '未知错误'}</Note>;
  return <AgentManifestForm capabilities={capabilities.data} />;
}
