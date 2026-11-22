import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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
  validated,
  type ContestArtifactReader,
} from './config.js';
import { managedMaterial } from './materials.js';
import { FieldError, manifestSchema } from './agent-manifest.js';
import { importCodeforces } from './codeforces.js';
import { inspectPdf } from './pdf-synth.js';
import { protocolPresets, resolveProtocolPreset } from './protocol.js';

export const FORBIDDEN_WORKSPACE_DIRS = new Set(['node_modules', 'dist', 'coverage', 'runs']);
const MANAGED_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Linux O_PATH is not exposed by Node's fs constants. Directory descriptors only
// anchor subsequent opens, so O_PATH avoids requiring read/list permission on
// otherwise searchable (0711) ancestors while preserving O_NOFOLLOW semantics.
const LINUX_O_PATH = 0x200000;

const workspaceLocks = new Map<string, Promise<void>>();

async function acquireWorkspaceFlock(key: string) {
  const uid = process.getuid?.();
  const lockDir = join(homedir(), '.config', 'contestreplay', 'workspace-locks');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const dirInfo = await lstat(lockDir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || (uid !== undefined && dirInfo.uid !== uid)) {
    throw new Error('Workspace lock directory is invalid');
  }
  if ((dirInfo.mode & 0o077) !== 0) await chmod(lockDir, 0o700);
  const lockPath = join(lockDir, `${sha256(key).slice(0, 32)}.lock`);
  const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (uid !== undefined && info.uid !== uid)) throw new Error('Workspace lock file is invalid');
    if ((info.mode & 0o077) !== 0) await handle.chmod(0o600);
    const result = await new Promise<number | null>((resolveExit, rejectExit) => {
      const child = spawn('flock', ['-x', '-w', '10', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      child.once('error', rejectExit);
      child.once('close', resolveExit);
    }).catch(() => { throw new Error('Workspace lock unavailable'); });
    if (result !== 0) throw new Error('Workspace is busy with another Studio write; retry shortly');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function withWorkspaceLock<T>(
  base: string,
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const realBase = await resolveRealPathOrAncestor(base);
  // Publication identity is the canonical workspace, not the run root: two Studio processes
  // using different run roots must still serialize writes to the same manifest and answer table.
  const key = realBase;
  const prev = workspaceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolveLock => {
    release = resolveLock;
  });
  const tail = prev.then(() => current);
  workspaceLocks.set(key, tail);
  await prev;
  let flockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Serialize all contest publication/material deletion across both this process and
    // other CLI/Studio processes, covering answer-file creation through manifest publication/rollback.
    flockHandle = await acquireWorkspaceFlock(key);
    return await fn();
  } finally {
    if (flockHandle) await flockHandle.close().catch(() => {});
    release();
    if (workspaceLocks.get(key) === tail) {
      workspaceLocks.delete(key);
    }
  }
}

export function isForbiddenWorkspaceRelPath(relPath: string): boolean {
  if (!relPath) return false;
  const parts = relPath.split(/[\\/]+/);
  return parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || FORBIDDEN_WORKSPACE_DIRS.has(p));
}

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
  return /^(?:.*\.)?judge(?:\.[a-z0-9._-]+)?\.json$/i.test(basename(filePath));
}

export function isReservedNonManifestFilename(filePath: string): boolean {
  const lower = basename(filePath).toLowerCase();
  return lower === 'package.json' || lower === 'run.json' || isJudgeAnswerFilename(filePath);
}

