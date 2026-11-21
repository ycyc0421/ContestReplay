import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check, FileUp, Plus, Trash2, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { studioApi } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Note } from '@/components/ui/dialog';
import { SavedPath } from './saved-path';
import { useCapabilities, type StudioCapabilities } from './capabilities';

const schema = z.object({
  file: z.string().trim().min(1, '请输入保存路径'), id: z.string().trim().min(1, '请输入 Contest ID'),
  title: z.string(), sourceName: z.string().trim().min(1, '请输入来源名称'), sourceUrl: z.string(),
  redistribution: z.enum(['allowed', 'restricted', 'unknown']), pdf: z.string().trim().min(1, '请上传或填写主 PDF'),
  judge: z.string().min(1), answers: z.string(), cfId: z.string(), handle: z.string(), languages: z.string(),
  timeLimitMinutes: z.number().int().min(1).max(480), maxSubmissions: z.number().int().min(1).max(1000),
});
type Values = z.infer<typeof schema>;
type Material = { path: string; name: string; size: number; sha256: string; kind: 'entrypoint' | 'attachment' };
type ProblemDraft = { id: string; maxPoints: number; answers: string };
const steps = [['基本信息', '身份、来源与授权'], ['比赛材料', '上传或引用完整题面'], ['判题配置', '题目、答案与提交后端'], ['赛规确认', '预算与文件摘要']] as const;

function MaterialUpload({ contestId, onUploaded }: { contestId: string; onUploaded: (material: Material) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const upload = useMutation({ mutationFn: (file: File) => studioApi.uploadMaterial(file, contestId, 'entrypoint'),
    onSuccess: onUploaded, onError: (error: Error) => toast.error('题面上传失败', { description: error.message }) });
  const choose = (file?: File) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { toast.error('主题面必须是 PDF 文件'); return; }
    if (!contestId.trim()) { toast.error('请先填写 Contest ID'); return; }
    upload.mutate(file);
  };
  return <div role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') input.current?.click(); }}
    onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }}
    className={cn('flex min-h-48 cursor-pointer flex-col items-center justify-center border border-dashed bg-muted/15 px-6 text-center transition-colors hover:border-primary/50 hover:bg-muted/35', dragging && 'border-primary bg-accent')}>
    <input ref={input} type="file" accept="application/pdf,.pdf" className="hidden" onChange={event => choose(event.target.files?.[0])} />
    {upload.isPending ? <><div className="mb-4 size-7 animate-spin border-2 border-primary/20 border-t-primary" /><p className="text-sm font-medium">正在上传并校验题面…</p></>
      : <><UploadCloud className="mb-4 size-7 text-primary" strokeWidth={1.5} /><p className="text-sm font-medium">拖入完整题面 PDF，或点击选择</p><p className="mt-2 font-mono text-[10px] text-muted-foreground">PDF · 最大 40 MB · SHA-256 由服务端计算</p></>}
  </div>;
}
function ProblemEditor({ problems, setProblems }: { problems: ProblemDraft[]; setProblems: (problems: ProblemDraft[]) => void }) {
  const update = (index: number, patch: Partial<ProblemDraft>) => setProblems(problems.map((problem, i) => i === index ? { ...problem, ...patch } : problem));
  return <div className="space-y-3"><div className="hidden grid-cols-[120px_100px_1fr_32px] gap-3 font-mono text-[9px] uppercase tracking-wider text-muted-foreground sm:grid"><span>题号</span><span>分值</span><span>可接受答案 · 每行一个</span><span /></div>
    <AnimatePresence initial={false}>{problems.map((problem, index) => <motion.div layout key={index} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} className="grid gap-3 border-b pb-4 sm:grid-cols-[120px_100px_1fr_32px]">
      <Input aria-label={`题目 ${index + 1} 题号`} value={problem.id} onChange={event => update(index, { id: event.target.value })} />
      <Input aria-label={`题目 ${index + 1} 分值`} type="number" min="1" value={problem.maxPoints} onChange={event => update(index, { maxPoints: Number(event.target.value) })} />
      <Textarea aria-label={`题目 ${index + 1} 可接受答案`} className="min-h-20" value={problem.answers} onChange={event => update(index, { answers: event.target.value })} placeholder="3\nthree" />
      <Button type="button" variant="ghost" size="icon" aria-label={`删除题目 ${index + 1}`} disabled={problems.length === 1} onClick={() => setProblems(problems.filter((_, i) => i !== index))}><Trash2 className="size-4" /></Button>
    </motion.div>)}</AnimatePresence>
    <Button type="button" variant="secondary" size="sm" onClick={() => setProblems([...problems, { id: String(problems.length + 1), maxPoints: 1, answers: '' }])}><Plus className="size-3.5" />添加题目</Button>
    <p className="text-[11px] leading-5 text-muted-foreground">去除提交答案首尾空白后精确匹配，命中任一可接受答案即得分。保存时同步生成 Contest 题目表与 judge.json。</p></div>;
}

