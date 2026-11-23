import { useEffect, useReducer, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ContestItemResponse } from '@studio-api';
import { z } from 'zod';
import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check, CloudDownload, FileUp, KeyRound, Plus, Trash2, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, studioApi } from '@/lib/api';
import { cn, formatBytes, formatDuration } from '@/lib/utils';
import { queryKeys } from '@/state/query-keys';
import {
  buildCfWeightSigFromDrafts,
  contestWizardReducer,
  mergePreviewProblemMap,
  type MaterialArtifact,
  type ProblemDraft,
} from '@/state/contest-wizard.machine';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Textarea } from '@/components/ui/fields';
import { Select, SelectItem } from '@/components/ui/select';
import { Note } from '@/components/ui/dialog';
import { AnimatedPanel, SPRING_INDICATOR } from '@/design-system/motion';
import { SegmentedTabs } from '@/design-system/segmented-tabs';
import { SavedPath } from './saved-path';
import { useCapabilities, type StudioCapabilities } from './capabilities';
import { computeCodeforcesPointsKnown } from './cf-points';

const schema = z.object({
  file: z.string().trim().min(1, '请输入保存路径'), id: z.string().trim().min(1, '请输入 Contest ID'), dataVersion: z.number().int().min(1),
  title: z.string(), sourceName: z.string().trim().min(1, '请输入来源名称'), sourceUrl: z.string(),
  protocolPreset: z.string(), scoringMode: z.string(),
  redistribution: z.enum(['allowed', 'restricted', 'unknown']), pdf: z.string().trim().min(1, '请上传或填写主 PDF'),
  judge: z.string().min(1), answers: z.string(), cfId: z.string(), handle: z.string(), languages: z.string(),
  accountId: z.string(), pool: z.string(), baseUrl: z.string(), domain: z.string(), gym: z.string(), problemMap: z.string(),
  timeLimitMs: z.number().int().min(1000).max(8 * 60 * 60_000), maxSubmissions: z.number().int().min(1).max(1000),
});
type Values = z.infer<typeof schema>;

function stringRecord(text: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
  } catch { return {}; }
}
function parsePlainRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function defaultLanguagesFor(kind: string, capabilities: StudioCapabilities): Record<string, string> {
  const backend = capabilities.judge_backends.find(item => item.kind === kind);
  const firstPreset = backend?.language_presets?.[0];
  if (firstPreset) return { [firstPreset.id]: firstPreset.remote_id };
  return kind === 'codeforces' ? { cpp17: '54' } : { cpp17: 'cpp17' };
}

const steps = [['基本信息', '身份、来源与授权'], ['比赛材料', '上传或引用完整题面'], ['判题配置', '题目、答案与提交后端'], ['赛规确认', '预算与文件摘要']] as const;

function MaterialUpload({ contestId, onUploaded }: { contestId: string; onUploaded: (material: MaterialArtifact) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const upload = useMutation({
    mutationFn: (file: File) => studioApi.uploadMaterial(file, contestId, 'entrypoint'),
    onSuccess: onUploaded,
    onError: (error: Error) => toast.error('题面上传失败', { description: error.message }),
  });
  const choose = (file?: File) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { toast.error('主题面必须是 PDF 文件'); return; }
    if (!contestId.trim()) { toast.error('请先填写 Contest ID'); return; }
    upload.mutate(file);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') input.current?.click(); }}
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }}
      className={cn('flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-[3px] border border-dashed bg-muted/15 px-6 text-center transition-colors hover:border-primary/50 hover:bg-muted/35', dragging && 'border-primary bg-accent')}
    >
      <input ref={input} type="file" accept="application/pdf,.pdf" className="hidden" onChange={event => choose(event.target.files?.[0])} />
      {upload.isPending
        ? <><div className="mb-4 size-7 animate-spin border-2 border-primary/20 border-t-primary" /><p className="text-sm font-medium">正在上传并校验题面…</p></>
        : <><UploadCloud className="mb-4 size-7 text-primary" strokeWidth={1.5} /><p className="text-sm font-medium">拖入完整题面 PDF，或点击选择</p><p className="mt-2 font-mono text-[10px] text-muted-foreground">PDF · 最大 40 MB · SHA-256 由服务端计算</p></>}
    </div>
  );
}