export function assertAgentDocument(filePath: string, parsed: unknown, fieldName = 'path'): void {
  if (isReservedNonManifestFilename(filePath)) {
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
  if (isReservedNonManifestFilename(filePath)) {
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
  if (
    within === '..' ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within) ||
    isForbiddenWorkspaceRelPath(within) ||
    target.includes('\0')
  ) {
    throw new FieldError(['file'], 'Output must be inside the Studio workspace');
  }
  // Ensure no symlink directory segments along the path under workspace root.
  const rawParentRel = relative(root, dirname(target));
  if (rawParentRel && rawParentRel !== '..' && !rawParentRel.startsWith(`..${sep}`) && !isAbsolute(rawParentRel)) {
    if (isForbiddenWorkspaceRelPath(rawParentRel)) {
      throw new FieldError(['file'], 'Output must be inside the Studio workspace');
    }
    await assertNoSymlinkSegments(root, rawParentRel.split(sep), 'file');
  }
  const baseName = target.split(sep).at(-1)!;
  if (!baseName || baseName === '.' || baseName === '..' || baseName.startsWith('.')) {
    throw new FieldError(['file'], 'Invalid output filename');
  }
  const candidate = join(parent, baseName);
  if (isForbiddenWorkspaceRelPath(relative(root, candidate))) {
    throw new FieldError(['file'], 'Output must be inside the Studio workspace');
  }
  if (isReservedNonManifestFilename(candidate)) {
    throw new FieldError(['file'], 'Output filename is reserved');
  }
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
  if (isForbiddenWorkspaceRelPath(rawWithin)) {
    throw new FieldError([fieldName], 'Path must be inside the Studio workspace');
  }
  const rawParts = rawWithin.split(sep);
  await assertNoSymlinkSegments(root, rawParts.slice(0, -1), fieldName);
  const parent = await realpath(dirname(target)).catch(() => { throw new FieldError([fieldName], 'File not found', 404); });
  const withinParent = relative(root, parent);
  if (
    withinParent === '..' ||
    withinParent.startsWith(`..${sep}`) ||
    isAbsolute(withinParent) ||
    isForbiddenWorkspaceRelPath(withinParent)
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
  if (
    !withinTarget ||
    withinTarget === '..' ||
    withinTarget.startsWith(`..${sep}`) ||
    isAbsolute(withinTarget) ||
    isForbiddenWorkspaceRelPath(withinTarget)
  ) {
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
  // Resolve every component relative to the already-open parent directory descriptor.
  // On Linux, /proc/self/fd/<dirfd>/<component> with O_NOFOLLOW pins the actual directory
  // chain, so a parent-directory rename/symlink swap cannot redirect the opened file outside
  // the workspace tree that was validated by the caller.
  const parts = resolve(target).split(sep).filter(Boolean);
  let parent = await open('/', LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const openedDirectories = [parent];
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(
        join('/proc/self/fd', String(parent.fd), part),
        LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ).catch(() => {
        throw new FieldError([fieldName], 'Parent directory changed or traverses a symlink');
      });
      openedDirectories.push(next);
      parent = next;
    }
    const leaf = parts.at(-1);
    if (!leaf) throw new FieldError([fieldName], 'File is invalid');
    const handle = await open(
      join('/proc/self/fd', String(parent.fd), leaf),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
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
  } finally {
    for (const directory of openedDirectories.reverse()) {
      await directory.close().catch(() => {});
    }
  }
}

export async function inspectStudioPdfBytes(bytes: Buffer, displayPath: string) {
  const temp = await mkdtemp(join(tmpdir(), 'cr-studio-pdf-'));
  await chmod(temp, 0o700);
  try {
    const snapshot = join(temp, 'input.pdf');
    await writeFile(snapshot, bytes, { mode: 0o600, flag: 'wx' });
    const info = await inspectPdf(snapshot);
    return { ...info, path: displayPath };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function startsLikeJsonObject(bytes: Buffer): boolean {
  let i = 0;
  // Skip optional UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    i = 3;
  }
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
      i++;
      continue;
    }
    return b === 0x7b; // '{'
  }
  return false;
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
  forbiddenAnswers?: { fullPath?: string; sha256?: string };
}): Promise<{ fullPath: string; relativePath: string; sha256: string; bytes: Buffer }> {
  const { root, base, target, rawPath, expectedSha256, role, contestId, limit, fieldPath, forbiddenAnswers } = opts;
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
      // Allow round-tripping a previously saved relative path pointing to THIS contest's verified managed upload.
      const relInMat = relative(realMaterials, candidateFromTarget).split(sep);
      if (relInMat.length !== 3 || relInMat[0] !== contestId || relInMat[1] !== role) {
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
    if (
      (forbiddenAnswers?.fullPath && verifiedPath === forbiddenAnswers.fullPath) ||
      (forbiddenAnswers?.sha256 && digest === forbiddenAnswers.sha256)
    ) {
      throw new FieldError(fieldPath, 'Answer files cannot be attached as contest materials');
    }
    // Regardless of file extension, reject any attachment whose UTF-8 content parses as a local answer table.
    if (startsLikeJsonObject(bytes)) {
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

export async function resolveStudioContestFromParsed(
  root: string,
  base: string,
  target: string,
  parsed: unknown,
  fieldName = 'path',
) {
  assertContestDocument(target, parsed, fieldName);
  const old = legacyContestSchema.safeParse(parsed);
  const candidate = old.success
    ? {
        schema_version: 2 as const,
        contest_id: old.data.contest_id,
        data_version: old.data.data_version,
        title: old.data.title,
        source: old.data.source,
        materials: { entrypoint: { kind: 'pdf' as const, ...old.data.statement }, attachments: [] },
        judge: { kind: 'local' as const, answers: old.data.judge },
      }
    : (() => {
        const obj = parsed as Record<string, unknown>;
        if (obj.kind === 'contestreplay.dev/contest') {
          const { kind: _k, ...rest } = obj;
          return rest;
        }
        return parsed;
      })();

  const v = validated(contestSchema, candidate, target);
  const presetName = resolveProtocolPreset(v.rules);
  const pdfLimit = Math.max(40_000_000, protocolPresets[presetName].pdfMaxBytes);

  let verifiedAnswers: Awaited<ReturnType<typeof resolveStudioArtifact>> | undefined;
  if (v.judge.kind === 'local') {
    verifiedAnswers = await resolveStudioArtifact({
      root,
      base,
      target,
      rawPath: v.judge.answers.path,
      expectedSha256: v.judge.answers.sha256,
      role: 'answers',
      contestId: v.contest_id,
      limit: 4_000_000,
      fieldPath: ['judge', 'answers', 'path'],
    });
  }

  const verifiedEntrypoint = await resolveStudioArtifact({
    root,
    base,
    target,
    rawPath: v.materials.entrypoint.path,
    expectedSha256: v.materials.entrypoint.sha256,
    role: 'entrypoint',
    contestId: v.contest_id,
    limit: pdfLimit,
    fieldPath: ['materials', 'entrypoint', 'path'],
  });

  const verifiedAttachments: Array<Awaited<ReturnType<typeof resolveStudioArtifact>>> = [];
  const seenNames = new Set<string>();
  let totalAttachmentBytes = 0;
  for (let idx = 0; idx < v.materials.attachments.length; idx++) {
    const att = v.materials.attachments[idx]!;
    if (seenNames.has(att.name)) {
      throw new FieldError(['materials', 'attachments', String(idx), 'name'], 'Duplicate attachment name');
    }
    seenNames.add(att.name);
    const resolved = await resolveStudioArtifact({
      root,
      base,
      target,
      rawPath: att.path,
      expectedSha256: att.sha256,
      role: 'attachment',
      contestId: v.contest_id,
      limit: 16_000_000,
      fieldPath: ['materials', 'attachments', String(idx), 'path'],
      forbiddenAnswers: verifiedAnswers
        ? { fullPath: verifiedAnswers.fullPath, sha256: verifiedAnswers.sha256 }
        : undefined,
    });
    totalAttachmentBytes += resolved.bytes.length;
    if (totalAttachmentBytes > 32_000_000) {
      throw new FieldError(['materials', 'attachments'], 'Attachments exceed 32 MB');
    }
    verifiedAttachments.push(resolved);
  }

  let attIndex = 0;
  const memoryReader: ContestArtifactReader = async (_baseDir, _binding, _limit, role) => {
    if (role === 'entrypoint') {
      return { path: verifiedEntrypoint.fullPath, bytes: verifiedEntrypoint.bytes, hash: verifiedEntrypoint.sha256 };
    }
    if (role === 'answers' && verifiedAnswers) {
      return { path: verifiedAnswers.fullPath, bytes: verifiedAnswers.bytes, hash: verifiedAnswers.sha256 };
    }
    const nextAtt = verifiedAttachments[attIndex++];
    if (!nextAtt) throw new FieldError([fieldName], 'Unexpected attachment resolution order');
    return { path: nextAtt.fullPath, bytes: nextAtt.bytes, hash: nextAtt.sha256 };
  };

  return resolveContest(v, target, memoryReader);
}

export async function loadStudioContest(root: string, base: string, relPath: string, fieldName = 'path') {
  const target = await existingWorkspaceFile(base, relPath, fieldName, root);
  if (extname(target) !== '.json') {
    throw new FieldError([fieldName], 'Contest manifest must end in .json');
  }
  const bytes = await readWorkspaceFileNoFollow(target, 1_000_000, fieldName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new FieldError([fieldName], 'Invalid contest JSON');
  }
  const resolved = await resolveStudioContestFromParsed(root, base, target, parsed, fieldName);
  return { target, parsed, ...resolved };
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
  if (isReservedNonManifestFilename(target)) throw new FieldError(['file'], 'Contest output filename is reserved');
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

  // Resolve judge FIRST so attachments can be checked against the verified local answer file & digest.
  const judge = z.object({ kind: z.enum(['local', 'codeforces', 'qoj', 'vjudge', 'hydro']) }).loose().parse(document.judge);
  let problems = document.problems;
  const rules = document.rules;
  let cfPointsKnown: boolean | undefined;
  let resolvedJudge: unknown = document.judge;
  let answersBytes: Buffer | undefined;
  let answersHash: string | undefined;
  let answersRedistribution: 'allowed' | 'restricted' | 'unknown' = 'restricted';
  let judgeFileName: string | undefined;
  let sourceAnswersFullPath: string | undefined;

  if (
    judge.kind === 'local' &&
    (payload || Array.isArray(judge.problems) || (Array.isArray(problems) && problems.some(p => p && Object.hasOwn(p, 'accepted_answers'))))
  ) {
    authoredJudge.parse(document.judge);
    if (payload && judge.problems) throw new FieldError(['judge'], 'Only one local answer table may be supplied');
    const answers = judgeSchema.parse(payload ?? { schema_version: 1, problems: judge.problems ?? problems });
    if (!payload && !judge.problems) problems = undefined;
    problems ??= answers.problems.map(({ id, max_points }) => ({ id, max_points }));
    answersBytes = Buffer.from(JSON.stringify(answers, null, 2) + '\n', 'utf8');
    answersHash = sha256(answersBytes);
    answersRedistribution = 'restricted';
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
    sourceAnswersFullPath = verifiedAnswers.fullPath;
    answersBytes = verifiedAnswers.bytes;
    answersHash = verifiedAnswers.sha256;
    answersRedistribution = existingLocal.answers.redistribution ?? 'restricted';
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

  if (answersBytes && answersHash) {
    const stem = basename(target, '.json');
    judgeFileName = `${stem}.judge.${answersHash.slice(0, 12)}.json`;
    const answersPath = join(dirname(target), judgeFileName);
    if (answersPath === target) throw new FieldError(['file'], `Contest cannot be named ${judgeFileName}`);
    resolvedJudge = {
      kind: 'local',
      answers: {
        path: judgeFileName,
        sha256: answersHash,
        redistribution: answersRedistribution,
      },
    };
  }

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
    fullPath: string;
    sha256: string;
    bytes: Buffer;
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
      forbiddenAnswers: answersHash ? { fullPath: sourceAnswersFullPath, sha256: answersHash } : undefined,
    });
    totalAttachmentBytes += resolved.bytes.length;
    if (totalAttachmentBytes > 32_000_000) {
      throw new FieldError(['materials', 'attachments'], 'Attachments exceed 32 MB');
    }
    verifiedAttachments.push({
      path: resolved.relativePath,
      fullPath: resolved.fullPath,
      sha256: resolved.sha256,
      bytes: resolved.bytes,
      redistribution: item.redistribution ?? 'unknown',
      name: item.name ?? item.path.split('/').at(-1),
    });
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
      attachments: verifiedAttachments.map(({ path: p, sha256: s, redistribution: r, name: n }) => ({
        path: p,
        sha256: s,
        redistribution: r,
        name: n,
      })),
    },
    judge: resolvedJudge,
  });

  const makeArtifactReader = (stagedJudgePath?: string): ContestArtifactReader => {
    let attIdx = 0;
    return async (_baseDir, _binding, _limit, role) => {
      if (role === 'entrypoint') {
        return { path: verifiedEntrypoint.fullPath, bytes: verifiedEntrypoint.bytes, hash: verifiedEntrypoint.sha256 };
      }
      if (role === 'answers' && answersBytes && answersHash) {
        return { path: stagedJudgePath ?? join(dirname(target), judgeFileName!), bytes: answersBytes, hash: answersHash };
      }
      const nextAtt = verifiedAttachments[attIdx++];
      if (!nextAtt) throw new FieldError(['materials', 'attachments'], 'Unexpected attachment resolution order');
      return { path: nextAtt.fullPath, bytes: nextAtt.bytes, hash: nextAtt.sha256 };
    };
  };

  return {
    manifest,
    answersBytes,
    answersHash,
    answersRedistribution,
    judgeFileName,
    makeArtifactReader,
  };
}