function ContestManifestForm({ capabilities }: { capabilities: StudioCapabilities }) {
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [saved, setSaved] = useState<string>();
  const navigate = useNavigate();
  const intent = useRef<'save' | 'batch'>('save');
  const [materialMode, setMaterialMode] = useState(capabilities.features.contest_upload ? 'upload' : 'path');
  const [uploaded, setUploaded] = useState<Material>();
  const [problems, setProblems] = useState<ProblemDraft[]>([{ id: '1', maxPoints: 1, answers: '' }]);
  const { register, control, handleSubmit, watch, setValue, getValues, trigger, setError, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: {
    file: 'contest.json', id: '', title: '', sourceName: 'Local', sourceUrl: '', redistribution: 'unknown', pdf: 'problems.pdf',
    judge: 'local', answers: 'judge.json', cfId: '', handle: '', languages: '{"cpp17":54}', timeLimitMinutes: 15, maxSubmissions: 100,
  } });
  const values = watch();
  const judgeLabel = capabilities.judge_backends.find(item => item.kind === values.judge)?.label ?? values.judge;
  const goTo = (next: number) => { setStep(next); setMaxStep(current => Math.max(current, next)); };
  const next = async () => {
    if (step === 0 && !await trigger(['id', 'file', 'sourceName'])) return;
    if (step === 1 && materialMode === 'upload' && (!uploaded || uploaded.path !== values.pdf)) { toast.error('请先上传题面 PDF'); return; }
    if (step === 1 && !await trigger('pdf')) return;
    if (step === 2) {
      if (values.judge === 'local' && !capabilities.features.judge_authoring && !values.answers.trim()) { setError('answers', { message: '请输入答案 JSON 路径' }); return; }
      if (values.judge === 'local' && capabilities.features.judge_authoring && problems.some(problem => !problem.id.trim() || !Number.isSafeInteger(problem.maxPoints) || problem.maxPoints < 1 || !problem.answers.trim())) {
        toast.error('请完整填写题号、分值和至少一个答案'); return;
      }
      if (values.judge === 'codeforces') {
        if (!Number.isSafeInteger(Number(values.cfId)) || Number(values.cfId) < 1) { setError('cfId', { message: '请输入有效赛事 ID' }); return; }
        if (!values.handle.trim()) { setError('handle', { message: '请输入专用账号名' }); return; }
        try { JSON.parse(values.languages); } catch { setError('languages', { message: '语言映射不是有效 JSON' }); return; }
      }
    }
    goTo(step + 1);
  };
  const submit = handleSubmit(async form => {
    try {
      const source = { name: form.sourceName, ...(form.sourceUrl.trim() ? { url: form.sourceUrl } : {}) };
      const materials = { entrypoint: { kind: 'pdf', path: form.pdf, redistribution: form.redistribution,
        ...(uploaded?.path === form.pdf ? { name: uploaded.name, size: uploaded.size, sha256: uploaded.sha256 } : {}) } };
      const rules = { time_limit_ms: form.timeLimitMinutes * 60_000, max_submissions: form.maxSubmissions };
      const cf = form.judge === 'codeforces' ? { contest_id: Number(form.cfId), handle: form.handle, languages: JSON.parse(form.languages) } : undefined;
      const result = cf ? capabilities.features.contest_authoring ? await studioApi.saveContestDocument(form.file, {
        kind: 'contestreplay.dev/contest', schema_version: 2, contest_id: form.id, data_version: 1, title: form.title || form.id,
        source, materials, rules, judge: { kind: 'codeforces', ...cf },
      }) : await studioApi.importCodeforces(form.file, { id: form.id, pdf: form.pdf, contest: cf.contest_id, handle: cf.handle, languages: cf.languages })
        : capabilities.features.contest_authoring ? await studioApi.saveContestDocument(form.file, {
          kind: 'contestreplay.dev/contest', schema_version: 2, contest_id: form.id, data_version: 1, title: form.title || form.id, source, materials, rules,
          problems: problems.map(problem => ({ id: problem.id, max_points: problem.maxPoints })),
          judge: { kind: 'local', problems: problems.map(problem => ({ id: problem.id, max_points: problem.maxPoints,
            accepted_answers: problem.answers.split(/\r?\n/).map(answer => answer.trim()).filter(Boolean) })) },
        }) : await studioApi.saveContest(form.file, { schema_version: 2, contest_id: form.id, data_version: 1,
          title: form.title || form.id, source, materials, rules, judge: { kind: 'local', answers: { path: form.answers } } });
      if (intent.current === 'batch') {
        sessionStorage.setItem('cr.batch.pending', JSON.stringify({ kind: 'contest', path: result.path }));
        toast.success('Contest 已保存，正在加入批次'); void navigate({ to: '/batches/new' });
      } else { setSaved(result.path); toast.success('Contest 配置已保存'); }
    } catch (error) { toast.error('无法保存 Contest', { description: (error as Error).message }); }
  });
  const changeMaterialMode = (mode: string) => {
    setMaterialMode(mode); setValue('pdf', mode === 'upload' ? uploaded?.path ?? '' : 'problems.pdf', { shouldValidate: true });
  };
  return <form onSubmit={event => {
    if (step === 3) void submit(event);
    else event.preventDefault();
  }}>
    <ol className="mb-7 grid grid-cols-4 border-y" aria-label="Contest 创建步骤">{steps.map(([title], index) => <li key={title}>
      <button type="button" disabled={index > maxStep} onClick={() => goTo(index)} className={cn('relative flex h-14 w-full items-center justify-center gap-2 border-r text-xs text-muted-foreground last:border-r-0 disabled:opacity-40', index === step && 'text-primary')}>
        {index === step && <motion.span layoutId="contest-form-step" className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
        <span className={cn('font-mono text-[9px]', index < step && 'text-foreground')}>{index < step ? <Check className="size-3" /> : `0${index + 1}`}</span><span className="hidden md:inline">{title}</span>
      </button></li>)}</ol>
    <motion.div layout="size" className="min-h-[390px]"><AnimatePresence mode="wait" initial={false}><motion.section key={step} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: .16 }}>
      {step === 0 && <div className="space-y-5"><div><h3 className="font-semibold">比赛档案</h3><p className="mt-1 text-xs text-muted-foreground">稳定 ID、来源与授权会写入清单，并用于后续数据版本管理。</p></div>
        <div className="grid gap-5 sm:grid-cols-2"><Field label="Contest ID" error={errors.id?.message}><Input placeholder="final-2024" {...register('id')} /></Field><Field label="赛事标题" hint="可选"><Input placeholder="默认使用 Contest ID" {...register('title')} /></Field></div>
        <div className="grid gap-5 sm:grid-cols-2"><Field label="来源名称" error={errors.sourceName?.message}><Input {...register('sourceName')} /></Field><Field label="来源 URL" hint="可选"><Input placeholder="https://…" {...register('sourceUrl')} /></Field></div>
        <div className="grid gap-5 sm:grid-cols-2"><Field label="材料再分发"><Controller control={control} name="redistribution" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectItem value="unknown">未知 / 未确认</SelectItem><SelectItem value="allowed">允许再分发</SelectItem><SelectItem value="restricted">限制再分发</SelectItem></Select>} /></Field>
          <Field label="清单保存为" error={errors.file?.message}><Input className="font-mono text-xs" {...register('file')} /></Field></div>
      </div>}
      {step === 1 && <div className="space-y-5"><div><h3 className="font-semibold">完整比赛材料</h3><p className="mt-1 text-xs text-muted-foreground">默认上传完整 PDF；已有受管理文件也可以直接引用。</p></div>
        <Tabs value={materialMode} onValueChange={changeMaterialMode}><TabsList><TabsTrigger value="upload" disabled={!capabilities.features.contest_upload}><FileUp className="size-3.5" />上传文件</TabsTrigger><TabsTrigger value="path">引用本机路径</TabsTrigger></TabsList></Tabs>
        {materialMode === 'upload' ? <><MaterialUpload contestId={getValues('id')} onUploaded={material => { setUploaded(material); setValue('pdf', material.path, { shouldValidate: true }); }} />
          <AnimatePresence>{uploaded && <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3 border border-primary/20 bg-primary/5 p-4"><Check className="size-4 text-primary" /><div className="min-w-0"><div className="truncate text-sm font-medium">{uploaded.name}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">{formatBytes(uploaded.size)} · {uploaded.sha256.slice(0, 16)}…</div></div></motion.div>}</AnimatePresence></>
          : <Field label="题面 PDF" hint="相对于清单" error={errors.pdf?.message}><Input className="font-mono text-xs" {...register('pdf')} /></Field>}
        {errors.pdf && <p role="alert" className="text-xs text-danger">{errors.pdf.message}</p>}
        {!capabilities.features.contest_upload && <Note>当前 runner 尚未提供上传接口，因此保留本机路径模式。实现材料上传契约后，上传入口会自动启用。</Note>}
      </div>}
      {step === 2 && <div className="space-y-5"><div><h3 className="font-semibold">判题方式</h3><p className="mt-1 text-xs text-muted-foreground">判题后端写入 Contest Manifest；只有本地答案模式会生成 judge.json。</p></div>
        <Field label="判题后端"><Controller control={control} name="judge" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}>{capabilities.judge_backends.filter(backend => backend.kind === 'local' || backend.kind === 'codeforces').map(backend => <SelectItem key={backend.kind} value={backend.kind}>{backend.label}</SelectItem>)}</Select>} /></Field>
        {values.judge === 'local' ? capabilities.features.judge_authoring ? <ProblemEditor problems={problems} setProblems={setProblems} />
          : <div className="space-y-4 border-l-2 border-primary/25 bg-muted/20 p-4"><Field label="答案 JSON" hint="相对于清单" error={errors.answers?.message}><Input className="font-mono text-xs" {...register('answers')} /></Field><p className="text-xs leading-5 text-muted-foreground">当前后端读取已有 judge.json。题目表编辑器将在判题制作契约启用后开放。</p></div>
          : <div className="space-y-5 border-l-2 border-primary/25 bg-muted/20 p-4"><div className="grid gap-5 sm:grid-cols-2"><Field label="Codeforces 赛事 ID" error={errors.cfId?.message}><Input type="number" min="1" {...register('cfId')} /></Field><Field label="专用账号名" error={errors.handle?.message}><Input {...register('handle')} /></Field></div>
            <Field label="语言映射 JSON" error={errors.languages?.message}><Input className="font-mono text-xs" {...register('languages')} /></Field><p className="text-xs leading-5 text-muted-foreground">仅用于有权限的历史题 Practice 提交，不生成 judge.json。</p></div>}
      </div>}
      {step === 3 && <div className="space-y-6"><div><h3 className="font-semibold">赛规与保存确认</h3><p className="mt-1 text-xs text-muted-foreground">这些预算直接约束比赛，不是界面显示偏好。</p></div>
        <div className="grid gap-5 sm:grid-cols-2"><Field label="比赛时限" hint="分钟"><Input type="number" min="1" max="480" {...register('timeLimitMinutes', { valueAsNumber: true })} /></Field><Field label="最大提交次数"><Input type="number" min="1" max="1000" {...register('maxSubmissions', { valueAsNumber: true })} /></Field></div>
        <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-3 border-y py-5 text-xs"><dt className="text-muted-foreground">Contest</dt><dd className="font-medium">{values.id || '—'} · data v1</dd><dt className="text-muted-foreground">Manifest</dt><dd className="break-all font-mono">{values.file}</dd><dt className="text-muted-foreground">题面</dt><dd className="break-all font-mono">{values.pdf || '—'}</dd><dt className="text-muted-foreground">判题</dt><dd>{judgeLabel}</dd><dt className="text-muted-foreground">赛规</dt><dd>{values.timeLimitMinutes} 分钟 · 最多 {values.maxSubmissions} 次提交</dd></dl>
        <p className="text-[11px] leading-5 text-muted-foreground">保存时将再次由服务端校验材料、题目、判题配置与摘要。前端不会把校验成功当作运行预检成功。</p>
      </div>}
    </motion.section></AnimatePresence></motion.div>
    <div className="mt-7 flex items-center justify-between border-t pt-5"><Button type="button" variant="ghost" disabled={step === 0} onClick={() => goTo(step - 1)}><ArrowLeft className="size-4" />上一步</Button>
      {step < 3 ? <Button key="continue" type="button" onClick={() => void next()}>继续<ArrowRight className="size-4" /></Button> : <div key="save" className="flex gap-2"><Button type="submit" variant="secondary" loading={isSubmitting} onClick={() => { intent.current = 'save'; }}>仅保存</Button><Button type="submit" loading={isSubmitting} onClick={() => { intent.current = 'batch'; }}>保存并加入批次</Button></div>}</div>
    {saved && <div className="mt-5"><SavedPath path={saved} /></div>}
  </form>;
}

export function ContestForm() {
  const capabilities = useCapabilities();
  if (capabilities.isLoading) return <div className="skeleton h-[560px] border bg-muted/30" />;
  if (capabilities.isError || !capabilities.data) return <Note>无法读取 Contest 能力描述：{(capabilities.error as Error)?.message ?? '未知错误'}</Note>;
  return <ContestManifestForm capabilities={capabilities.data} />;
}
