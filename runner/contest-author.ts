import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  agentSchema,
  contestSchema,
  id,
  judgeSchema,
  legacyAgentSchema,
  legacyContestSchema,
  resolveContest,
  sha256,
} from './config.js';
import { managedMaterial } from './materials.js';
import { FieldError, manifestSchema } from './agent-manifest.js';
import { importCodeforces } from './codeforces.js';
import { protocolPresets, resolveProtocolPreset } from './protocol.js';

const FORBIDDEN_ROOTS = new Set(['node_modules', 'dist', 'coverage', 'runs']);
const MANAGED_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function resolveRealPathOrAncestor(targetPath: string): Promise<string> {
  const abs = resolve(targetPath);
  try {
    return await realpath(abs);
  } catch {
    const suffix: string[] = [];
    let current = abs;
    while (true) {
      const parent = dirname(current);
      if (parent === current) return abs;
      suffix.unshift(basename(current));
      current = parent;
      try {
        const realAncestor = await realpath(current);
        return join(realAncestor, ...suffix);
      } catch {
        // Keep walking up to nearest existing ancestor.
      }
    }
  }
}

function isWithinOrEqual(candidate: string, boundary: string): boolean {
  const rel = relative(boundary, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertNoSymlinkSegments(rootDir: string, relParts: string[], fieldName: string): Promise<void> {
  let cursor = rootDir;
  for (const part of relParts) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new FieldError([fieldName], 'File not found', 404);
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new FieldError([fieldName], 'Path traverses a symlink or non-directory');
    }
  }
}

export function isJudgeAnswerFilename(filePath: string): boolean {
  const lower = basename(filePath).toLowerCase();
  return lower === 'judge.json' || /\.judge(?:\.[a-z0-9_-]+)?\.json$/i.test(lower);
}

export function assertAgentDocument(filePath: string, parsed: unknown, fieldName = 'path'): void {
  const lower = basename(filePath).toLowerCase();
  if (lower === 'package.json' || lower === 'run.json' || isJudgeAnswerFilename(filePath)) {
    throw new FieldError([fieldName], 'Target file is not an Agent manifest');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FieldError([fieldName], 'Target file is not an Agent manifest');
  }
  const obj = parsed as Record<string, unknown>;
  if ('run_id' in obj || 'contest_id' in obj) {
    throw new FieldError([fieldName], 'Target file is not an Agent manifest');
  }
  if (
    manifestSchema.safeParse(parsed).success ||
    agentSchema.safeParse(parsed).success ||
    legacyAgentSchema.safeParse(parsed).success
  ) {
    return;
  }
  throw new FieldError([fieldName], 'Target file is not a recognized Agent manifest');
}

export function assertContestDocument(filePath: string, parsed: unknown, fieldName = 'path'): void {
  const lower = basename(filePath).toLowerCase();
  if (lower === 'package.json' || lower === 'run.json' || isJudgeAnswerFilename(filePath)) {
    throw new FieldError([fieldName], 'Target file is not a Contest manifest');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FieldError([fieldName], 'Target file is not a Contest manifest');
  }
  const obj = parsed as Record<string, unknown>;
  if ('run_id' in obj || judgeSchema.safeParse(parsed).success) {
    throw new FieldError([fieldName], 'Target file is not a Contest manifest');
  }
  if (legacyContestSchema.safeParse(parsed).success) {
    return;
  }
  const candidate = obj.kind === 'contestreplay.dev/contest'
    ? (() => {
        const { kind: _k, ...rest } = obj;
        return rest;
      })()
    : parsed;
  if (contestSchema.safeParse(candidate).success) {
    return;
  }
  throw new FieldError([fieldName], 'Target file is not a recognized Contest manifest');
}

export async function verifyManagedMaterialsRoot(root: string): Promise<string | undefined> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
  const materialsDir = join(realRoot, '.materials');
  let info;
  try {
    info = await lstat(materialsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new FieldError(['path'], 'Managed materials root must be a real directory', 400);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new FieldError(['path'], 'Managed materials root must be owned by the current user', 500);
  }
  const realMaterials = await realpath(materialsDir);
  if (realMaterials !== materialsDir) {
    throw new FieldError(['path'], 'Managed materials root escapes configured run root', 400);
  }
  return realMaterials;
}

