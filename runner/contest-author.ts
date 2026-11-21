import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { contestSchema, id, judgeSchema, resolveContest } from './config.js';
import { managedMaterial } from './materials.js';
import { FieldError } from './agent-manifest.js';
import { importCodeforces } from './codeforces.js';

const FORBIDDEN_ROOTS = new Set(['node_modules', 'dist', 'coverage', 'runs']);

export async function outputPath(base: string, path: string) {
  if (!path || path.includes('\0')) throw new FieldError(['file'], 'Output path is invalid');
  const target = resolve(base, path);
  const root = await realpath(base);
  const parent = await realpath(dirname(target)).catch(() => { throw new FieldError(['file'], 'Output parent directory does not exist'); });
  const within = relative(root, parent);
  const parts = within ? within.split(sep) : [];
  if (
    within === '..' ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within) ||
    parts.some(p => p.startsWith('.')) ||
    (parts[0] !== undefined && FORBIDDEN_ROOTS.has(parts[0])) ||
    target.includes('\0')
  ) {
    throw new FieldError(['file'], 'Output must be inside the Studio workspace');
  }
  const baseName = target.split(sep).at(-1)!;
  if (!baseName || baseName === '.' || baseName === '..' || baseName.startsWith('.')) {
    throw new FieldError(['file'], 'Invalid output filename');
  }
  return join(parent, baseName);
}

export async function existingWorkspaceFile(base: string, relPath: string, fieldName = 'path') {
  if (!relPath || relPath.includes('\0')) throw new FieldError([fieldName], 'Invalid file path');
  const target = resolve(base, relPath);
  const root = await realpath(base);
  const parent = await realpath(dirname(target)).catch(() => { throw new FieldError([fieldName], 'File not found', 404); });
  const withinParent = relative(root, parent);
  const parentParts = withinParent ? withinParent.split(sep) : [];
  if (
    withinParent === '..' ||
    withinParent.startsWith(`..${sep}`) ||
    isAbsolute(withinParent) ||
    parentParts.some(p => p.startsWith('.')) ||
    (parentParts[0] !== undefined && FORBIDDEN_ROOTS.has(parentParts[0]))
  ) {
    throw new FieldError([fieldName], 'Path must be inside the Studio workspace');
  }
  const baseName = target.split(sep).at(-1)!;
  if (!baseName || baseName === '.' || baseName === '..' || baseName.startsWith('.')) {
    throw new FieldError([fieldName], 'Invalid filename');
  }
  const candidate = join(parent, baseName);
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new FieldError([fieldName], 'File not found', 404);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new FieldError([fieldName], 'Target must be a regular non-symlink file');
  }
  const realTarget = await realpath(candidate);
  const withinTarget = relative(root, realTarget);
  if (withinTarget === '..' || withinTarget.startsWith(`..${sep}`) || isAbsolute(withinTarget)) {
    throw new FieldError([fieldName], 'Path escapes the Studio workspace');
  }
  return candidate;
}

export async function readWorkspaceFileNoFollow(target: string, limit = 1_000_000): Promise<Buffer> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new FieldError(['path'], 'File is invalid or too large');
    const bytes = Buffer.alloc(info.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const res = await handle.read(bytes, read, bytes.length - read, read);
      if (!res.bytesRead) break;
      read += res.bytesRead;
    }
    if (read !== info.size) throw new FieldError(['path'], 'File changed while reading');
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

const authoredJudge = z.strictObject({ kind: z.literal('local'), problems: judgeSchema.shape.problems.optional() });
const authorRequest = z.strictObject({
  file: z.string().min(1).max(4096).optional(),
  document: z.record(z.string(), z.unknown()),
  judge: judgeSchema.optional(),
});
const updateRequest = z.strictObject({
  path: z.string().min(1).max(4096),
  document: z.record(z.string(), z.unknown()),
  judge: judgeSchema.optional(),
});
const materialInput = z.object({
  path: z.string(),
  name: z.string().optional(),
  sha256: z.string().optional(),
  redistribution: z.enum(['allowed', 'restricted', 'unknown']).optional(),
});