function ProblemEditor({ problems, setProblems }: { problems: ProblemDraft[]; setProblems: (problems: ProblemDraft[]) => void }) {
  const update = (index: number, patch: Partial<ProblemDraft>) => setProblems(problems.map((problem, i) => i === index ? { ...problem, ...patch } : problem));
  return (
    <div className="space-y-3">
      <div className="hidden grid-cols-[120px_100px_1fr_32px] gap-3 text-xs font-medium text-muted-foreground sm:grid">
        <span>题号</span><span>分值</span><span>可接受答案（每行一个）</span><span />
      </div>
      {problems.map((problem, index) => (
        <div key={index} className="grid gap-3 border-b pb-4 sm:grid-cols-[120px_100px_1fr_32px]">
          <Input aria-label={`题目 ${index + 1} 题号`} value={problem.id} onChange={event => update(index, { id: event.target.value })} />
          <Input aria-label={`题目 ${index + 1} 分值`} type="number" min="1" value={problem.maxPoints} onChange={event => update(index, { maxPoints: Number(event.target.value) })} />
          <Textarea aria-label={`题目 ${index + 1} 可接受答案`} className="min-h-20" value={problem.answers} onChange={event => update(index, { answers: event.target.value })} placeholder="3\nthree" />
          <Button type="button" variant="ghost" size="icon" aria-label={`删除题目 ${index + 1}`} disabled={problems.length === 1} onClick={() => setProblems(problems.filter((_, i) => i !== index))}><Trash2 className="size-4" /></Button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => setProblems([...problems, { id: String(problems.length + 1), maxPoints: 1, answers: '' }])}><Plus className="size-3.5" />添加题目</Button>
      <p className="text-[11px] leading-5 text-muted-foreground">去除提交答案首尾空白后精确匹配，命中任一可接受答案即得分。保存时同步生成 Contest 题目表与私有答案文件。</p>
    </div>
  );
}

type ArtifactDocument = { path?: string; redistribution?: 'allowed' | 'restricted' | 'unknown'; name?: string; size?: number; sha256?: string };
type JudgeDocument = {
  kind?: string; path?: string; sha256?: string; redistribution?: 'allowed' | 'restricted' | 'unknown';
  answers?: { path?: string; sha256?: string; redistribution?: 'allowed' | 'restricted' | 'unknown' };
  contest_id?: number | string; handle?: string; account_id?: string; pool?: string; base_url?: string; domain?: string; gym?: boolean;
  languages?: Record<string, string | number>; problem_map?: Record<string, string>; points_known?: boolean; settlement_ms?: number; live_contest?: boolean;
};
type ContestDocument = {
  contest_id?: string; data_version?: number; title?: string; source?: { name?: string; url?: string };
  statement?: ArtifactDocument;
  materials?: { entrypoint?: ArtifactDocument; attachments?: unknown[] };
  rules?: { time_limit_ms?: number; max_submissions?: number; protocol_preset?: string; scoring_mode?: string };
  problems?: { id: string; max_points: number }[];
  judge?: JudgeDocument;
};
type LocalJudge = { problems?: { id: string; max_points?: number; accepted_answers?: string[] }[] };

function RemoteProblemEditor({ problems, setProblems }: { problems: ProblemDraft[]; setProblems: (problems: ProblemDraft[]) => void }) {
  const update = (index: number, patch: Partial<ProblemDraft>) => setProblems(problems.map((problem, current) => current === index ? { ...problem, ...patch } : problem));
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium">本地题目表</div>
        <p className="mt-1 text-[11px] leading-5 text-muted-foreground">这里定义 PDF 中的稳定题号与满分；下方的 problem_map 再把这些本地题号映射到远端。拉取预览只会生成可编辑草稿。</p>
      </div>
      {problems.map((problem, index) => (
        <div key={index} className="grid grid-cols-[1fr_100px_32px] gap-3 border-b pb-3">
          <Input aria-label={`远程题目 ${index + 1} 题号`} value={problem.id} onChange={event => update(index, { id: event.target.value })} />
          <Input aria-label={`远程题目 ${index + 1} 分值`} type="number" min="1" value={problem.maxPoints} onChange={event => update(index, { maxPoints: Number(event.target.value) })} />
          <Button type="button" variant="ghost" size="icon" aria-label={`删除远程题目 ${index + 1}`} disabled={problems.length === 1} onClick={() => setProblems(problems.filter((_, current) => current !== index))}><Trash2 className="size-4" /></Button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => setProblems([...problems, { id: String(problems.length + 1), maxPoints: 100, answers: '' }])}><Plus className="size-3.5" />添加本地题目</Button>
    </div>
  );
}

function ContestManifestForm({ capabilities, initial, onSaved }: { capabilities: StudioCapabilities; initial?: ContestItemResponse; onSaved?: (intent?: 'save' | 'batch') => Promise<void> | void }) {
  const [saved, setSaved] = useState<string>();
  const navigate = useNavigate();
  const intent = useRef<'save' | 'batch'>('save');
  const source = initial?.document as ContestDocument | undefined;
  const sourceEntrypoint = source?.materials?.entrypoint ?? source?.statement;
  const rawJudge = source?.judge;
  const sourceJudge: JudgeDocument | undefined = rawJudge?.kind
    ? rawJudge
    : rawJudge?.path
      ? { kind: 'local', answers: { path: rawJudge.path, ...(rawJudge.sha256 ? { sha256: rawJudge.sha256 } : {}), ...(rawJudge.redistribution ? { redistribution: rawJudge.redistribution } : {}) } }
      : undefined;
  const localJudge = initial?.judge as LocalJudge | undefined;
  const initialTimeLimitMs = source?.rules?.time_limit_ms ?? 900000;
  const [timeLimitText, setTimeLimitText] = useState(() => String(Number((initialTimeLimitMs / 60000).toFixed(4))));

  const initialProblemDrafts: ProblemDraft[] = source?.problems?.length
    ? source.problems.map(problem => ({
        id: problem.id,
        maxPoints: problem.max_points,
        answers: (localJudge?.problems?.find(item => item.id === problem.id)?.accepted_answers ?? []).join('\n'),
      }))
    : localJudge?.problems?.length
      ? localJudge.problems.map(problem => ({ id: problem.id, maxPoints: problem.max_points ?? 1, answers: (problem.accepted_answers ?? []).join('\n') }))
      : [{ id: '1', maxPoints: 1, answers: '' }];

  const initialJudgeKind = sourceJudge?.kind ?? 'local';
  const [wizard, dispatch] = useReducer(contestWizardReducer, {
    step: 0,
    maxStep: 0,
    materialMode: initial ? 'path' : capabilities.features.contest_upload ? 'upload' : 'path',
    uploaded: sourceEntrypoint?.name && sourceEntrypoint.path && sourceEntrypoint.size && sourceEntrypoint.sha256
      ? { path: sourceEntrypoint.path, name: sourceEntrypoint.name, size: sourceEntrypoint.size, sha256: sourceEntrypoint.sha256, kind: 'entrypoint' }
      : undefined,
    problems: initialProblemDrafts,
    remotePreview: undefined,
    confirmedWeightsSig: undefined,
    cfNoticeSticky: initialJudgeKind === 'codeforces' && sourceJudge?.points_known === false,
  });

  const { register, control, handleSubmit, watch, setValue, getValues, trigger, setError, clearErrors, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      file: initial?.path ?? 'contest.json', id: source?.contest_id ?? '', dataVersion: source?.data_version ?? 1,
      title: source?.title ?? '', sourceName: source?.source?.name ?? 'Local', sourceUrl: source?.source?.url ?? '',
      protocolPreset: source?.rules?.protocol_preset ?? 'auto', scoringMode: source?.rules?.scoring_mode ?? 'auto',
      redistribution: sourceEntrypoint?.redistribution ?? 'unknown', pdf: sourceEntrypoint?.path ?? 'problems.pdf',
      judge: initialJudgeKind, answers: sourceJudge?.answers?.path ?? 'judge.json', cfId: sourceJudge?.contest_id?.toString() ?? '',
      handle: sourceJudge?.handle ?? '', languages: JSON.stringify(sourceJudge?.languages ?? defaultLanguagesFor(initialJudgeKind, capabilities)),
      accountId: sourceJudge?.account_id ?? '', pool: sourceJudge?.pool ?? '', baseUrl: sourceJudge?.base_url ?? '', domain: sourceJudge?.domain ?? '',
      gym: sourceJudge?.gym ? 'gym' : 'contest', problemMap: JSON.stringify(sourceJudge?.problem_map ?? {}, null, 2),
      timeLimitMs: initialTimeLimitMs, maxSubmissions: source?.rules?.max_submissions ?? 100,
    },
  });

  const values = watch();
  const judgeLabel = capabilities.judge_backends.find(item => item.kind === values.judge)?.label ?? values.judge;
  const judgeBackend = capabilities.judge_backends.find(item => item.kind === values.judge);
  const accounts = useQuery({ queryKey: queryKeys.ojAccounts, queryFn: studioApi.ojAccounts, enabled: values.judge !== 'local' });

  const previewGenRef = useRef(0);
  const currentUpstreamKey = JSON.stringify([
    values.judge,
    values.cfId.trim(),
    values.gym,
    values.baseUrl.trim(),
    values.domain.trim(),
    values.accountId,
    values.pdf.trim(),
    values.file.trim(),
    values.id.trim(),
  ]);
  const latestUpstreamKeyRef = useRef(currentUpstreamKey);
  latestUpstreamKeyRef.current = currentUpstreamKey;

  const currentCfWeightSig = values.judge === 'codeforces'
    ? buildCfWeightSigFromDrafts(values.cfId, values.gym === 'gym', wizard.problems, parsePlainRecord(values.problemMap) ?? {}, values.baseUrl)
    : undefined;

  useEffect(() => {
    dispatch({ type: 'SYNC_CF_SIGNATURE', currentCfWeightSig });
  }, [currentCfWeightSig]);

  const effectiveCfPointsKnown = values.judge === 'codeforces'
    ? computeCodeforcesPointsKnown({
        cfId: values.cfId,
        gym: values.gym === 'gym',
        baseUrl: values.baseUrl,
        problems: wizard.problems.map(p => ({ id: p.id.trim(), max_points: p.maxPoints })),
        problemMap: parsePlainRecord(values.problemMap) ?? {},
        preview: wizard.remotePreview,
        previewBaseUrl: wizard.remotePreviewBaseUrl,
        confirmedSignature: wizard.confirmedWeightsSig,
        isEdit: Boolean(initial),
        sourceJudge,
        sourceProblems: source?.problems,
      })
    : undefined;

  const showCfPointsNotice = values.judge === 'codeforces' && (
    effectiveCfPointsKnown === false || wizard.cfNoticeSticky || Boolean(wizard.confirmedWeightsSig)
  );

  const setProblems = (nextProblems: ProblemDraft[]) => {
    const nextSig = values.judge === 'codeforces'
      ? buildCfWeightSigFromDrafts(values.cfId, values.gym === 'gym', nextProblems, parsePlainRecord(values.problemMap) ?? {}, values.baseUrl)
      : undefined;
    dispatch({ type: 'SET_PROBLEMS', problems: nextProblems, nextCfWeightSig: nextSig });
  };

  const previewContest = useMutation({
    mutationFn: async () => {
      const gen = ++previewGenRef.current;
      const upstreamKey = latestUpstreamKeyRef.current;
      const reqJudge = getValues('judge');
      const reqCfId = getValues('cfId');
      const reqGym = getValues('gym') === 'gym';
      const reqBaseUrl = getValues('baseUrl').trim();
      try {
        const result = await studioApi.previewContest({
          platform: reqJudge as 'codeforces' | 'qoj' | 'vjudge' | 'hydro',
          contest_id: reqJudge === 'codeforces' ? Number(reqCfId) : reqCfId,
          ...(reqJudge === 'codeforces' && reqGym ? { gym: true } : {}),
          ...(reqBaseUrl ? { base_url: reqBaseUrl } : {}),
          ...(getValues('domain').trim() ? { domain: getValues('domain').trim() } : {}),
          ...(getValues('accountId') ? { account_id: getValues('accountId') } : {}),
          ...(getValues('pdf').trim() ? { pdf_path: getValues('pdf').trim() } : {}),
          ...(getValues('file').trim() ? { manifest_path: getValues('file').trim() } : {}),
          ...(getValues('id').trim() ? { manifest_contest_id: getValues('id').trim() } : {}),
        });
        return { gen, upstreamKey, ok: true as const, reqJudge, reqCfId, reqGym, reqBaseUrl, result };
      } catch (err) {
        return { gen, upstreamKey, ok: false as const, error: err instanceof Error ? err : new Error(String(err)) };
      }
    },
    onSuccess: payload => {
      // Discard stale preview responses AND stale preview errors if user changed any request input while in flight
      if (previewGenRef.current !== payload.gen || latestUpstreamKeyRef.current !== payload.upstreamKey) return;
      if (!payload.ok) {
        toast.error('无法拉取赛事信息', { description: payload.error.message });
        return;
      }
      const { reqJudge, reqCfId, reqGym, reqBaseUrl, result } = payload;
      if (!getValues('title').trim()) setValue('title', result.preview.title);
      if (result.language_presets.length) {
        setValue('languages', JSON.stringify(Object.fromEntries(result.language_presets.map(language => [language.id, language.remote_id]))));
      }
      const existingProblemMap = parsePlainRecord(getValues('problemMap')) ?? {};
      const mergedMap = mergePreviewProblemMap(existingProblemMap, result.problem_map_suggestion?.problem_map);
      if (result.problem_map_suggestion && Object.keys(mergedMap).length) {
        setValue('problemMap', JSON.stringify(mergedMap, null, 2));
      }
      dispatch({
        type: 'APPLY_REMOTE_PREVIEW',
        judge: reqJudge,
        cfId: reqCfId,
        gym: reqGym,
        baseUrl: reqBaseUrl || undefined,
        existingProblemMap,
        result,
        isEdit: Boolean(initial),
        initialProblemDrafts,
        sourceJudge,
        sourceProblems: source?.problems,
      });
      toast.success('赛事信息已载入', { description: `${result.preview.problems.length} 道题 · ${result.preview.status}` });
    },
  });

  const goTo = (nextStep: number) => dispatch({ type: 'GO_TO_STEP', step: nextStep });

  const next = async () => {
    if (wizard.step === 0 && !await trigger(['id', 'file', 'sourceName', 'dataVersion'])) return;
    if (wizard.step === 1 && wizard.materialMode === 'upload' && (!wizard.uploaded || wizard.uploaded.path !== values.pdf)) {
      toast.error('请先上传题面 PDF'); return;
    }
    if (wizard.step === 1 && !await trigger('pdf')) return;
    if (wizard.step === 2) {
      if (values.judge === 'local' && !capabilities.features.judge_authoring && !values.answers.trim()) {
        setError('answers', { message: '请输入答案 JSON 路径' }); return;
      }
      if (values.judge === 'local' && capabilities.features.judge_authoring) {
        const trimmedIds = wizard.problems.map(problem => problem.id.trim());
        if (!wizard.problems.length || wizard.problems.some(problem => !problem.id.trim() || !Number.isSafeInteger(problem.maxPoints) || problem.maxPoints < 1 || !problem.answers.trim()) || new Set(trimmedIds).size !== trimmedIds.length) {
          toast.error('请完整填写不重复的题号、正整数分值和至少一个答案'); return;
        }
      }
      if (values.judge !== 'local') {
        if (values.judge === 'codeforces' && (!Number.isSafeInteger(Number(values.cfId)) || Number(values.cfId) < 1)) { setError('cfId', { message: '请输入有效赛事 ID' }); return; }
        if (values.judge === 'codeforces' && !values.handle.trim() && !values.accountId && !values.pool.trim()) { setError('handle', { message: '请选择 OJ 账号、填写账号池或专用用户名' }); return; }
        if (values.judge === 'hydro' && !values.baseUrl.trim()) { setError('baseUrl', { message: 'Hydro 判题必须填写 Base URL' }); return; }
        if (values.accountId && values.pool.trim()) { setError('pool', { message: '账号与账号池只能二选一' }); return; }
        const trimmedIds = wizard.problems.map(problem => problem.id.trim());
        if (!wizard.problems.length || wizard.problems.some(problem => !problem.id.trim() || !Number.isSafeInteger(problem.maxPoints) || problem.maxPoints < 1) || new Set(trimmedIds).size !== trimmedIds.length) {
          toast.error('请完整填写不重复的本地题号与正整数满分'); return;
        }
        const parsedLanguages = parsePlainRecord(values.languages);
        if (!parsedLanguages || !Object.keys(parsedLanguages).length) { setError('languages', { message: '请提供至少一项有效的语言映射 JSON 对象' }); return; }
        const parsedProblemMap = parsePlainRecord(values.problemMap);
        if (!parsedProblemMap) { setError('problemMap', { message: '题号映射不是有效 JSON 对象' }); return; }
        const idSet = new Set(trimmedIds);
        if (Object.keys(parsedProblemMap).some(key => !idSet.has(key))) { setError('problemMap', { message: '题号映射包含不在本地题目表中的题号' }); return; }
      }
    }
    goTo(wizard.step + 1);
  };

  const submit = handleSubmit(async form => {
    try {
      const sourceInfo = { name: form.sourceName, ...(form.sourceUrl.trim() ? { url: form.sourceUrl } : {}) };
      const materials = {
        entrypoint: {
          ...(sourceEntrypoint?.path === form.pdf ? sourceEntrypoint : {}),
          kind: 'pdf', path: form.pdf, redistribution: form.redistribution,
          ...(wizard.uploaded?.path === form.pdf ? { name: wizard.uploaded.name, size: wizard.uploaded.size, sha256: wizard.uploaded.sha256 } : {}),
        },
        ...(initial ? { attachments: source?.materials?.attachments ?? [] } : {}),
      };
      const rules = {
        time_limit_ms: form.timeLimitMs, max_submissions: form.maxSubmissions,
        ...(form.protocolPreset !== 'auto' ? { protocol_preset: form.protocolPreset } : {}),
        ...(form.scoringMode !== 'auto' ? { scoring_mode: form.scoringMode } : {}),
      };
      const normalizedLanguages = form.judge !== 'local'
        ? Object.fromEntries(Object.entries(parsePlainRecord(form.languages) ?? {}).map(([key, value]) => [key, form.judge === 'codeforces' ? value : String(value)]))
        : undefined;
      const parsedProblemMap = form.judge !== 'local' ? (parsePlainRecord(form.problemMap) ?? {}) : undefined;
      const includeProblemMap = Boolean(parsedProblemMap && (Object.keys(parsedProblemMap).length > 0 || sourceJudge?.problem_map !== undefined));
      const submittedCfPointsKnown = form.judge === 'codeforces'
        ? computeCodeforcesPointsKnown({
            cfId: form.cfId,
            gym: form.gym === 'gym',
            baseUrl: form.baseUrl,
            problems: wizard.problems.map(p => ({ id: p.id.trim(), max_points: p.maxPoints })),
            problemMap: parsedProblemMap ?? {},
            preview: wizard.remotePreview,
            previewBaseUrl: wizard.remotePreviewBaseUrl,
            confirmedSignature: wizard.confirmedWeightsSig,
            isEdit: Boolean(initial),
            sourceJudge,
            sourceProblems: source?.problems,
          })
        : undefined;

      const remote = form.judge !== 'local' ? {
        kind: form.judge, ...(form.cfId.trim() ? { contest_id: form.judge === 'codeforces' ? Number(form.cfId) : form.cfId.trim() } : {}),
        ...(form.handle.trim() ? { handle: form.handle.trim() } : {}), ...(form.accountId ? { account_id: form.accountId } : {}),
        ...(form.pool.trim() ? { pool: form.pool.trim() } : {}), ...(form.baseUrl.trim() ? { base_url: form.baseUrl.trim() } : {}),
        ...(form.judge === 'hydro' && form.domain.trim() ? { domain: form.domain.trim() } : {}),
        ...(form.judge === 'codeforces' && form.gym === 'gym' ? { gym: true } : {}),
        ...(form.judge === 'codeforces' && submittedCfPointsKnown !== undefined ? { points_known: submittedCfPointsKnown } : {}),
        ...(sourceJudge?.settlement_ms !== undefined ? { settlement_ms: sourceJudge.settlement_ms } : {}),
        ...(form.judge === 'hydro' && sourceJudge?.live_contest !== undefined ? { live_contest: sourceJudge.live_contest } : {}),
        languages: normalizedLanguages,
        ...(includeProblemMap ? { problem_map: parsedProblemMap } : {}),
      } : undefined;

      const explicitProblems = wizard.problems.map(problem => ({ id: problem.id.trim(), max_points: problem.maxPoints }));
      const document = remote ? {
        kind: 'contestreplay.dev/contest', schema_version: 2, contest_id: form.id, data_version: form.dataVersion, title: form.title || form.id,
        source: sourceInfo, materials, rules, problems: explicitProblems, judge: remote,
      } : (() => {
        const currentProblems = wizard.problems.map(problem => ({
          id: problem.id.trim(), max_points: problem.maxPoints,
          accepted_answers: problem.answers.split(/\r?\n/).map(answer => answer.trim()).filter(Boolean),
        }));
        const originalProblems = initialProblemDrafts.map(problem => ({
          id: problem.id.trim(), max_points: problem.maxPoints,
          accepted_answers: problem.answers.split(/\r?\n/).map(answer => answer.trim()).filter(Boolean),
        }));
        const unchanged = initial && sourceJudge?.kind === 'local' && JSON.stringify(currentProblems) === JSON.stringify(originalProblems);
        return {
          kind: 'contestreplay.dev/contest', schema_version: 2, contest_id: form.id, data_version: form.dataVersion, title: form.title || form.id, source: sourceInfo, materials, rules,
          problems: unchanged && source?.problems ? source.problems : explicitProblems,
          judge: unchanged ? sourceJudge : { kind: 'local', problems: currentProblems },
        };
      })();

      const result = initial ? await studioApi.updateContest(initial.path, document)
        : remote ? capabilities.features.contest_authoring ? await studioApi.saveContestDocument(form.file, document)
          : await studioApi.importCodeforces(form.file, { id: form.id, pdf: form.pdf, contest: Number(form.cfId), handle: form.handle, languages: JSON.parse(form.languages) })
          : capabilities.features.contest_authoring ? await studioApi.saveContestDocument(form.file, document)
            : await studioApi.saveContest(form.file, {
                schema_version: 2, contest_id: form.id, data_version: form.dataVersion,
                title: form.title || form.id, source: sourceInfo, materials, rules, judge: { kind: 'local', answers: { path: form.answers } },
              });
      if (intent.current === 'batch') {
        void onSaved?.('batch');
        toast.success('Contest 已保存，正在加入批次');
        void navigate({ to: '/batches/new', search: { addContest: result.path } });
      } else {
        setSaved(result.path);
        toast.success(initial ? 'Contest 配置已更新' : 'Contest 配置已保存');
        await onSaved?.('save');
      }
    } catch (error) {
      if (error instanceof ApiError) {
        let targetStep: number | undefined;
        const markStep = (step: number) => { targetStep = targetStep === undefined ? step : Math.min(targetStep, step); };
        for (const issue of error.issues) {
          const joined = issue.path.join('.');
          if (joined === 'document.judge.contest_id' || joined === 'judge.contest_id') {
            setError('cfId', { message: issue.message }); markStep(2);
          } else if (joined === 'document.contest_id' || joined === 'contest_id') {
            setError('id', { message: issue.message }); markStep(0);
          } else if (joined === 'document.title' || joined === 'title') {
            setError('title', { message: issue.message }); markStep(0);
          } else if (joined === 'document.data_version' || joined === 'data_version') {
            setError('dataVersion', { message: issue.message }); markStep(0);
          } else if (joined === 'file' || joined === 'path') {
            setError('file', { message: issue.message }); markStep(0);
          } else if (joined.includes('materials') || joined.includes('entrypoint')) {
            setError('pdf', { message: issue.message }); markStep(1);
          } else if (joined.includes('base_url')) {
            setError('baseUrl', { message: issue.message }); markStep(2);
          } else if (joined.includes('languages')) {
            setError('languages', { message: issue.message }); markStep(2);
          } else if (joined.includes('problem_map')) {
            setError('problemMap', { message: issue.message }); markStep(2);
          } else if (joined.includes('account_id')) {
            setError('accountId', { message: issue.message }); markStep(2);
          } else if (joined.includes('handle')) {
            setError('handle', { message: issue.message }); markStep(2);
          } else if (joined.includes('judge.answers')) {
            setError('answers', { message: issue.message }); markStep(2);
          } else if (joined.includes('time_limit_ms')) {
            setError('timeLimitMs', { message: issue.message }); markStep(3);
          } else if (joined.includes('max_submissions')) {
            setError('maxSubmissions', { message: issue.message }); markStep(3);
          }
        }
        if (targetStep !== undefined && targetStep !== wizard.step) {
          goTo(targetStep);
        }
      }
      toast.error('无法保存 Contest', { description: (error as Error).message });
    }
  }, fieldErrors => {
    const stepFields: [number, (keyof Values)[]][] = [
      [0, ['id', 'title', 'dataVersion', 'sourceName', 'sourceUrl', 'file']],
      [1, ['pdf']],
      [2, ['judge', 'answers', 'cfId', 'accountId', 'handle', 'pool', 'baseUrl', 'domain', 'languages', 'problemMap']],
      [3, ['timeLimitMs', 'maxSubmissions']],
    ];
    for (const [stepIdx, fields] of stepFields) {
      if (fields.some(f => Boolean(fieldErrors[f]))) {
        if (stepIdx !== wizard.step) goTo(stepIdx);
        break;
      }
    }
  });

  const changeMaterialMode = (mode: 'upload' | 'path') => {
    dispatch({ type: 'SET_MATERIAL_MODE', mode });
    setValue('pdf', mode === 'upload' ? wizard.uploaded?.path ?? '' : 'problems.pdf', { shouldValidate: true });
  };

  return (
    <form onSubmit={event => { if (wizard.step === 3) void submit(event); else event.preventDefault(); }}>
      <ol className="mb-7 grid grid-cols-4 border-y" aria-label="Contest 创建步骤">
        {steps.map(([title], index) => (
          <li key={title}>
            <button
              type="button"
              disabled={index > wizard.maxStep}
              onClick={() => goTo(index)}
              className={cn('relative flex h-13 w-full items-center justify-center gap-2 border-r text-xs text-muted-foreground last:border-r-0 disabled:opacity-40', index === wizard.step && 'text-foreground font-medium')}
            >
              {index === wizard.step && <motion.span layoutId={`contest-step-${initial?.path ?? 'new'}`} transition={SPRING_INDICATOR} className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
              <span className={cn('font-mono text-[10px]', index < wizard.step && 'text-primary')}>{index < wizard.step ? <Check className="size-3.5" /> : `0${index + 1}`}</span>
              <span className="hidden sm:inline">{title}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="min-h-[380px]">
        <AnimatedPanel panelKey={wizard.step}>
          {wizard.step === 0 && (
            <div className="space-y-5">
              <div><h3 className="font-semibold">比赛档案</h3><p className="mt-1 text-xs text-muted-foreground">稳定 ID、来源与授权会写入清单，并用于后续数据版本管理。</p></div>
              <div className="grid gap-5 sm:grid-cols-3">
                <Field label="Contest ID" error={errors.id?.message}><Input placeholder="final-2024" disabled={!!initial} {...register('id')} /></Field>
                <Field label="赛事标题" hint="可选" error={errors.title?.message}><Input placeholder="默认使用 Contest ID" {...register('title')} /></Field>
                <Field label="数据版本" hint="内容变化时提升" error={errors.dataVersion?.message}><Input type="number" min="1" {...register('dataVersion', { valueAsNumber: true })} /></Field>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="来源名称" error={errors.sourceName?.message}><Input {...register('sourceName')} /></Field>
                <Field label="来源 URL" hint="可选"><Input placeholder="https://…" {...register('sourceUrl')} /></Field>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="材料再分发"><Controller control={control} name="redistribution" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectItem value="unknown">未知 / 未确认</SelectItem><SelectItem value="allowed">允许再分发</SelectItem><SelectItem value="restricted">限制再分发</SelectItem></Select>} /></Field>
                <Field label="清单保存为" error={errors.file?.message}><Input className="font-mono text-xs" disabled={!!initial} {...register('file')} /></Field>
              </div>
            </div>
          )}

          {wizard.step === 1 && (
            <div className="space-y-5">
              <div><h3 className="font-semibold">完整比赛材料</h3><p className="mt-1 text-xs text-muted-foreground">默认上传完整 PDF；已有受管理文件也可以直接引用。</p></div>
              <SegmentedTabs
                id={`contest-mat-${initial?.path ?? 'new'}`}
                panelIdPrefix={`contest-mat-panel-${initial?.path ?? 'new'}`}
                size="sm"
                value={wizard.materialMode}
                onValueChange={changeMaterialMode}
                items={[
                  { value: 'upload', label: '上传文件', icon: FileUp, disabled: !capabilities.features.contest_upload },
                  { value: 'path', label: '引用本机路径' },
                ]}
              />
              <div
                id={`contest-mat-panel-${initial?.path ?? 'new'}-${wizard.materialMode}`}
                role="tabpanel"
                aria-labelledby={`contest-mat-${initial?.path ?? 'new'}-tab-${wizard.materialMode}`}
                className="space-y-4"
              >
                {wizard.materialMode === 'upload' ? <>
                  <MaterialUpload
                    contestId={getValues('id')}
                    onUploaded={material => {
                      dispatch({ type: 'SET_UPLOADED', material });
                      setValue('pdf', material.path, { shouldValidate: true });
                    }}
                  />
                  {wizard.uploaded && (
                    <div className="flex items-center gap-3 rounded-[3px] border border-primary/25 bg-primary/5 p-4">
                      <Check className="size-4 text-primary" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{wizard.uploaded.name}</div>
                        <div className="mt-1 font-mono text-[10px] text-muted-foreground">{formatBytes(wizard.uploaded.size)} · {wizard.uploaded.sha256.slice(0, 16)}…</div>
                      </div>
                    </div>
                  )}
                </> : (
                  <Field label="题面 PDF" hint="相对于清单" error={errors.pdf?.message}><Input className="font-mono text-xs" {...register('pdf')} /></Field>
                )}
              </div>
              {errors.pdf && <p role="alert" className="text-xs text-danger">{errors.pdf.message}</p>}
              {!capabilities.features.contest_upload && <Note>当前 runner 尚未提供上传接口，因此保留本机路径模式。</Note>}
            </div>
          )}

          {wizard.step === 2 && (
            <div className="space-y-5">
              <div><h3 className="font-semibold">判题方式</h3><p className="mt-1 text-xs text-muted-foreground">判题后端写入 Contest Manifest；只有本地答案模式会生成 judge.json。</p></div>
              <Field label="判题后端">
                <Controller control={control} name="judge" render={({ field }) => (
                  <Select value={field.value} onValueChange={value => {
                    field.onChange(value);
                    dispatch({ type: 'JUDGE_CHANGED', judge: value, sourceJudge });
                    clearErrors(['cfId', 'accountId', 'handle', 'pool', 'baseUrl', 'languages', 'problemMap']);
                    if (value !== 'local') {
                      const nextLanguages = sourceJudge?.kind === value && sourceJudge.languages ? sourceJudge.languages : defaultLanguagesFor(value, capabilities);
                      setValue('languages', JSON.stringify(nextLanguages));
                    }
                  }}>
                    {capabilities.judge_backends.map(backend => <SelectItem key={backend.kind} value={backend.kind}>{backend.label}</SelectItem>)}
                  </Select>
                )} />
              </Field>
              {values.judge === 'local'
                ? capabilities.features.judge_authoring
                  ? <ProblemEditor problems={wizard.problems} setProblems={setProblems} />
                  : <div className="space-y-4 border-l-2 border-primary/25 bg-muted/20 p-4"><Field label="答案 JSON" hint="相对于清单" error={errors.answers?.message}><Input className="font-mono text-xs" {...register('answers')} /></Field></div>
                : <div className="space-y-5 border-l-2 border-primary/25 bg-muted/20 p-4">
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label={values.judge === 'codeforces' ? 'Codeforces 赛事 ID' : `${judgeLabel} 赛事 ID`} error={errors.cfId?.message}>
                        <Input type={values.judge === 'codeforces' ? 'number' : 'text'} min="1" placeholder={values.judge === 'vjudge' ? '可留空，使用上游题目映射' : 'Contest ID'} {...register('cfId')} />
                      </Field>
                      <Field label="OJ 账号" hint="write-only 凭据引用" error={errors.accountId?.message}>
                        <Select value={values.accountId || 'manual'} onValueChange={value => setValue('accountId', value === 'manual' ? '' : value)}>
                          <SelectItem value="manual">手动用户名 / 账号池</SelectItem>
                          {accounts.data?.accounts.filter(account => account.platform === values.judge).map(account => (
                            <SelectItem key={account.id} value={account.id}>{account.label} · {account.handle}{account.ready ? '' : '（未就绪）'}</SelectItem>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="button" variant="secondary" size="sm" loading={previewContest.isPending} disabled={!values.cfId.trim()} onClick={() => previewContest.mutate()}>
                        <CloudDownload className="size-3.5" />拉取赛事信息
                      </Button>
                      <Button type="button" variant="ghost" size="sm" asChild>
                        <Link to="/connections" search={{ tab: 'oj' }}><KeyRound className="size-3.5" />管理 OJ 账号</Link>
                      </Button>
                    </div>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="专用用户名（Handle）" hint="已选 OJ 账号时可留空" error={errors.handle?.message}><Input {...register('handle')} /></Field>
                      <Field label="账号池" hint="与单账号二选一" error={errors.pool?.message}><Input placeholder="默认 default" {...register('pool')} /></Field>
                    </div>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="Base URL" hint={judgeBackend?.requires_base_url ? '必填' : '使用平台默认值'} error={errors.baseUrl?.message}><Input className="font-mono text-xs" placeholder="https://…" {...register('baseUrl')} /></Field>
                      {values.judge === 'hydro'
                        ? <Field label="Hydro Domain"><Input placeholder="system" {...register('domain')} /></Field>
                        : values.judge === 'codeforces'
                          ? <Field label="赛事类型"><Controller control={control} name="gym" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectItem value="contest">Codeforces Round</SelectItem><SelectItem value="gym">Codeforces Gym</SelectItem></Select>} /></Field>
                          : <div />}
                    </div>
                    <RemoteProblemEditor problems={wizard.problems} setProblems={setProblems} />
                    {showCfPointsNotice && (
                      <div className="space-y-2 border-l-2 border-warning bg-warning/5 px-3 py-2.5 text-xs text-warning">
                        <p>{effectiveCfPointsKnown === true
                          ? '已手工确认当前题目满分（保存时标记 points_known = true；如再修改题号或分值需重新确认）。'
                          : <>当前本地题目满分尚未全部与上游预览分值匹配，保存时将标记为 <span className="font-mono">points_known = false</span>（避免把占位或未核对分值当作真实加权排名）。</>}</p>
                        <label className="flex items-center gap-2 text-foreground">
                          <input
                            type="checkbox"
                            checked={Boolean(currentCfWeightSig && wizard.confirmedWeightsSig === currentCfWeightSig)}
                            onChange={event => dispatch({ type: 'SET_CF_CONFIRMATION', confirmed: event.target.checked, currentSig: currentCfWeightSig })}
                          />
                          我已手工核对并确认当前全部题目真实满分（标记 points_known = true）
                        </label>
                      </div>
                    )}
                    {judgeBackend?.language_presets && judgeBackend.language_presets.length > 0 && (
                      <div>
                        <div className="mb-2 text-xs font-medium">语言预设</div>
                        <div className="flex flex-wrap gap-2">
                          {judgeBackend.language_presets.map(language => {
                            const enabled = Object.keys(stringRecord(values.languages)).includes(language.id);
                            return (
                              <button
                                key={language.id}
                                type="button"
                                aria-pressed={enabled}
                                onClick={() => {
                                  const mapping = stringRecord(values.languages);
                                  if (enabled) delete mapping[language.id];
                                  else mapping[language.id] = language.remote_id;
                                  setValue('languages', JSON.stringify(mapping));
                                }}
                                className={enabled ? 'rounded-[2px] border border-primary bg-primary px-3 py-2 text-xs text-primary-foreground' : 'rounded-[2px] border bg-card px-3 py-2 text-xs text-muted-foreground hover:border-primary/40'}
                              >
                                {language.label}<span className="ml-1.5 font-mono text-[9px] opacity-65">{language.remote_id}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <Field label="语言映射 JSON" hint="高级：本地语言 ID → 远端 ID" error={errors.languages?.message}><Input className="font-mono text-xs" {...register('languages')} /></Field>
                    <Field label="题号映射 problem_map" hint="PDF 题号 → 平台题号" error={errors.problemMap?.message}><Textarea className="min-h-24" {...register('problemMap')} /></Field>
                    {wizard.remotePreview && (
                      <div className="rounded-[3px] border bg-card p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{wizard.remotePreview.preview.title}</span>
                          <Badge>{wizard.remotePreview.preview.status}</Badge>
                          <Badge>{wizard.remotePreview.preview.contest_ref}</Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {wizard.remotePreview.preview.problems.map(problem => (
                            <span key={problem.remote_id} className="border px-2 py-1 font-mono text-[10px]" title={problem.title}>
                              {problem.remote_id}{problem.max_points !== undefined ? ` · ${problem.max_points}` : ''}
                            </span>
                          ))}
                        </div>
                        {wizard.remotePreview.pdf_info && (
                          <p className="mt-3 font-mono text-[10px] text-muted-foreground">
                            PDF {wizard.remotePreview.pdf_info.page_count} 页 · 识别 {wizard.remotePreview.pdf_info.problem_ids.join(' / ') || '—'}
                          </p>
                        )}
                        {wizard.remotePreview.problem_map_suggestion && (
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            已应用 {Object.keys(wizard.remotePreview.problem_map_suggestion.problem_map).length} 条题号映射建议（已保留显式映射）；保存前请核对。
                          </p>
                        )}
                        {wizard.remotePreview.problem_map_suggestion && wizard.remotePreview.problem_map_suggestion.unmapped_local.length > 0 && (
                          <p className="mt-2 border-l-2 border-warning pl-2.5 text-xs text-warning">
                            未自动映射的本地题号（已保留在题目表中，请手工补充 problem_map）：<span className="font-mono">{wizard.remotePreview.problem_map_suggestion.unmapped_local.join(', ')}</span>
                          </p>
                        )}
                        {wizard.remotePreview.problem_map_suggestion && wizard.remotePreview.problem_map_suggestion.unmapped_remote.length > 0 && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            未使用的远端题号：<span className="font-mono">{wizard.remotePreview.problem_map_suggestion.unmapped_remote.join(', ')}</span>
                          </p>
                        )}
                      </div>
                    )}
                    <p className="text-xs leading-5 text-muted-foreground">仅用于有权限的历史赛事提交。提交时间由本机 Supervisor 记录，上游故障不会被当作答错。</p>
                  </div>}
            </div>
          )}

          {wizard.step === 3 && (
            <div className="space-y-6">
              <div><h3 className="font-semibold">赛规与保存确认</h3><p className="mt-1 text-xs text-muted-foreground">这些预算直接约束比赛，不是界面显示偏好。</p></div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="比赛时限" hint="分钟，可精确到秒" error={errors.timeLimitMs?.message}>
                  <Input
                    type="number"
                    min={1000 / 60000}
                    max={480}
                    step="any"
                    value={timeLimitText}
                    onChange={event => {
                      const raw = event.target.value;
                      setTimeLimitText(raw);
                      const parsed = Number(raw);
                      setValue('timeLimitMs', raw.trim() && Number.isFinite(parsed) ? Math.round(parsed * 60000) : 0, { shouldValidate: true });
                    }}
                  />
                </Field>
                <Field label="最大提交次数" error={errors.maxSubmissions?.message}>
                  <Input type="number" min="1" max="1000" {...register('maxSubmissions', { valueAsNumber: true })} />
                </Field>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="协议预设"><Controller control={control} name="protocolPreset" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectItem value="auto">按赛时自动选择</SelectItem>{capabilities.protocol_presets?.map(preset => <SelectItem key={preset.id} value={preset.id}>{preset.id} · {preset.max_turns} 轮</SelectItem>)}</Select>} /></Field>
                <Field label="默认计分口径"><Controller control={control} name="scoringMode" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectItem value="auto">平台默认</SelectItem>{['icpc', 'cf', 'ioi', 'last_ac'].map(mode => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}</Select>} /></Field>
              </div>
              <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-3 border-y py-5 text-xs">
                <dt className="text-muted-foreground">Contest</dt><dd className="font-medium">{values.id || '—'} · v{values.dataVersion}</dd>
                <dt className="text-muted-foreground">清单路径</dt><dd className="break-all font-mono">{values.file}</dd>
                <dt className="text-muted-foreground">题面 PDF</dt><dd className="break-all font-mono">{values.pdf || '—'}</dd>
                <dt className="text-muted-foreground">判题方式</dt><dd>{judgeLabel}</dd>
                <dt className="text-muted-foreground">赛规预算</dt><dd>{formatDuration(values.timeLimitMs, true)}（{values.timeLimitMs % 60000 === 0 ? `${values.timeLimitMs / 60000} 分钟` : `${Number((values.timeLimitMs / 60000).toFixed(2))} 分钟 · ${values.timeLimitMs} ms`}）· 最多 {values.maxSubmissions} 次提交</dd>
              </dl>
              <p className="text-[11px] leading-5 text-muted-foreground">保存时将再次由服务端校验材料、题目、判题配置与摘要。前端不会把校验成功当作运行预检成功。</p>
            </div>
          )}
        </AnimatedPanel>
      </div>

      <div className="mt-7 flex items-center justify-between border-t pt-5">
        <Button type="button" variant="ghost" disabled={wizard.step === 0} onClick={() => goTo(wizard.step - 1)}><ArrowLeft className="size-4" />上一步</Button>
        {wizard.step < 3
          ? <Button key="continue" type="button" onClick={() => void next()}>继续<ArrowRight className="size-4" /></Button>
          : <div key="save" className="flex gap-2">
              <Button type="submit" variant="secondary" loading={isSubmitting} onClick={() => { intent.current = 'save'; }}>{initial ? '保存修改' : '仅保存'}</Button>
              <Button type="submit" loading={isSubmitting} onClick={() => { intent.current = 'batch'; }}>{initial ? '保存并加入新批次' : '保存并加入批次'}</Button>
            </div>}
      </div>
      {saved && <div className="mt-5"><SavedPath path={saved} /></div>}
    </form>
  );
}

export function ContestForm({ initial, onSaved }: { initial?: ContestItemResponse; onSaved?: (intent?: 'save' | 'batch') => Promise<void> | void }) {
  const capabilities = useCapabilities();
  if (capabilities.isLoading) return <div className="skeleton h-[520px] rounded-[3px] border bg-muted/30" />;
  if (capabilities.isError || !capabilities.data) return <Note>无法读取 Contest 能力描述：{(capabilities.error as Error)?.message ?? '未知错误'}</Note>;
  return <ContestManifestForm capabilities={capabilities.data} initial={initial} onSaved={onSaved} />;
}