export async function verifyManagedMaterialFile(
  root: string,
  ref: string,
  expectedKind?: 'entrypoint' | 'attachment',
  fieldName = 'path',
): Promise<{
  contestId: string;
  kind: 'entrypoint' | 'attachment';
  filename: string;
  fullPath: string;
  realMaterials: string;
}> {
  const parts = ref.split('/');
  if (parts.length !== 4 || parts[0] !== 'managed') {
    throw new FieldError([fieldName], 'Material path must use managed/<contest_id>/<kind>/<filename>');
  }
  const contestId = id.parse(parts[1]);
  const kind = z.enum(['entrypoint', 'attachment']).parse(parts[2]);
  if (expectedKind && kind !== expectedKind) {
    throw new FieldError([fieldName], `Material kind must be ${expectedKind}`);
  }
  const filename = parts[3]!;
  if (!MANAGED_ASSET_NAME.test(filename)) {
    throw new FieldError([fieldName], 'Invalid managed material filename');
  }
  const realMaterials = await verifyManagedMaterialsRoot(root);
  if (!realMaterials) {
    throw new FieldError([fieldName], 'Material not found', 404);
  }
  await assertNoSymlinkSegments(realMaterials, [contestId, kind], fieldName);
  const fullPath = join(realMaterials, contestId, kind, filename);
  let info;
  try {
    info = await lstat(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new FieldError([fieldName], 'Material not found', 404);
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new FieldError([fieldName], 'Material target must be a regular non-symlink file');
  }
  const realTarget = await realpath(fullPath);
  if (!isWithinOrEqual(realTarget, realMaterials) || realTarget === realMaterials) {
    throw new FieldError([fieldName], 'Material escapes managed materials directory');
  }
  return { contestId, kind, filename, fullPath: realTarget, realMaterials };
}

export async function outputPath(base: string, path: string, excludedRoot?: string) {
  if (!path || path.includes('\0')) throw new FieldError(['file'], 'Output path is invalid');
  const root = await realpath(base);
  const target = resolve(root, path);
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
  // Ensure no symlink directory segments along the path under workspace root.
  const rawParentRel = relative(root, dirname(target));
  if (rawParentRel && rawParentRel !== '..' && !rawParentRel.startsWith(`..${sep}`) && !isAbsolute(rawParentRel)) {
    await assertNoSymlinkSegments(root, rawParentRel.split(sep), 'file');
  }
  const baseName = target.split(sep).at(-1)!;
  if (!baseName || baseName === '.' || baseName === '..' || baseName.startsWith('.')) {
    throw new FieldError(['file'], 'Invalid output filename');
  }
  const candidate = join(parent, baseName);
  if (excludedRoot) {
    const realExcluded = await resolveRealPathOrAncestor(excludedRoot);
    if (isWithinOrEqual(parent, realExcluded) || isWithinOrEqual(candidate, realExcluded)) {
      throw new FieldError(['file'], 'Output cannot be inside the configured run root');
    }
  }
  return candidate;
}

export async function existingWorkspaceFile(base: string, relPath: string, fieldName = 'path', excludedRoot?: string) {
  if (!relPath || relPath.includes('\0')) throw new FieldError([fieldName], 'Invalid file path');
  const root = await realpath(base);
  const target = resolve(root, relPath);
  const rawWithin = relative(root, target);
  if (rawWithin === '..' || rawWithin.startsWith(`..${sep}`) || isAbsolute(rawWithin) || !rawWithin) {
    throw new FieldError([fieldName], 'Path must be inside the Studio workspace');
  }
  const rawParts = rawWithin.split(sep);
  if (rawParts.some(p => !p || p === '.' || p === '..' || p.startsWith('.')) || FORBIDDEN_ROOTS.has(rawParts[0]!)) {
    throw new FieldError([fieldName], 'Path must be inside the Studio workspace');
  }
  await assertNoSymlinkSegments(root, rawParts.slice(0, -1), fieldName);
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
  if (excludedRoot) {
    const realExcluded = await resolveRealPathOrAncestor(excludedRoot);
    if (isWithinOrEqual(realTarget, realExcluded)) {
      throw new FieldError([fieldName], 'Path cannot be inside the configured run root');
    }
  }
  return realTarget;
}

export async function readWorkspaceFileNoFollow(target: string, limit = 1_000_000, fieldName = 'path'): Promise<Buffer> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new FieldError([fieldName], 'File is invalid or too large');
    const bytes = Buffer.alloc(info.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const res = await handle.read(bytes, read, bytes.length - read, read);
      if (!res.bytesRead) break;
      read += res.bytesRead;
    }
    if (read !== info.size) throw new FieldError([fieldName], 'File changed while reading');
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

async function resolveStudioArtifact(opts: {
  root: string;
  base: string;
  target: string;
  rawPath: string;
  expectedSha256?: string;
  role: 'entrypoint' | 'attachment' | 'answers';
  contestId: string;
  limit: number;
  fieldPath: string[];
}): Promise<{ fullPath: string; relativePath: string; sha256: string; bytes: Buffer }> {
  const { root, base, target, rawPath, expectedSha256, role, contestId, limit, fieldPath } = opts;
  const fieldName = fieldPath.join('.');
  if (!rawPath || rawPath.includes('\0')) {
    throw new FieldError(fieldPath, 'Artifact path is invalid');
  }

  let verifiedPath: string;
  if (rawPath.startsWith('managed/')) {
    if (role === 'answers') {
      throw new FieldError(fieldPath, 'Local judge answers cannot reference managed upload materials');
    }
    managedMaterial(root, rawPath, contestId, role);
    const managed = await verifyManagedMaterialFile(root, rawPath, role, fieldName);
    verifiedPath = managed.fullPath;
  } else {
    const realMaterials = await verifyManagedMaterialsRoot(root);
    const candidateFromTarget = resolve(dirname(target), rawPath);
    if (
      role !== 'answers' &&
      realMaterials &&
      isWithinOrEqual(candidateFromTarget, realMaterials) &&
      candidateFromTarget !== realMaterials
    ) {
      // Allow round-tripping a previously saved relative path pointing to a verified managed upload.
      const relInMat = relative(realMaterials, candidateFromTarget).split(sep);
      if (relInMat.length !== 3 || relInMat[1] !== role) {
        throw new FieldError(fieldPath, 'Invalid managed material reference');
      }
      const managed = await verifyManagedMaterialFile(
        root,
        `managed/${relInMat[0]}/${relInMat[1]}/${relInMat[2]}`,
        role,
        fieldName,
      );
      verifiedPath = managed.fullPath;
    } else {
      // Must be a regular, non-symlink, workspace-confined file (excluding hidden dirs, forbidden roots, and run root).
      const realBase = await realpath(base);
      const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(dirname(target), rawPath);
      const relFromBase = relative(realBase, candidate);
      if (!relFromBase || relFromBase === '..' || relFromBase.startsWith(`..${sep}`) || isAbsolute(relFromBase)) {
        throw new FieldError(fieldPath, 'Artifact path must be inside the Studio workspace');
      }
      verifiedPath = await existingWorkspaceFile(base, relFromBase, fieldName, root);
    }
  }

  // Validate and hash from the exact O_NOFOLLOW file descriptor (no TOCTOU).
  const bytes = await readWorkspaceFileNoFollow(verifiedPath, limit, fieldName);
  const digest = sha256(bytes);
  if (expectedSha256 && expectedSha256 !== digest) {
    throw new FieldError(fieldPath, 'Artifact SHA-256 mismatch');
  }

  if (role === 'entrypoint') {
    if (isJudgeAnswerFilename(verifiedPath)) {
      throw new FieldError(fieldPath, 'Answer files cannot be used as contest entrypoint');
    }
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new FieldError(fieldPath, 'Contest entrypoint must be a valid PDF');
    }
  } else if (role === 'attachment') {
    if (isJudgeAnswerFilename(verifiedPath)) {
      throw new FieldError(fieldPath, 'Answer files cannot be attached as contest materials');
    }
    if (extname(verifiedPath).toLowerCase() === '.json') {
      try {
        const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
        if (judgeSchema.safeParse(parsed).success) {
          throw new FieldError(fieldPath, 'Answer files cannot be attached as contest materials');
        }
      } catch (err) {
        if (err instanceof FieldError) throw err;
        // Non-JSON or unrelated JSON attachment is fine.
      }
    }
  } else if (role === 'answers') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new FieldError(fieldPath, 'Local judge answers must be valid JSON');
    }
    if (!judgeSchema.safeParse(parsed).success) {
      throw new FieldError(fieldPath, 'Local judge answers file does not match judge schema');
    }
  }

  return {
    fullPath: verifiedPath,
    relativePath: relative(dirname(target), verifiedPath),
    sha256: digest,
    bytes,
  };
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
  base: string,
  target: string,
  document: Record<string, unknown>,
  payload: z.infer<typeof judgeSchema> | undefined,
  signal: AbortSignal,
) {
  if (extname(target) !== '.json') throw new FieldError(['file'], 'Contest output must end in .json');
  if (isJudgeAnswerFilename(target)) throw new FieldError(['file'], 'Contest cannot use a judge answer filename');
  const { kind: documentKind, ...fields } = document;
  if (documentKind !== undefined && documentKind !== 'contestreplay.dev/contest') {
    throw new FieldError(['document', 'kind'], 'Unsupported Contest manifest kind');
  }
  const contestId = id.parse(document.contest_id);
  const materials = z.strictObject({
    entrypoint: materialInput.extend({ kind: z.enum(['pdf', 'entrypoint']).optional(), size: z.number().optional() }),
    attachments: z.array(materialInput.extend({ kind: z.literal('attachment').optional(), size: z.number().optional() })).max(32).default([]),
  }).parse(document.materials);

  const rulesRaw = document.rules && typeof document.rules === 'object' ? (document.rules as { protocol_preset?: string; time_limit_ms?: number }) : undefined;
  const presetName = resolveProtocolPreset({
    time_limit_ms: typeof rulesRaw?.time_limit_ms === 'number' ? rulesRaw.time_limit_ms : 900_000,
    protocol_preset: rulesRaw?.protocol_preset as 'short' | 'cf-2h' | 'icpc-5h' | undefined,
  });
  const pdfLimit = Math.max(40_000_000, protocolPresets[presetName].pdfMaxBytes);

  const verifiedEntrypoint = await resolveStudioArtifact({
    root,
    base,
    target,
    rawPath: materials.entrypoint.path,
    expectedSha256: materials.entrypoint.sha256,
    role: 'entrypoint',
    contestId,
    limit: pdfLimit,
    fieldPath: ['materials', 'entrypoint', 'path'],
  });

  const verifiedAttachments: Array<{
    path: string;
    sha256: string;
    redistribution: 'allowed' | 'restricted' | 'unknown';
    name: string | undefined;
  }> = [];
  let totalAttachmentBytes = 0;
  for (let idx = 0; idx < materials.attachments.length; idx++) {
    const item = materials.attachments[idx]!;
    const resolved = await resolveStudioArtifact({
      root,
      base,
      target,
      rawPath: item.path,
      expectedSha256: item.sha256,
      role: 'attachment',
      contestId,
      limit: 16_000_000,
      fieldPath: ['materials', 'attachments', String(idx), 'path'],
    });
    totalAttachmentBytes += resolved.bytes.length;
    if (totalAttachmentBytes > 32_000_000) {
      throw new FieldError(['materials', 'attachments'], 'Attachments exceed 32 MB');
    }
    verifiedAttachments.push({
      path: resolved.relativePath,
      sha256: resolved.sha256,
      redistribution: item.redistribution ?? 'unknown',
      name: item.name ?? item.path.split('/').at(-1),
    });
  }

  const judge = z.object({ kind: z.enum(['local', 'codeforces', 'qoj', 'vjudge', 'hydro']) }).loose().parse(document.judge);
  let answers: z.infer<typeof judgeSchema> | undefined;
  let problems = document.problems;
  const rules = document.rules;
  let cfPointsKnown: boolean | undefined;
  let resolvedJudge: unknown = document.judge;

  if (
    judge.kind === 'local' &&
    (payload || Array.isArray(judge.problems) || (Array.isArray(problems) && problems.some(p => p && Object.hasOwn(p, 'accepted_answers'))))
  ) {
    authoredJudge.parse(document.judge);
    if (payload && judge.problems) throw new FieldError(['judge'], 'Only one local answer table may be supplied');
    answers = judgeSchema.parse(payload ?? { schema_version: 1, problems: judge.problems ?? problems });
    if (!payload && !judge.problems) problems = undefined;
    problems ??= answers.problems.map(({ id, max_points }) => ({ id, max_points }));
  } else if (judge.kind === 'local') {
    const existingLocal = z.strictObject({
      kind: z.literal('local'),
      answers: z.strictObject({
        path: z.string().min(1).max(4096),
        sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        redistribution: z.enum(['allowed', 'restricted', 'unknown']).optional(),
      }),
    }).parse(document.judge);
    const verifiedAnswers = await resolveStudioArtifact({
      root,
      base,
      target,
      rawPath: existingLocal.answers.path,
      expectedSha256: existingLocal.answers.sha256,
      role: 'answers',
      contestId,
      limit: 4_000_000,
      fieldPath: ['judge', 'answers', 'path'],
    });
    resolvedJudge = {
      kind: 'local',
      answers: {
        path: verifiedAnswers.relativePath,
        sha256: verifiedAnswers.sha256,
        redistribution: existingLocal.answers.redistribution ?? 'restricted',
      },
    };
  } else {
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
    if (cfPointsKnown !== undefined && document.judge && typeof document.judge === 'object') {
      resolvedJudge = { ...(document.judge as Record<string, unknown>), points_known: cfPointsKnown };
    }
  }

  let answersJson: string | undefined;
  let answersHash: string | undefined;
  let judgeFileName: string | undefined;
  if (answers) {
    answersJson = JSON.stringify(answers, null, 2) + '\n';
    answersHash = sha256(answersJson);
    const stem = basename(target, '.json');
    judgeFileName = `${stem}.judge.${answersHash.slice(0, 12)}.json`;
    const answersPath = join(dirname(target), judgeFileName);
    if (answersPath === target) throw new FieldError(['file'], `Contest cannot be named ${judgeFileName}`);
    resolvedJudge = {
      kind: 'local',
      answers: {
        path: judgeFileName,
        sha256: answersHash,
        redistribution: 'restricted',
      },
    };
  }

  const manifest = contestSchema.parse({
    ...fields,
    problems,
    rules,
    materials: {
      entrypoint: {
        kind: 'pdf',
        path: verifiedEntrypoint.relativePath,
        sha256: verifiedEntrypoint.sha256,
        redistribution: materials.entrypoint.redistribution ?? 'unknown',
      },
      attachments: verifiedAttachments,
    },
    judge: resolvedJudge,
  });

  return {
    manifest,
    answers,
    answersJson,
    answersHash,
    judgeFileName,
  };
}