async function prepareContestWrite(
  root: string,
  target: string,
  document: Record<string, unknown>,
  payload: z.infer<typeof judgeSchema> | undefined,
  managed: boolean,
  signal: AbortSignal,
) {
  if (extname(target) !== '.json') throw new FieldError(['file'], 'Contest output must end in .json');
  const { kind: documentKind, ...fields } = document;
  if (documentKind !== undefined && documentKind !== 'contestreplay.dev/contest') {
    throw new FieldError(['document', 'kind'], 'Unsupported Contest manifest kind');
  }
  const contestId = id.parse(document.contest_id);
  const materials = z.strictObject({
    entrypoint: materialInput.extend({ kind: z.enum(['pdf', 'entrypoint']).optional(), size: z.number().optional() }),
    attachments: z.array(materialInput.extend({ kind: z.literal('attachment').optional(), size: z.number().optional() })).max(32).default([]),
  }).parse(document.materials);
  const artifact = (value: z.infer<typeof materialInput>, kind: 'entrypoint' | 'attachment') => {
    const managedPath = managedMaterial(root, value.path, contestId, kind);
    return {
      path: managedPath ? relative(dirname(target), managedPath) : value.path,
      sha256: value.sha256,
      redistribution: value.redistribution ?? 'unknown',
    };
  };
  const judge = z.object({ kind: z.enum(['local', 'codeforces', 'qoj', 'vjudge', 'hydro']) }).loose().parse(document.judge);
  let answers: z.infer<typeof judgeSchema> | undefined;
  let problems = document.problems;
  const rules = document.rules;
  let cfPointsKnown: boolean | undefined;

  if (
    judge.kind === 'local' &&
    (payload || Array.isArray(judge.problems) || (Array.isArray(problems) && problems.some(p => p && Object.hasOwn(p, 'accepted_answers'))))
  ) {
    authoredJudge.parse(document.judge);
    if (payload && judge.problems) throw new FieldError(['judge'], 'Only one local answer table may be supplied');
    answers = judgeSchema.parse(payload ?? { schema_version: 1, problems: judge.problems ?? problems });
    if (!payload && !judge.problems) problems = undefined;
    problems ??= answers.problems.map(({ id, max_points }) => ({ id, max_points }));
  } else if (judge.kind !== 'local') {
    if (payload) throw new FieldError(['judge'], `${judge.kind} does not accept a local answer file`);
    if (judge.kind === 'codeforces' && !problems) {
      const contestNum = z.number().int().positive().parse(judge.contest_id);
      const imported = await importCodeforces(contestNum, signal);
      cfPointsKnown = imported.problems.every(p => typeof p.points === 'number' && Number.isFinite(p.points) && p.points >= 1);
      problems = imported.problems.map(p => ({
        id: p.index,
        max_points: typeof p.points === 'number' && Number.isFinite(p.points) && p.points >= 1 ? Math.round(p.points) : 1,
      }));
    }
  }

  const judgeFileName = managed ? `${contestId}.judge.json` : 'judge.json';
  const answersPath = join(dirname(target), judgeFileName);
  if (answers && answersPath === target) throw new FieldError(['file'], `Contest cannot be named ${judgeFileName}`);
  const resolvedJudge = answers
    ? { kind: 'local', answers: { path: judgeFileName, redistribution: 'restricted' } }
    : (cfPointsKnown !== undefined && document.judge && typeof document.judge === 'object'
      ? { ...(document.judge as Record<string, unknown>), points_known: cfPointsKnown }
      : document.judge);

  const manifest = contestSchema.parse({
    ...fields,
    problems,
    rules,
    materials: {
      entrypoint: { ...artifact(materials.entrypoint, 'entrypoint'), kind: 'pdf' },
      attachments: materials.attachments.map(item => ({
        ...artifact(item, 'attachment'),
        name: item.name ?? item.path.split('/').at(-1),
      })),
    },
    judge: resolvedJudge,
  });

  return { manifest, answers, answersPath };
}

export async function createContestDocument(root: string, base: string, raw: unknown, signal: AbortSignal) {
  const { file, document, judge: payload } = authorRequest.parse(raw);
  const managed = !file;
  const contestId = id.parse(document.contest_id);
  if (managed) {
    await mkdir(join(base, 'contests'), { recursive: true });
  }
  const target = await outputPath(base, file ?? `contests/${contestId}.json`);
  const { manifest, answers, answersPath } = await prepareContestWrite(root, target, document, payload, managed, signal);

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
    const { statement: _statement, ...savedDoc } = contest;
    await writeFile(join(temp, 'contest.json'), JSON.stringify(savedDoc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await link(join(temp, 'contest.json'), target);
    return { path: target, revision: contestRevision, ...(linkedJudge ? { judge_path: answersPath } : {}) };
  } catch (error) {
    if (linkedJudge) await rm(answersPath, { force: true });
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function updateContestDocument(root: string, base: string, raw: unknown, signal: AbortSignal) {
  const { path, document, judge: payload } = updateRequest.parse(raw);
  const target = await existingWorkspaceFile(base, path, 'path');
  const rel = relative(await realpath(base), target);
  const managed = rel.startsWith(`contests${sep}`) && extname(target) === '.json';
  const { manifest, answers, answersPath } = await prepareContestWrite(root, target, document, payload, managed, signal);

  const temp = await mkdtemp(join(dirname(target), '.cr-contest-'));
  try {
    let wroteJudge = false;
    let checkManifest = manifest;
    if (answers) {
      const stagedJudge = join(temp, 'judge.json');
      await writeFile(stagedJudge, JSON.stringify(answers, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      checkManifest = {
        ...manifest,
        judge: { kind: 'local', answers: { path: relative(dirname(target), stagedJudge), redistribution: 'restricted' } },
      };
    }
    const { contest, contestRevision } = await resolveContest(checkManifest, target);
    const { statement: _statement, ...resolvedDoc } = contest;
    const savedDoc = answers
      ? {
          ...resolvedDoc,
          judge: {
            kind: 'local' as const,
            answers: {
              ...(contest.judge.kind === 'local' ? contest.judge.answers : {}),
              path: relative(dirname(target), answersPath),
              redistribution: 'restricted' as const,
            },
          },
        }
      : resolvedDoc;
    await writeFile(join(temp, 'contest.json'), JSON.stringify(savedDoc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (answers) {
      await rename(join(temp, 'judge.json'), answersPath);
      wroteJudge = true;
    }
    await rename(join(temp, 'contest.json'), target);
    return { path: target, revision: contestRevision, ...(wroteJudge ? { judge_path: answersPath } : {}) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
