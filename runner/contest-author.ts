import { link, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { contestSchema, id, judgeSchema, resolveContest } from './config.js';
import { managedMaterial } from './materials.js';
import { FieldError } from './agent-manifest.js';
import { importCodeforces } from './codeforces.js';

export async function outputPath(base: string, path: string) {
  const target = resolve(base, path);
  const root = await realpath(base);
  const parent = await realpath(dirname(target)).catch(() => { throw new FieldError(['file'], 'Output parent directory does not exist'); });
  const within = relative(root, parent);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) || within.split(sep).some(p => p.startsWith('.')) || target.includes('\0')) {
    throw new FieldError(['file'], 'Output must be inside the Studio workspace');
  }
  return join(parent, target.split(sep).at(-1)!);
}
const authoredJudge = z.strictObject({ kind: z.literal('local'), problems: judgeSchema.shape.problems.optional() });
const authorRequest = z.strictObject({ file: z.string().min(1).max(4096), document: z.record(z.string(), z.unknown()),
  judge: judgeSchema.optional() });
const materialInput = z.object({ path: z.string(), name: z.string().optional(), sha256: z.string().optional(), redistribution: z.enum(['allowed', 'restricted', 'unknown']).optional() });
export async function createContestDocument(root: string, base: string, raw: unknown, signal: AbortSignal) {
  const { file, document, judge: payload } = authorRequest.parse(raw);
  const target = await outputPath(base, file);
  if (extname(target) !== '.json') throw new FieldError(['file'], 'Contest output must end in .json');
  const { kind: documentKind, ...fields } = document;
  if (documentKind !== undefined && documentKind !== 'contestreplay.dev/contest') throw new FieldError(['document', 'kind'], 'Unsupported Contest manifest kind');
  const contestId = id.parse(document.contest_id);
  const materials = z.strictObject({ entrypoint: materialInput.extend({ kind: z.enum(['pdf', 'entrypoint']).optional(), size: z.number().optional() }),
    attachments: z.array(materialInput.extend({ kind: z.literal('attachment').optional(), size: z.number().optional() })).max(32).default([]) }).parse(document.materials);
  const artifact = (value: z.infer<typeof materialInput>, kind: 'entrypoint' | 'attachment') => {
    const managed = managedMaterial(root, value.path, contestId, kind);
    return { path: managed ? relative(dirname(target), managed) : value.path, sha256: value.sha256, redistribution: value.redistribution ?? 'unknown' };
  };
  const judge = z.object({ kind: z.enum(['local', 'codeforces']) }).loose().parse(document.judge);
  let answers: z.infer<typeof judgeSchema> | undefined;
  let problems = document.problems;
  const rules = document.rules;
  let cfPointsKnown: boolean | undefined;
  if (judge.kind === 'local' && (payload || Array.isArray(judge.problems) || Array.isArray(problems) && problems.some(p => p && Object.hasOwn(p, 'accepted_answers')))) {
    authoredJudge.parse(document.judge);
    if (payload && judge.problems) throw new FieldError(['judge'], 'Only one local answer table may be supplied');
    answers = judgeSchema.parse(payload ?? { schema_version: 1, problems: judge.problems ?? problems });
    if (!payload && !judge.problems) problems = undefined;
    problems ??= answers.problems.map(({ id, max_points }) => ({ id, max_points }));
  } else if (judge.kind === 'codeforces') {
    if (payload) throw new FieldError(['judge'], 'Codeforces does not accept a local answer file');
    if (!problems) {
      const contest = z.number().int().positive().parse(judge.contest_id);
      const imported = await importCodeforces(contest, signal);
      cfPointsKnown = imported.problems.every(p => typeof p.points === 'number' && Number.isFinite(p.points) && p.points >= 1);
      problems = imported.problems.map(p => ({ id: p.index, max_points: typeof p.points === 'number' && Number.isFinite(p.points) && p.points >= 1 ? Math.round(p.points) : 1 }));
    }
  }
  const answersPath = join(dirname(target), 'judge.json');
  if (answers && answersPath === target) throw new FieldError(['file'], 'Contest cannot be named judge.json');
  const resolvedJudge = answers
    ? { kind: 'local', answers: { path: 'judge.json', redistribution: 'restricted' } }
    : (cfPointsKnown !== undefined && document.judge && typeof document.judge === 'object'
      ? { ...(document.judge as Record<string, unknown>), points_known: cfPointsKnown }
      : document.judge);
  const manifest = contestSchema.parse({ ...fields, problems, rules,
    materials: { entrypoint: { ...artifact(materials.entrypoint, 'entrypoint'), kind: 'pdf' },
      attachments: materials.attachments.map(item => ({ ...artifact(item, 'attachment'), name: item.name ?? item.path.split('/').at(-1) })) },
    judge: resolvedJudge });
  // Stage private data beside its destination. No existing file is overwritten.
  const temp = await mkdtemp(join(dirname(target), '.cr-contest-'));
  let linkedJudge = false;
  try {
    if (answers) {
      await writeFile(join(temp, 'judge.json'), JSON.stringify(answers, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await link(join(temp, 'judge.json'), answersPath);
      linkedJudge = true;
    }
    const { contest, contestRevision } = await resolveContest(manifest, target);
    const { statement: _statement, ...document } = contest;
    await writeFile(join(temp, 'contest.json'), JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await link(join(temp, 'contest.json'), target);
    return { path: target, revision: contestRevision, ...(linkedJudge ? { judge_path: answersPath } : {}) };
  } catch (error) {
    if (linkedJudge) await rm(answersPath, { force: true });
    throw error;
  } finally { await rm(temp, { recursive: true, force: true }); }
}