async function publishImmutableJudgeFile(
  stagedJudgePath: string,
  target: string,
  judgeFileName: string,
  answersHash: string,
): Promise<{ answersPath: string; publishedFileName: string; createdNew: boolean }> {
  const dir = dirname(target);
  const preferredPath = join(dir, judgeFileName);
  try {
    await link(stagedJudgePath, preferredPath);
    return { answersPath: preferredPath, publishedFileName: judgeFileName, createdNew: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    // Reuse if identical immutable content already exists; otherwise pick a fresh collision-free name.
    const existingBytes = await readWorkspaceFileNoFollow(preferredPath, 4_000_000, 'judge').catch(() => undefined);
    if (existingBytes && sha256(existingBytes) === answersHash) {
      return { answersPath: preferredPath, publishedFileName: judgeFileName, createdNew: false };
    }
    const stem = basename(target, '.json');
    const uniqueName = `${stem}.judge.${answersHash.slice(0, 12)}-${randomUUID().slice(0, 8)}.json`;
    const uniquePath = join(dir, uniqueName);
    await link(stagedJudgePath, uniquePath);
    return { answersPath: uniquePath, publishedFileName: uniqueName, createdNew: true };
  }
}

export async function createContestDocument(root: string, base: string, raw: unknown, signal: AbortSignal) {
  const { file, document, judge: payload } = authorRequest.parse(raw);
  const managed = !file;
  const contestId = id.parse(document.contest_id);
  if (managed) {
    await mkdir(join(base, 'contests'), { recursive: true });
  }
  const target = await outputPath(base, file ?? `contests/${contestId}.json`, root);
  const { manifest, answers, answersJson, answersHash, judgeFileName } = await prepareContestWrite(
    root,
    base,
    target,
    document,
    payload,
    signal,
  );

  // Stage private data beside its destination. No existing file is overwritten.
  const temp = await mkdtemp(join(dirname(target), '.cr-contest-'));
  let createdJudgePath: string | undefined;
  try {
    let checkManifest = manifest;
    const stagedJudge = join(temp, 'judge.json');
    if (answers && answersJson) {
      await writeFile(stagedJudge, answersJson, { mode: 0o600, flag: 'wx' });
      checkManifest = {
        ...manifest,
        judge: {
          kind: 'local',
          answers: {
            path: relative(dirname(target), stagedJudge),
            sha256: answersHash,
            redistribution: 'restricted',
          },
        },
      };
    }
    const { contest, contestRevision } = await resolveContest(checkManifest, target);
    const { statement: _statement, ...resolvedDoc } = contest;

    let finalJudgePath: string | undefined;
    let finalJudgeName = judgeFileName;
    if (answers && answersHash && judgeFileName) {
      const published = await publishImmutableJudgeFile(stagedJudge, target, judgeFileName, answersHash);
      finalJudgePath = published.answersPath;
      finalJudgeName = published.publishedFileName;
      if (published.createdNew) createdJudgePath = published.answersPath;
    }

    const savedDoc = answers && finalJudgeName
      ? {
          ...resolvedDoc,
          judge: {
            kind: 'local' as const,
            answers: {
              ...(contest.judge.kind === 'local' ? contest.judge.answers : {}),
              path: finalJudgeName,
              sha256: answersHash,
              redistribution: 'restricted' as const,
            },
          },
        }
      : resolvedDoc;

    await writeFile(join(temp, 'contest.json'), JSON.stringify(savedDoc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await link(join(temp, 'contest.json'), target);
    return { path: target, revision: contestRevision, ...(finalJudgePath ? { judge_path: finalJudgePath } : {}) };
  } catch (error) {
    if (createdJudgePath) await rm(createdJudgePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function updateContestDocument(root: string, base: string, raw: unknown, signal: AbortSignal) {
  const { path, document, judge: payload } = updateRequest.parse(raw);
  const target = await existingWorkspaceFile(base, path, 'path', root);
  if (extname(target) !== '.json') throw new FieldError(['path'], 'Contest manifest must end in .json');
  const existingBytes = await readWorkspaceFileNoFollow(target);
  let existingParsed: unknown;
  try {
    existingParsed = JSON.parse(existingBytes.toString('utf8'));
  } catch {
    throw new FieldError(['path'], 'Target file is not a valid Contest manifest');
  }
  assertContestDocument(target, existingParsed, 'path');

  const { manifest, answers, answersJson, answersHash, judgeFileName } = await prepareContestWrite(
    root,
    base,
    target,
    document,
    payload,
    signal,
  );

  const temp = await mkdtemp(join(dirname(target), '.cr-contest-'));
  let createdJudgePath: string | undefined;
  try {
    let checkManifest = manifest;
    const stagedJudge = join(temp, 'judge.json');
    if (answers && answersJson) {
      await writeFile(stagedJudge, answersJson, { mode: 0o600, flag: 'wx' });
      checkManifest = {
        ...manifest,
        judge: {
          kind: 'local',
          answers: {
            path: relative(dirname(target), stagedJudge),
            sha256: answersHash,
            redistribution: 'restricted',
          },
        },
      };
    }
    const { contest, contestRevision } = await resolveContest(checkManifest, target);
    const { statement: _statement, ...resolvedDoc } = contest;

    let finalJudgePath: string | undefined;
    let finalJudgeName = judgeFileName;
    if (answers && answersHash && judgeFileName) {
      const published = await publishImmutableJudgeFile(stagedJudge, target, judgeFileName, answersHash);
      finalJudgePath = published.answersPath;
      finalJudgeName = published.publishedFileName;
      if (published.createdNew) createdJudgePath = published.answersPath;
    }

    const savedDoc = answers && finalJudgeName
      ? {
          ...resolvedDoc,
          judge: {
            kind: 'local' as const,
            answers: {
              ...(contest.judge.kind === 'local' ? contest.judge.answers : {}),
              path: finalJudgeName,
              sha256: answersHash,
              redistribution: 'restricted' as const,
            },
          },
        }
      : resolvedDoc;

    await writeFile(join(temp, 'contest.json'), JSON.stringify(savedDoc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // Atomically replace ONLY the contest manifest; previous answer files remain intact.
    await rename(join(temp, 'contest.json'), target);
    const realBase = await realpath(base);
    return {
      path: relative(realBase, target),
      revision: contestRevision,
      ...(finalJudgePath ? { judge_path: relative(realBase, finalJudgePath) } : {}),
    };
  } catch (error) {
    if (createdJudgePath) await rm(createdJudgePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