async function publishImmutableJudgeFile(
  stagedJudgePath: string,
  target: string,
  judgeFileName: string,
  answersHash: string,
): Promise<{ answersPath: string; publishedFileName: string; createdByThisCall: boolean }> {
  const dir = dirname(target);
  const preferredPath = join(dir, judgeFileName);
  try {
    await link(stagedJudgePath, preferredPath);
    return { answersPath: preferredPath, publishedFileName: judgeFileName, createdByThisCall: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    // Reuse if identical immutable content already exists; otherwise pick a fresh collision-free name.
    const existingBytes = await readWorkspaceFileNoFollow(preferredPath, 4_000_000, 'judge').catch(() => undefined);
    if (existingBytes && sha256(existingBytes) === answersHash) {
      return { answersPath: preferredPath, publishedFileName: judgeFileName, createdByThisCall: false };
    }
    const stem = basename(target, '.json');
    const uniqueName = `${stem}.judge.${answersHash.slice(0, 12)}-${randomUUID().slice(0, 8)}.json`;
    const uniquePath = join(dir, uniqueName);
    await link(stagedJudgePath, uniquePath);
    return { answersPath: uniquePath, publishedFileName: uniqueName, createdByThisCall: true };
  }
}

export async function createContestDocument(root: string, base: string, raw: unknown, signal: AbortSignal) {
  return withWorkspaceLock(base, root, async () => {
    const { file, document, judge: payload } = authorRequest.parse(raw);
    const managed = !file;
    const contestId = id.parse(document.contest_id);
    if (managed) {
      await mkdir(join(base, 'contests'), { recursive: true });
    }
    const target = await outputPath(base, file ?? `contests/${contestId}.json`, root);
    const { manifest, answersBytes, answersHash, answersRedistribution, judgeFileName, makeArtifactReader } =
      await prepareContestWrite(root, base, target, document, payload, signal);

    // Stage private data beside its destination. No existing file is overwritten.
    const temp = await mkdtemp(join(dirname(target), '.cr-contest-'));
    let createdJudgePath: string | undefined;
    try {
      const stagedJudge = join(temp, 'judge.json');
      if (answersBytes && answersHash) {
        await writeFile(stagedJudge, answersBytes, { mode: 0o600, flag: 'wx' });
      }
      const { contest, contestRevision } = await resolveContest(manifest, target, makeArtifactReader(stagedJudge));
      const { statement: _statement, ...resolvedDoc } = contest;

      let finalJudgePath: string | undefined;
      let finalJudgeName = judgeFileName;
      if (answersBytes && answersHash && judgeFileName) {
        const published = await publishImmutableJudgeFile(stagedJudge, target, judgeFileName, answersHash);
        finalJudgePath = published.answersPath;
        finalJudgeName = published.publishedFileName;
        if (published.createdByThisCall) createdJudgePath = published.answersPath;
      }

      const savedDoc = answersBytes && finalJudgeName
        ? {
            ...resolvedDoc,
            judge: {
              kind: 'local' as const,
              answers: {
                ...(contest.judge.kind === 'local' ? contest.judge.answers : {}),
                path: finalJudgeName,
                sha256: answersHash,
                redistribution: answersRedistribution,
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
  });
}

export async function updateContestDocument(root: string, base: string, raw: unknown, signal: AbortSignal) {
  return withWorkspaceLock(base, root, async () => {
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

    const { manifest, answersBytes, answersHash, answersRedistribution, judgeFileName, makeArtifactReader } =
      await prepareContestWrite(root, base, target, document, payload, signal);

    const temp = await mkdtemp(join(dirname(target), '.cr-contest-'));
    let createdJudgePath: string | undefined;
    try {
      const stagedJudge = join(temp, 'judge.json');
      if (answersBytes && answersHash) {
        await writeFile(stagedJudge, answersBytes, { mode: 0o600, flag: 'wx' });
      }
      const { contest, contestRevision } = await resolveContest(manifest, target, makeArtifactReader(stagedJudge));
      const { statement: _statement, ...resolvedDoc } = contest;

      let finalJudgePath: string | undefined;
      let finalJudgeName = judgeFileName;
      if (answersBytes && answersHash && judgeFileName) {
        const published = await publishImmutableJudgeFile(stagedJudge, target, judgeFileName, answersHash);
        finalJudgePath = published.answersPath;
        finalJudgeName = published.publishedFileName;
        if (published.createdByThisCall) createdJudgePath = published.answersPath;
      }

      const savedDoc = answersBytes && finalJudgeName
        ? {
            ...resolvedDoc,
            judge: {
              kind: 'local' as const,
              answers: {
                ...(contest.judge.kind === 'local' ? contest.judge.answers : {}),
                path: finalJudgeName,
                sha256: answersHash,
                redistribution: answersRedistribution,
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
  });
}
