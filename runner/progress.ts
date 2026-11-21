import { constants } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveContest, sha256 } from './config.js';

export const scoringModeSchema = z.enum(['icpc', 'cf', 'ioi', 'last_ac']);
export type ScoringMode = z.infer<typeof scoringModeSchema>;

export const problemStatusSchema = z.enum(['unattempted', 'pending', 'accepted', 'partial', 'wrong']);
export type ProblemStatus = z.infer<typeof problemStatusSchema>;

const count = z.number().int().nonnegative();
const points = z.number().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const runProgressProblemSchema = z.strictObject({
  id: z.string().min(1),
  max_points: points,
  attempts: count,
  status: problemStatusSchema,
  best_score: points,
  first_ac_ms: count.optional(),
  last_verdict: z.string().optional(),
  last_elapsed_ms: count.optional(),
});
export type RunProgressProblem = z.infer<typeof runProgressProblemSchema>;

export const runProgressActivitySchema = z.strictObject({
  seq: count,
  elapsed_ms: count,
  type: z.string().min(1),
  summary: z.string(),
  problem_id: z.string().optional(),
  submission_id: z.string().optional(),
  language: z.string().optional(),
  verdict: z.string().optional(),
  score: points.optional(),
  turn: count.optional(),
});
export type RunProgressActivity = z.infer<typeof runProgressActivitySchema>;

export const runProgressTelemetrySchema = z.strictObject({
  model_turns: count,
  total_model_wait_ms: count,
  total_input_tokens: count,
  total_output_tokens: count,
});
export type RunProgressTelemetry = z.infer<typeof runProgressTelemetrySchema>;

export const runProgressSchema = z.strictObject({
  run_id: z.uuid(),
  status: z.enum(['running', 'completed', 'void', 'unknown']),
  reason: z.string().optional(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  contest_id: z.string().min(1),
  contest_title: z.string().optional(),
  data_version: count,
  scoring_mode: scoringModeSchema.optional(),
  started_at: z.string().optional(),
  elapsed_ms: count,
  time_limit_ms: count,
  remaining_ms: count,
  submissions_used: count,
  max_submissions: count,
  model_turns: count,
  last_activity_ms: count,
  last_activity_type: z.string().optional(),
  score: points,
  max_score: points,
  solved_count: count,
  problem_count: count,
  problem_breakdown_unavailable: z.boolean().optional(),
  problems: z.array(runProgressProblemSchema),
  recent_activity: z.array(runProgressActivitySchema),
  telemetry: runProgressTelemetrySchema,
});
export type RunProgress = z.infer<typeof runProgressSchema>;

export const liveRunSummarySchema = z.strictObject({
  solved_count: count,
  problem_count: count,
  score: points,
  max_score: points,
  remaining_ms: count,
  last_submission: z.strictObject({
    problem_id: z.string().min(1),
    verdict: z.string().min(1),
    elapsed_ms: count,
  }).optional(),
  active: z.boolean(),
});
export type LiveRunSummary = z.infer<typeof liveRunSummarySchema>;

export const logSliceSchema = z.strictObject({
  stream: z.enum(['stdout', 'stderr']),
  offset: count,
  next_offset: count,
  total_bytes: count,
  has_more: z.boolean(),
  chunk: z.string(),
});
export type LogSlice = z.infer<typeof logSliceSchema>;

export const replaySubmissionSchema = z.strictObject({
  submission_id: z.string().min(1),
  problem_id: z.string().min(1),
  received_ms: count,
  judged_ms: count.optional(),
  verdict: z.string().min(1),
  score: points.optional(),
  max_points: points.optional(),
  language: z.string().optional(),
});
export type ReplaySubmission = z.infer<typeof replaySubmissionSchema>;

export const replayFrameKindSchema = z.enum([
  'run_started',
  'submission_received',
  'submission_judged',
  'model_turn',
  'settling',
  'judge_error',
  'finish',
  'run_ended',
]);

export const replayFrameSchema = z.strictObject({
  seq: count,
  elapsed_ms: count,
  kind: replayFrameKindSchema,
  summary: z.string(),
  problem_id: z.string().optional(),
  submission_id: z.string().optional(),
  language: z.string().optional(),
  verdict: z.string().optional(),
  score: points.optional(),
  points_awarded: points.optional(),
  turn: count.optional(),
  duration_ms: count.optional(),
  input_tokens: count.optional(),
  output_tokens: count.optional(),
  source: z.string().optional(),
  diff: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  cumulative_score: points,
  solved_count: count,
});
export type ReplayFrame = z.infer<typeof replayFrameSchema>;

export const sessionSummarySchema = z.strictObject({
  file: z.string().min(1),
  entries: z.array(z.strictObject({
    index: count,
    role: z.string().optional(),
    type: z.string().optional(),
    timestamp: z.string().optional(),
    summary: z.string(),
  })),
  truncated: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const problemMetaSchema = z.strictObject({
  id: z.string().min(1),
  max_points: points,
});
export type ProblemMeta = z.infer<typeof problemMetaSchema>;

export const runReplaySchema = z.strictObject({
  run_id: z.uuid(),
  status: z.enum(['running', 'completed', 'void', 'unknown']),
  reason: z.string().optional(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  contest_id: z.string().min(1),
  contest_title: z.string().optional(),
  data_version: count,
  contest_revision: digest.optional(),
  protocol_id: z.string().min(1).optional(),
  protocol_version: count.optional(),
  protocol_sha256: digest.optional(),
  scoring_mode: scoringModeSchema,
  started_at: z.string().optional(),
  time_limit_ms: count,
  duration_ms: count,
  problem_breakdown_unavailable: z.boolean().optional(),
  problems: z.array(problemMetaSchema),
  submissions: z.array(replaySubmissionSchema),
  frames: z.array(replayFrameSchema),
  telemetry: runProgressTelemetrySchema,
  session_summaries: z.array(sessionSummarySchema).optional(),
});
export type RunReplay = z.infer<typeof runReplaySchema>;

export const projectedProblemSchema = z.strictObject({
  id: z.string().min(1),
  status: problemStatusSchema,
  attempts: count,
  wrong_attempts: count,
  score: points,
  max_points: points,
  first_ac_ms: count.optional(),
  last_verdict: z.string().optional(),
});
export type ProjectedProblem = z.infer<typeof projectedProblemSchema>;

export const scoreProjectionSchema = z.strictObject({
  at_elapsed_ms: count,
  scoring_mode: scoringModeSchema,
  score: points,
  max_score: points,
  penalty: count,
  penalty_ms: count,
  solved_count: count,
  last_ac_ms: count,
  submissions_used: count,
  problems: z.array(projectedProblemSchema),
});
export type ScoreProjection = z.infer<typeof scoreProjectionSchema>;

export const ghostRaceParticipantSchema = z.strictObject({
  run_id: z.uuid(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  status: z.enum(['running', 'completed', 'void', 'unknown']),
  time_limit_ms: count,
  duration_ms: count,
  final_score: points,
  final_solved_count: count,
  final_penalty: count,
  submissions: z.array(replaySubmissionSchema),
});
export type GhostRaceParticipant = z.infer<typeof ghostRaceParticipantSchema>;

export const ghostRaceMilestoneSchema = z.strictObject({
  elapsed_ms: count,
  run_id: z.uuid(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  seq: count,
  kind: z.enum(['submission_received', 'submission_judged', 'finish', 'run_ended']),
  problem_id: z.string().optional(),
  submission_id: z.string().optional(),
  language: z.string().optional(),
  verdict: z.string().optional(),
  score: points.optional(),
  summary: z.string(),
});
export type GhostRaceMilestone = z.infer<typeof ghostRaceMilestoneSchema>;

export const ghostRaceStandingSchema = z.strictObject({
  rank: z.number().int().positive().nullable(),
  status: z.enum(['running', 'completed', 'void', 'unknown']),
  provisional: z.boolean(),
  unranked: z.boolean(),
  run_id: z.uuid(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  score: points,
  max_score: points,
  solved_count: count,
  penalty: count,
  penalty_ms: count,
  last_ac_ms: count,
  submissions_used: count,
  finished: z.boolean(),
  problems: z.array(projectedProblemSchema),
});
export type GhostRaceStanding = z.infer<typeof ghostRaceStandingSchema>;

export const ghostRaceSnapshotSchema = z.strictObject({
  at_elapsed_ms: count,
  scoring_mode: scoringModeSchema,
  standings: z.array(ghostRaceStandingSchema),
});
export type GhostRaceSnapshot = z.infer<typeof ghostRaceSnapshotSchema>;

export const ghostRaceSchema = z.strictObject({
  contest_id: z.string().min(1),
  contest_title: z.string().optional(),
  data_version: count,
  contest_revision: digest,
  protocol_id: z.string().min(1),
  protocol_version: count,
  protocol_sha256: digest,
  time_limit_ms: count,
  timeline_end_ms: count,
  scoring_mode: scoringModeSchema,
  problems: z.array(problemMetaSchema).min(1),
  participants: z.array(ghostRaceParticipantSchema).min(1).max(8),
  milestones: z.array(ghostRaceMilestoneSchema),
  samples: z.array(ghostRaceSnapshotSchema).optional(),
});
export type GhostRaceData = z.infer<typeof ghostRaceSchema>;
export type GhostRace = GhostRaceData & {
  evaluateAt: (atElapsedMs: number, scoringMode?: ScoringMode) => GhostRaceSnapshot;
};

const runMetaSchema = z.object({
  run_id: z.uuid(),
  created_at: z.string().optional(),
  contest_id: z.string().min(1),
  contest_title: z.string().optional(),
  data_version: count.default(1),
  contest_revision: digest.optional(),
  protocol_id: z.string().min(1).optional(),
  protocol_version: count.optional(),
  protocol_sha256: digest.optional(),
  input_sha256: z.object({
    contest: digest.optional(),
    pdf: digest.optional(),
    judge: digest.optional(),
  }).optional(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  scoring_mode: scoringModeSchema.optional(),
  rules: z.object({
    time_limit_ms: count.optional(),
    max_submissions: count.optional(),
    scoring_mode: scoringModeSchema.optional(),
  }).optional(),
  problems: z.array(z.object({
    id: z.string().min(1),
    max_points: points,
  })).optional(),
  max_score: points.optional(),
  local_inputs: z.object({
    contest: z.string().optional(),
    judge: z.string().optional(),
  }).optional(),
});

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function toNonNegInt(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function toNonNegNum(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[\x21-\x7e]+/gi, 'Bearer [REDACTED]'],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}\b/g, '[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/("(?:api[_-]?key|token|secret|password|cookie|authorization)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2'],
  [/\b(api[_-]?key|token|secret|password|cookie|authorization)\s*([:=])\s*[^\s,;'"`]+/gi, '$1$2[REDACTED]'],
];

const HOST_PATH_PATTERNS: RegExp[] = [
  /(?:^|[\s([{'",=:]|file:\/\/)((?:\/(?:home|Users|tmp|var|etc|root|opt|srv|private|mnt|media|run))(?:\/[^\s)\]}'"`,;]+)+)/g,
  /(?:^|[\s([{'",=:]|file:\/\/\/?)([A-Za-z]:\\[^\s)\]}'"`,;]+)/g,
];

function sanitizeString(input: string, redactPaths = true): string {
  let text = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (redactPaths) {
    for (const pattern of HOST_PATH_PATTERNS) {
      text = text.replace(pattern, (full, captured: string) => full.replace(captured, '[path]'));
    }
  }
  return text;
}

function sanitizeSource(source: string): string {
  const capped = source.length > 200_000 ? source.slice(0, 200_000) + '\n/* [truncated] */' : source;
  return sanitizeString(capped, false);
}

function isAcceptedVerdict(verdict: string): boolean {
  const v = verdict.trim().toLowerCase();
  return v === 'accepted' || v === 'ac' || v === 'ok';
}

function isAlreadyAcceptedVerdict(verdict: string): boolean {
  return verdict.trim().toLowerCase() === 'already_accepted';
}

function isInvalidSubmissionVerdict(verdict: string): boolean {
  return verdict.trim().toLowerCase() === 'invalid_submission';
}

function isPendingVerdict(verdict: string): boolean {
  const v = verdict.trim().toLowerCase();
  return v === 'pending' || v === 'testing' || v === 'queued' || v === 'running' || v === 'judging';
}

function isExplicitWrongVerdict(verdict: string): boolean {
  const v = verdict.trim().toLowerCase();
  return [
    'wrong_answer',
    'wa',
    'time_limit_exceeded',
    'tle',
    'memory_limit_exceeded',
    'mle',
    'runtime_error',
    're',
    'compilation_error',
    'ce',
    'compile_error',
    'invalid_submission',
    'presentation_error',
    'pe',
    'output_limit_exceeded',
    'ole',
    'rejected',
  ].includes(v);
}

function isNoPenaltyVerdict(verdict: string): boolean {
  const v = verdict.trim().toLowerCase();
  return [
    'compilation_error',
    'ce',
    'compile_error',
    'invalid_submission',
    'already_accepted',
    'contest_closed',
    'submission_limit',
    'judge_unavailable',
    'skipped',
  ].includes(v);
}

function formatShortVerdict(verdict: string): string {
  const v = verdict.trim();
  return v.length > 48 ? v.slice(0, 48) : v;
}

// Directory-handle-anchored file access eliminates lstat -> open/readdir TOCTOU races.
interface PinnedDir {
  handle: FileHandle;
  path: string;
  dev: number | bigint;
  ino: number | bigint;
  close: () => Promise<void>;
}

async function openPinnedDir(dirPath: string): Promise<PinnedDir> {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(dirPath, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new Error('Expected a real directory (symlinks are not allowed)');
    }
    throw error;
  }
  const info = await handle.stat();
  if (!info.isDirectory()) {
    await handle.close();
    throw new Error('Expected a real directory (symlinks are not allowed)');
  }
  return {
    handle,
    path: dirPath,
    dev: info.dev,
    ino: info.ino,
    close: () => handle.close(),
  };
}

async function verifyDirIdentityNonLinux(dir: PinnedDir): Promise<void> {
  const current = await lstat(dir.path);
  if (!current.isDirectory() || current.dev !== dir.dev || current.ino !== dir.ino) {
    throw new Error('Directory changed or became a symlink while reading');
  }
}

async function openChildInPinnedDir(
  dir: PinnedDir,
  childName: string,
  flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
): Promise<FileHandle> {
  if (!childName || childName.includes('/') || childName.includes('\\') || childName === '.' || childName === '..') {
    throw new Error('Invalid child entry name');
  }
  if (process.platform === 'linux') {
    try {
      return await open(`/proc/self/fd/${dir.handle.fd}/${childName}`, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ELOOP' || (code === 'ENOTDIR' && (flags & constants.O_DIRECTORY) !== 0)) {
        throw new Error('Expected a real entry (symlinks are not allowed)');
      }
      throw error;
    }
  }
  await verifyDirIdentityNonLinux(dir);
  const child = await open(join(dir.path, childName), flags);
  try {
    await verifyDirIdentityNonLinux(dir);
    return child;
  } catch (error) {
    await child.close();
    throw error;
  }
}

async function openChildPinnedDir(parent: PinnedDir, childName: string): Promise<PinnedDir> {
  const handle = await openChildInPinnedDir(
    parent,
    childName,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const info = await handle.stat();
  if (!info.isDirectory()) {
    await handle.close();
    throw new Error('Expected a real directory (symlinks are not allowed)');
  }
  return {
    handle,
    path: join(parent.path, childName),
    dev: info.dev,
    ino: info.ino,
    close: () => handle.close(),
  };
}

async function readdirPinned(dir: PinnedDir) {
  if (process.platform === 'linux') {
    return readdir(`/proc/self/fd/${dir.handle.fd}`, { withFileTypes: true });
  }
  await verifyDirIdentityNonLinux(dir);
  const entries = await readdir(dir.path, { withFileTypes: true });
  await verifyDirIdentityNonLinux(dir);
  return entries;
}

async function readAllFromHandle(handle: FileHandle, limit: number): Promise<Buffer> {
  const info = await handle.stat();
  if (!info.isFile() || info.size > limit) throw new Error('File is invalid or exceeds size limit');
  const bytes = Buffer.alloc(info.size + 1);
  let read = 0;
  while (read < bytes.length) {
    const res = await handle.read(bytes, read, bytes.length - read, read);
    if (!res.bytesRead) break;
    read += res.bytesRead;
  }
  if (read !== info.size) throw new Error('File changed while reading');
  return bytes.subarray(0, read);
}

async function readRegularFileNoFollow(filePath: string, limit: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    return await readAllFromHandle(handle, limit);
  } finally {
    await handle.close();
  }
}

async function readChildJson(dir: PinnedDir, childName: string, limit: number): Promise<unknown> {
  const handle = await openChildInPinnedDir(dir, childName);
  try {
    const bytes = await readAllFromHandle(handle, limit);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

async function discoverProblemsFromLocalInputs(
  localInputs?: { contest?: string; judge?: string },
  inputSha256?: { contest?: string; judge?: string },
): Promise<ProblemMeta[]> {
  if (!localInputs) return [];

  // 1. Prefer production resolveContest() to compute the canonical contestDigest and verify against input_sha256.contest.
  if (localInputs.contest && inputSha256?.contest) {
    try {
      const bytes = await readRegularFileNoFollow(localInputs.contest, 1_000_000);
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      const resolved = await resolveContest(parsed, localInputs.contest);
      if (resolved.contestDigest === inputSha256.contest && resolved.contest.problems.length > 0) {
        return resolved.contest.problems.map(({ id, max_points }) => ({ id, max_points }));
      }
    } catch { /* fallback to verified local judge below */ }
  }

  // 2. Fallback for local answer contests where contest.json/PDF moved but judge.json matches input_sha256.judge.
  if (localInputs.judge && inputSha256?.judge) {
    try {
      const bytes = await readRegularFileNoFollow(localInputs.judge, 4_000_000);
      if (sha256(bytes) === inputSha256.judge) {
        const raw = JSON.parse(bytes.toString('utf8')) as unknown;
        if (raw && typeof raw === 'object' && 'problems' in raw && Array.isArray(raw.problems)) {
          const list: ProblemMeta[] = [];
          for (const item of raw.problems) {
            if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
              const rec = item as Record<string, unknown>;
              const id = (rec.id as string).trim();
              const maxPoints = toNonNegNum(rec.max_points);
              if (id && maxPoints !== undefined) list.push({ id, max_points: maxPoints });
            }
          }
          if (list.length > 0) return list;
        }
      }
    } catch { /* untrusted or missing local judge */ }
  }
  return [];
}

interface RawEvent {
  seq: number;
  elapsed_ms: number;
  type: string;
  raw: Record<string, unknown>;
}

const MAX_EVENT_LINE_BYTES = 4 * 1024 * 1024;
const MAX_REPLAY_SOURCE_DIFF_BYTES = 2 * 1024 * 1024;

// Single-pass streaming event reader aligned with runner/results.ts exportRun integrity checks.
async function forEachRunEvent(
  runDir: PinnedDir,
  includeSources: boolean,
  onEvent: (event: RawEvent) => void,
): Promise<number> {
  let handle: FileHandle;
  try {
    handle = await openChildInPinnedDir(runDir, 'events.jsonl');
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }

  let countEvents = 0;
  let buffer = '';
  let skipUntilNewline = false;
  let lastSeq = 0;
  let sawRunEnded = false;

  const consumeLine = (line: string, isTrailingUnfinished: boolean) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (isTrailingUnfinished) return;
      throw new Error('Corrupted run event log: malformed JSON record');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (isTrailingUnfinished) return;
      throw new Error('Corrupted run event log: expected JSON object');
    }
    const rec = parsed as Record<string, unknown>;
    if (sawRunEnded) {
      throw new Error('Corrupted run event log: unexpected event after run_ended');
    }
    if (rec.schema_version !== 1) {
      if (isTrailingUnfinished) return;
      throw new Error('Corrupted run event log: invalid or missing schema_version');
    }
    if (typeof rec.type !== 'string' || !rec.type.trim()) {
      if (isTrailingUnfinished) return;
      throw new Error('Corrupted run event log: missing event type');
    }
    if (typeof rec.seq !== 'number' || !Number.isInteger(rec.seq) || rec.seq !== lastSeq + 1) {
      if (isTrailingUnfinished && rec.seq === undefined) return;
      throw new Error(`Corrupted run event log: invalid sequence number (expected ${lastSeq + 1})`);
    }
    lastSeq = rec.seq;
    if (rec.type === 'run_ended') sawRunEnded = true;

    const elapsed_ms = toNonNegInt(rec.elapsed_ms, 0);
    const { answer: _droppedAnswer, output: _droppedOutput, source: rawSource, ...rest } = rec;
    if (includeSources && typeof rawSource === 'string') {
      rest.source = rawSource;
    }
    countEvents++;
    onEvent({ seq: rec.seq, elapsed_ms, type: rec.type, raw: rest });
  };

  try {
    const info = await handle.stat();
    if (!info.isFile()) return 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const decoder = new TextDecoder('utf-8');
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const decoded = decoder.decode(chunk.subarray(0, bytesRead), { stream: true });

      if (skipUntilNewline) {
        const nl = decoded.indexOf('\n');
        if (nl === -1) continue;
        skipUntilNewline = false;
        throw new Error('Corrupted run event log: event line exceeded maximum length');
      }

      buffer += decoded;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        consumeLine(line, false);
      }
      if (buffer.length > MAX_EVENT_LINE_BYTES) {
        buffer = '';
        skipUntilNewline = true;
      }
    }
    buffer += decoder.decode();
    if (!skipUntilNewline && buffer.trim()) {
      consumeLine(buffer, true);
    }
  } finally {
    await handle.close();
  }
  return countEvents;
}

class ActivityRingBuffer {
  private readonly items: Array<RunProgressActivity | undefined>;
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.items = capacity > 0 ? new Array(capacity) : [];
  }

  push(item: RunProgressActivity) {
    if (this.capacity <= 0) return;
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  toNewestFirst(): RunProgressActivity[] {
    const out: RunProgressActivity[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      out.push(this.items[idx]!);
    }
    return out;
  }
}

function extractUsage(usage: unknown): { input?: number; output?: number } {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return {};
  const rec = usage as Record<string, unknown>;
  const input = toNonNegNum(rec.input_tokens) ?? toNonNegNum(rec.prompt_tokens);
  const output = toNonNegNum(rec.output_tokens) ?? toNonNegNum(rec.completion_tokens);
  return {
    input: input !== undefined ? Math.floor(input) : undefined,
    output: output !== undefined ? Math.floor(output) : undefined,
  };
}

function buildSafeActivitySummary(
  event: RawEvent,
  problemId?: string,
  language?: string,
  verdict?: string,
  awarded?: number,
  turn?: number,
): string {
  const safeProb = problemId ? problemId.slice(0, 64) : undefined;
  const safeLang = language ? language.slice(0, 40) : undefined;
  const safeVerdict = verdict ? formatShortVerdict(verdict) : undefined;
  switch (event.type) {
    case 'run_started':
      return 'Contest run started';
    case 'model_request':
      return turn !== undefined ? `Model turn ${turn} requested` : 'Model turn requested';
    case 'model_response':
      return turn !== undefined ? `Model turn ${turn} responded` : 'Model turn responded';
    case 'model_identity':
      return turn !== undefined ? `Model turn ${turn} identified` : 'Model identified';
    case 'model_usage':
      return turn !== undefined ? `Model turn ${turn} usage recorded` : 'Model usage recorded';
    case 'model_request_rejected':
      return 'Model request rejected';
    case 'tool_call': {
      const tool = typeof event.raw.tool === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(event.raw.tool) ? event.raw.tool : 'tool';
      return `Tool call: ${tool}`;
    }
    case 'tool_rejected':
      return 'Tool call rejected';
    case 'submission_received':
      return `Submitted ${safeProb ?? 'problem'}${safeLang ? ` (${safeLang})` : ''}`;
    case 'submission_delivered':
      return `Delivered submission${typeof event.raw.submission_id === 'string' ? ` ${event.raw.submission_id.slice(0, 32)}` : ''}`;
    case 'submission_judged': {
      const scoreSuffix = awarded !== undefined && awarded > 0 ? ` (+${awarded})` : '';
      return `Judged ${safeProb ?? 'submission'}: ${safeVerdict ?? 'unknown'}${scoreSuffix}`;
    }
    case 'settling':
      return 'Settling pending submissions';
    case 'judge_error':
      return 'Judge infrastructure error';
    case 'finish':
      return 'Agent called finish';
    case 'run_ended': {
      const st = typeof event.raw.status === 'string' && ['completed', 'void'].includes(event.raw.status) ? event.raw.status : 'ended';
      const reason = typeof event.raw.reason === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(event.raw.reason)
        ? ` (${event.raw.reason})` : '';
      return `Run ${st}${reason}`;
    }
    default:
      return `Event: ${event.type.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48) || 'unknown'}`;
  }
}

export function unifiedLineDiff(prev: string, next: string, labelA = 'previous', labelB = 'current'): string {
  const a = prev.replace(/\r\n/g, '\n').split('\n');
  const b = next.replace(/\r\n/g, '\n').split('\n');
  if (a.length === b.length && a.every((line, idx) => line === b[idx])) return '';

  if (a.length > 2000 || b.length > 2000 || a.length * b.length > 400_000) {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < a.length - prefix &&
      suffix < b.length - prefix &&
      a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
      suffix++;
    }
    const delCount = a.length - prefix - suffix;
    const addCount = b.length - prefix - suffix;
    const lines = [
      `--- ${labelA}`,
      `+++ ${labelB}`,
      `@@ -${prefix + 1},${delCount} +${prefix + 1},${addCount} @@`,
    ];
    for (let i = prefix; i < a.length - suffix; i++) lines.push(`-${a[i]!}`);
    for (let i = prefix; i < b.length - suffix; i++) lines.push(`+${b[i]!}`);
    return lines.join('\n');
  }

  const n = a.length;
  const m = b.length;
  const stride = m + 1;
  const dp = new Uint32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    const rowOff = i * stride;
    const nextOff = (i + 1) * stride;
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[rowOff + j] = dp[nextOff + j + 1]! + 1;
      else dp[rowOff + j] = Math.max(dp[nextOff + j]!, dp[rowOff + j + 1]!);
    }
  }

  type Op = { kind: ' ' | '-' | '+'; line: string; oldLine: number; newLine: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]!, oldLine: oldLine++, newLine: newLine++ });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!) {
      ops.push({ kind: '-', line: a[i]!, oldLine: oldLine++, newLine });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j]!, oldLine, newLine: newLine++ });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: a[i]!, oldLine: oldLine++, newLine });
    i++;
  }
  while (j < m) {
    ops.push({ kind: '+', line: b[j]!, oldLine, newLine: newLine++ });
    j++;
  }

  const context = 3;
  const changeIndices = ops.map((op, idx) => (op.kind !== ' ' ? idx : -1)).filter(idx => idx !== -1);
  if (!changeIndices.length) return '';

  const hunks: Array<{ start: number; end: number }> = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const prevHunk = hunks[hunks.length - 1];
    if (prevHunk && start <= prevHunk.end + 1) prevHunk.end = Math.max(prevHunk.end, end);
    else hunks.push({ start, end });
  }

  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const hunk of hunks) {
    const slice = ops.slice(hunk.start, hunk.end + 1);
    const first = slice[0]!;
    const oldStart = first.oldLine;
    const newStart = first.newLine;
    const oldCount = slice.filter(op => op.kind !== '+').length;
    const newCount = slice.filter(op => op.kind !== '-').length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.line}`);
  }
  return out.join('\n');
}

function projectSingleProblem(
  problem: ProblemMeta,
  subs: ReplaySubmission[],
  timeLimitMs: number,
  t: number,
  scoringMode: ScoringMode,
) {
  const list = subs.slice().sort((a, b) => a.received_ms - b.received_ms);
  let attempts = 0;
  let wrongBeforeAc = 0;
  let isAccepted = false;
  let firstAcMs: number | undefined;
  let bestPartial = 0;
  let lastImprovement = 0;
  let hasPending = false;
  let lastVerdict: string | undefined;

  for (const sub of list) {
    attempts++;
    const verdictKnown = !isPendingVerdict(sub.verdict) && (
      sub.judged_ms === undefined ? true : sub.judged_ms <= t
    );
    if (!verdictKnown) {
      hasPending = true;
      if (!isAccepted) lastVerdict = 'pending';
      continue;
    }

    if (!isAccepted) lastVerdict = sub.verdict;
    const explicitWrong = isExplicitWrongVerdict(sub.verdict);
    const rawPoints = sub.score !== undefined
      ? (problem.max_points > 0 ? Math.min(problem.max_points, sub.score) : sub.score)
      : isAcceptedVerdict(sub.verdict) ? problem.max_points : 0;

    if (isAlreadyAcceptedVerdict(sub.verdict)) continue;

    if (scoringMode === 'ioi') {
      // Unambiguous IOI rule:
      // - Subtask partial scores count toward bestPartial even on non-AC verdicts (standard IOI/CMS/QOJ).
      // - A problem counts as solved ("accepted") ONLY when score >= max_points AND verdict is NOT an explicit wrong verdict.
      const subSolved = problem.max_points > 0 && rawPoints >= problem.max_points && !explicitWrong;
      if (rawPoints > bestPartial) {
        bestPartial = rawPoints;
        lastImprovement = sub.received_ms;
      }
      if (subSolved) {
        isAccepted = true;
        firstAcMs = Math.min(firstAcMs ?? Infinity, sub.received_ms);
        lastVerdict = sub.verdict;
      } else if (!isAccepted && !isNoPenaltyVerdict(sub.verdict)) {
        wrongBeforeAc++;
      }
    } else {
      const subAccepted = isAcceptedVerdict(sub.verdict);
      if (subAccepted) {
        isAccepted = true;
        firstAcMs = Math.min(firstAcMs ?? Infinity, sub.received_ms);
        lastVerdict = sub.verdict;
      } else if (!isAccepted && !isNoPenaltyVerdict(sub.verdict)) {
        wrongBeforeAc++;
        if (rawPoints > bestPartial) bestPartial = rawPoints;
      }
    }
  }

  let probScore = 0;
  let maxPoints = problem.max_points;
  let penaltyMin = 0;
  let penaltyMs = 0;

  if (scoringMode === 'icpc') {
    probScore = isAccepted ? 1 : 0;
    maxPoints = 1;
    if (isAccepted && firstAcMs !== undefined) {
      penaltyMin = Math.floor(firstAcMs / 60_000) + 20 * wrongBeforeAc;
      penaltyMs = firstAcMs + wrongBeforeAc * 20 * 60_000;
    }
  } else if (scoringMode === 'cf') {
    if (isAccepted && firstAcMs !== undefined) {
      const pMax = problem.max_points;
      const frac = timeLimitMs > 0 ? Math.min(1, Math.max(0, firstAcMs / timeLimitMs)) : 0;
      const wrongPenalty = (pMax >= 500 ? 50 : 0.1 * pMax) * wrongBeforeAc;
      probScore = roundScore(Math.max(0.3 * pMax, pMax * (1 - 0.5 * frac) - wrongPenalty));
    }
  } else if (scoringMode === 'ioi') {
    probScore = roundScore(bestPartial);
  } else {
    // last_ac
    probScore = roundScore(isAccepted ? problem.max_points : bestPartial);
  }

  let probStatus: ProblemStatus;
  if (isAccepted) probStatus = 'accepted';
  else if (hasPending) probStatus = 'pending';
  else if (probScore > 0) probStatus = 'partial';
  else if (attempts > 0) probStatus = 'wrong';
  else probStatus = 'unattempted';

  return {
    projected: {
      id: problem.id,
      status: probStatus,
      attempts,
      wrong_attempts: wrongBeforeAc,
      score: probScore,
      max_points: maxPoints,
      ...(firstAcMs !== undefined ? { first_ac_ms: firstAcMs } : {}),
      ...(lastVerdict !== undefined ? { last_verdict: lastVerdict } : {}),
    },
    isAccepted,
    firstAcMs,
    penaltyMin,
    penaltyMs,
    lastIoiImprovement: bestPartial > 0 ? lastImprovement : 0,
  };
}

function projectBoard(
  problems: ProblemMeta[],
  submissions: ReplaySubmission[],
  timeLimitMs: number,
  atElapsedMs: number,
  scoringMode: ScoringMode,
): ScoreProjection {
  const t = Math.max(0, Math.floor(atElapsedMs));
  const subsByProblem = new Map<string, ReplaySubmission[]>();
  let submissionsUsed = 0;

  for (const sub of submissions) {
    if (sub.received_ms <= t) {
      submissionsUsed++;
      const list = subsByProblem.get(sub.problem_id) ?? [];
      list.push(sub);
      subsByProblem.set(sub.problem_id, list);
    }
  }

  let totalScore = 0;
  let totalMaxScore = 0;
  let totalPenaltyMin = 0;
  let totalPenaltyMs = 0;
  let solvedCount = 0;
  let lastAcMs = 0;
  let lastIoiImprovementMs = 0;

  const projectedProblems: ProjectedProblem[] = problems.map(problem => {
    const res = projectSingleProblem(problem, subsByProblem.get(problem.id) ?? [], timeLimitMs, t, scoringMode);
    totalScore += res.projected.score;
    totalMaxScore += res.projected.max_points;
    totalPenaltyMin += res.penaltyMin;
    totalPenaltyMs += res.penaltyMs;
    if (res.isAccepted) {
      solvedCount++;
      if (res.firstAcMs !== undefined) lastAcMs = Math.max(lastAcMs, res.firstAcMs);
    }
    if (res.lastIoiImprovement > lastIoiImprovementMs) lastIoiImprovementMs = res.lastIoiImprovement;
    return res.projected;
  });

  const penalty = scoringMode === 'icpc'
    ? totalPenaltyMin
    : scoringMode === 'ioi'
    ? lastIoiImprovementMs
    : scoringMode === 'last_ac'
    ? lastAcMs
    : 0;

  const penaltyMs = scoringMode === 'icpc'
    ? totalPenaltyMs
    : scoringMode === 'ioi'
    ? lastIoiImprovementMs
    : lastAcMs;

  return scoreProjectionSchema.parse({
    at_elapsed_ms: t,
    scoring_mode: scoringMode,
    score: roundScore(totalScore),
    max_score: roundScore(totalMaxScore),
    penalty,
    penalty_ms: penaltyMs,
    solved_count: solvedCount,
    last_ac_ms: lastAcMs,
    submissions_used: submissionsUsed,
    problems: projectedProblems,
  });
}

interface ParsedRunState {
  runId: string;
  meta: z.infer<typeof runMetaSchema>;
  scoringMode: ScoringMode;
  explicitScoringMode?: ScoringMode;
  status: 'running' | 'completed' | 'void' | 'unknown';
  reason?: string;
  startedAt?: string;
  timeLimitMs: number;
  maxSubmissions: number;
  lastEventElapsedMs: number;
  lastActivityType?: string;
  terminalScore?: number;
  terminalMaxScore?: number;
  seededProblems: boolean;
  problems: ProblemMeta[];
  problemLastElapsed: Map<string, number>;
  submissions: ReplaySubmission[];
  recentActivities: RunProgressActivity[];
  frames: ReplayFrame[];
  telemetry: RunProgressTelemetry;
  sessionSummaries?: SessionSummary[];
}

async function readSessionSummariesFromPinned(runDir: PinnedDir): Promise<SessionSummary[]> {
  let sessionDir: PinnedDir;
  try {
    sessionDir = await openChildPinnedDir(runDir, 'session');
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }

  try {
    const entries = await readdirPinned(sessionDir);
    const files = entries
      .filter(entry => entry.isFile() && /\.(jsonl|json|txt|md|log)$/i.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .slice(0, 20);

    const summaries: SessionSummary[] = [];
    const maxFileBytes = 64 * 1024;
    const maxEntriesPerFile = 50;

    for (const name of files) {
      let handle: FileHandle;
      try {
        handle = await openChildInPinnedDir(sessionDir, name);
      } catch {
        continue;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) continue;
        const toRead = Math.min(info.size, maxFileBytes);
        const buf = Buffer.allocUnsafe(toRead);
        let read = 0;
        while (read < toRead) {
          const res = await handle.read(buf, read, toRead - read, read);
          if (!res.bytesRead) break;
          read += res.bytesRead;
        }
        const truncatedBySize = info.size > maxFileBytes;
        const content = buf.subarray(0, read).toString('utf8');
        const parsedEntries: SessionSummary['entries'] = [];
        let truncated = truncatedBySize;

        if (name.endsWith('.jsonl')) {
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (parsedEntries.length >= maxEntriesPerFile) { truncated = true; break; }
            try {
              const obj = JSON.parse(trimmed) as Record<string, unknown>;
              const role = typeof obj.role === 'string' ? obj.role.slice(0, 32) : undefined;
              const type = typeof obj.type === 'string' ? obj.type.slice(0, 48) : undefined;
              const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp.slice(0, 64) : undefined;
              const textCandidate = typeof obj.summary === 'string' ? obj.summary
                : typeof obj.text === 'string' ? obj.text
                : typeof obj.content === 'string' ? obj.content
                : typeof obj.message === 'string' ? obj.message
                : type ?? role ?? 'session entry';
              const cleaned = sanitizeString(textCandidate).replace(/\s+/g, ' ').trim().slice(0, 300);
              parsedEntries.push({
                index: parsedEntries.length,
                ...(role ? { role } : {}),
                ...(type ? { type } : {}),
                ...(timestamp ? { timestamp } : {}),
                summary: cleaned || 'session entry',
              });
            } catch {
              // Skip partial trailing JSON line.
            }
          }
        } else if (name.endsWith('.json')) {
          try {
            const parsed = JSON.parse(content) as unknown;
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
              if (parsedEntries.length >= maxEntriesPerFile) { truncated = true; break; }
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                const obj = item as Record<string, unknown>;
                const role = typeof obj.role === 'string' ? obj.role.slice(0, 32) : undefined;
                const type = typeof obj.type === 'string' ? obj.type.slice(0, 48) : undefined;
                const textCandidate = typeof obj.summary === 'string' ? obj.summary
                  : typeof obj.text === 'string' ? obj.text
                  : typeof obj.content === 'string' ? obj.content
                  : Object.keys(obj).slice(0, 8).join(', ');
                parsedEntries.push({
                  index: parsedEntries.length,
                  ...(role ? { role } : {}),
                  ...(type ? { type } : {}),
                  summary: sanitizeString(textCandidate).replace(/\s+/g, ' ').trim().slice(0, 300) || 'json entry',
                });
              }
            }
          } catch {
            // Ignore malformed JSON file.
          }
        } else {
          for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (parsedEntries.length >= maxEntriesPerFile) { truncated = true; break; }
            parsedEntries.push({
              index: parsedEntries.length,
              summary: sanitizeString(trimmed).slice(0, 300),
            });
          }
        }

        summaries.push({ file: name, entries: parsedEntries, truncated });
      } finally {
        await handle.close();
      }
    }
    return summaries;
  } finally {
    await sessionDir.close();
  }
}

async function parseRunState(
  root: string,
  runId: string,
  opts: { includeSources?: boolean; includeSession?: boolean; buildFrames?: boolean; maxActivity?: number } = {},
): Promise<ParsedRunState> {
  const validRunId = z.uuid().parse(runId);
  const directory = join(root, validRunId);
  const runDir = await openPinnedDir(directory);

  try {
    const meta = runMetaSchema.parse(await readChildJson(runDir, 'run.json', 4 * 1024 * 1024));
    if (meta.run_id !== validRunId) throw new Error('Run ID mismatch');

    const includeSources = opts.includeSources === true;
    const buildFrames = opts.buildFrames === true;
    const maxActivity = opts.maxActivity ?? 0;

    const explicitScoringMode = meta.scoring_mode ?? meta.rules?.scoring_mode;
    const scoringMode: ScoringMode = explicitScoringMode ?? 'last_ac';
    const timeLimitMs = meta.rules?.time_limit_ms ?? 900_000;
    const maxSubmissions = meta.rules?.max_submissions ?? 100;

    let initialProblems: ProblemMeta[] = [];
    let seededProblems = false;
    if (meta.problems?.length) {
      initialProblems = meta.problems.map(p => ({ id: p.id, max_points: p.max_points }));
      seededProblems = true;
    } else {
      const discovered = await discoverProblemsFromLocalInputs(meta.local_inputs, meta.input_sha256);
      if (discovered.length) {
        initialProblems = discovered;
        seededProblems = true;
      }
    }

    const problemsOrder: string[] = [];
    const problemMetaMap = new Map<string, { id: string; max_points: number; validCount: number }>();
    const problemLastElapsed = new Map<string, number>();

    const ensureProblem = (id: string, fallbackPoints = 1, allowInsert = !seededProblems) => {
      let entry = problemMetaMap.get(id);
      if (!entry) {
        if (!allowInsert) return undefined;
        entry = { id, max_points: fallbackPoints, validCount: 0 };
        problemMetaMap.set(id, entry);
        problemsOrder.push(id);
      }
      return entry;
    };
    for (const p of initialProblems) ensureProblem(p.id, p.max_points, true);

    const submissionsMap = new Map<string, ReplaySubmission>();
    const subsByProblem = new Map<string, ReplaySubmission[]>();
    const prevSourceByProblem = new Map<string, { submission_id: string; source: string }>();
    const activityRing = new ActivityRingBuffer(maxActivity);
    const frames: ReplayFrame[] = [];

    // O(1) incremental cumulative score/solved tracker for buildFrames mode.
    const problemScores = new Map<string, { score: number; solved: boolean }>();
    let cumulativeScore = 0;
    let cumulativeSolved = 0;

    const recomputeSingleProblemForFrames = (problemId: string, atMs: number) => {
      const metaEntry = problemMetaMap.get(problemId);
      if (!metaEntry) return;
      const res = projectSingleProblem(
        { id: metaEntry.id, max_points: metaEntry.max_points },
        subsByProblem.get(problemId) ?? [],
        timeLimitMs,
        atMs,
        scoringMode,
      );
      const prev = problemScores.get(problemId) ?? { score: 0, solved: false };
      cumulativeScore = roundScore(cumulativeScore - prev.score + res.projected.score);
      if (res.isAccepted !== prev.solved) {
        cumulativeSolved += res.isAccepted ? 1 : -1;
      }
      problemScores.set(problemId, { score: res.projected.score, solved: res.isAccepted });
    };

    const turnStarts = new Map<number, number>();
    const turnWaitMs = new Map<number, number>();
    const turnExplicitWait = new Set<number>();
    const turnInputTokens = new Map<number, number>();
    const turnOutputTokens = new Map<number, number>();
    const turnFrameIndex = new Map<number, number>();
    const seenTurns = new Set<number>();
    let syntheticTurnCounter = 0;
    let activeSyntheticTurn: number | undefined;

    let status: ParsedRunState['status'] = 'unknown';
    let reason: string | undefined;
    let startedAt: string | undefined;
    let lastEventElapsedMs = 0;
    let lastActivityType: string | undefined;
    let terminalScore: number | undefined;
    let terminalMaxScore: number | undefined;
    let replayPayloadBytesUsed = 0;

    const totalEvents = await forEachRunEvent(runDir, includeSources, event => {
      if (status === 'unknown') status = 'running';
      lastEventElapsedMs = Math.max(lastEventElapsedMs, event.elapsed_ms);
      lastActivityType = event.type;
      const raw = event.raw;

      const turnRaw = typeof raw.turn === 'number' && Number.isInteger(raw.turn) && raw.turn >= 0 ? raw.turn : undefined;
      let activityProblemId: string | undefined;
      let activitySubmissionId: string | undefined;
      let activityLanguage: string | undefined;
      let activityVerdict: string | undefined;
      let activityScore: number | undefined;

      if (event.type === 'run_started') {
        if (typeof raw.started_at === 'string' && raw.started_at.trim()) startedAt = raw.started_at;
        if (buildFrames) {
          frames.push({
            seq: event.seq,
            elapsed_ms: event.elapsed_ms,
            kind: 'run_started',
            summary: 'Contest run started',
            cumulative_score: cumulativeScore,
            solved_count: cumulativeSolved,
          });
        }
      } else if (event.type === 'model_request') {
        const t = turnRaw ?? (activeSyntheticTurn = ++syntheticTurnCounter);
        seenTurns.add(t);
        turnStarts.set(t, event.elapsed_ms);
      } else if (event.type === 'model_response' || event.type === 'model_usage') {
        let t: number;
        if (turnRaw !== undefined) {
          t = turnRaw;
        } else if (activeSyntheticTurn !== undefined) {
          t = activeSyntheticTurn;
          if (event.type === 'model_usage') activeSyntheticTurn = undefined;
        } else {
          t = event.type === 'model_response' ? ++syntheticTurnCounter : (syntheticTurnCounter || 1);
        }
        seenTurns.add(t);
        const explicitDuration = toNonNegNum(raw.duration_ms);
        if (explicitDuration !== undefined) {
          turnWaitMs.set(t, Math.floor(explicitDuration));
          turnExplicitWait.add(t);
        } else if (!turnExplicitWait.has(t) && turnStarts.has(t)) {
          turnWaitMs.set(t, Math.max(turnWaitMs.get(t) ?? 0, event.elapsed_ms - turnStarts.get(t)!));
        }
        const usage = extractUsage(raw.usage);
        if (usage.input !== undefined) turnInputTokens.set(t, usage.input);
        if (usage.output !== undefined) turnOutputTokens.set(t, usage.output);

        if (buildFrames) {
          const existingIdx = turnFrameIndex.get(t);
          if (event.type === 'model_usage' && existingIdx !== undefined) {
            const existing = frames[existingIdx]!;
            const wait = turnWaitMs.get(t);
            if (wait !== undefined) existing.duration_ms = wait;
            if (usage.input !== undefined) existing.input_tokens = usage.input;
            if (usage.output !== undefined) existing.output_tokens = usage.output;
          } else {
            turnFrameIndex.set(t, frames.length);
            frames.push({
              seq: event.seq,
              elapsed_ms: event.elapsed_ms,
              kind: 'model_turn',
              summary: buildSafeActivitySummary(event, undefined, undefined, undefined, undefined, t),
              turn: t,
              duration_ms: turnWaitMs.get(t),
              input_tokens: usage.input,
              output_tokens: usage.output,
              cumulative_score: cumulativeScore,
              solved_count: cumulativeSolved,
            });
          }
        }
      } else if (event.type === 'model_identity') {
        if (turnRaw !== undefined) seenTurns.add(turnRaw);
      } else if (event.type === 'submission_received') {
        const submissionId = typeof raw.submission_id === 'string' && raw.submission_id.trim()
          ? raw.submission_id.trim() : `s${submissionsMap.size + 1}`;
        const problemId = typeof raw.problem_id === 'string' && raw.problem_id.trim()
          ? raw.problem_id.trim() : 'unknown';
        const language = typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : undefined;

        const prob = ensureProblem(problemId, toNonNegNum(raw.max_points) ?? 1, !seededProblems);
        if (prob) {
          prob.validCount++;
          problemLastElapsed.set(problemId, Math.max(problemLastElapsed.get(problemId) ?? 0, event.elapsed_ms));
        }

        let frameSource: string | undefined;
        let frameDiff: string | undefined;
        if (buildFrames && includeSources && typeof raw.source === 'string') {
          const sanitizedSrc = sanitizeSource(raw.source);
          const srcBytes = Buffer.byteLength(sanitizedSrc, 'utf8');
          if (replayPayloadBytesUsed + srcBytes <= MAX_REPLAY_SOURCE_DIFF_BYTES) {
            frameSource = sanitizedSrc;
            replayPayloadBytesUsed += srcBytes;
          }
          const previous = prevSourceByProblem.get(problemId);
          if (previous) {
            const computed = unifiedLineDiff(previous.source, sanitizedSrc, previous.submission_id, submissionId);
            if (computed) {
              const diffBytes = Buffer.byteLength(computed, 'utf8');
              if (replayPayloadBytesUsed + diffBytes <= MAX_REPLAY_SOURCE_DIFF_BYTES) {
                frameDiff = computed;
                replayPayloadBytesUsed += diffBytes;
              }
            }
          }
          prevSourceByProblem.set(problemId, { submission_id: submissionId, source: sanitizedSrc });
        }

        const subRecord: ReplaySubmission = {
          submission_id: submissionId,
          problem_id: problemId,
          received_ms: event.elapsed_ms,
          verdict: 'pending',
          ...(language !== undefined ? { language } : {}),
        };
        submissionsMap.set(submissionId, subRecord);
        const pList = subsByProblem.get(problemId) ?? [];
        pList.push(subRecord);
        subsByProblem.set(problemId, pList);

        activityProblemId = problemId;
        activitySubmissionId = submissionId;
        activityLanguage = language;
        activityVerdict = 'pending';

        if (buildFrames) {
          frames.push({
            seq: event.seq,
            elapsed_ms: event.elapsed_ms,
            kind: 'submission_received',
            summary: buildSafeActivitySummary(event, problemId, language),
            problem_id: problemId,
            submission_id: submissionId,
            language,
            verdict: 'pending',
            source: frameSource,
            diff: frameDiff,
            cumulative_score: cumulativeScore,
            solved_count: cumulativeSolved,
          });
        }
      } else if (event.type === 'submission_delivered') {
        const submissionId = typeof raw.submission_id === 'string' ? raw.submission_id : undefined;
        activitySubmissionId = submissionId;
        if (submissionId && submissionsMap.has(submissionId)) {
          activityProblemId = submissionsMap.get(submissionId)!.problem_id;
        }
      } else if (event.type === 'submission_judged') {
        const submissionId = typeof raw.submission_id === 'string' && raw.submission_id.trim()
          ? raw.submission_id.trim() : undefined;
        const sub = submissionId ? submissionsMap.get(submissionId) : undefined;
        const problemId = (typeof raw.problem_id === 'string' && raw.problem_id.trim() ? raw.problem_id.trim() : undefined)
          ?? sub?.problem_id;
        const verdict = typeof raw.verdict === 'string' && raw.verdict.trim() ? raw.verdict.trim() : 'unknown';
        const eventMaxPoints = toNonNegNum(raw.max_points);
        const explicitPoints = toNonNegNum(raw.points_awarded) ?? toNonNegNum(raw.score);
        const invalidVerdict = isInvalidSubmissionVerdict(verdict);

        let awarded = explicitPoints;
        if (problemId) {
          if (invalidVerdict) {
            if (!seededProblems) {
              const existing = problemMetaMap.get(problemId);
              if (existing) {
                existing.validCount = Math.max(0, existing.validCount - 1);
                if (existing.validCount === 0) {
                  problemMetaMap.delete(problemId);
                  const idx = problemsOrder.indexOf(problemId);
                  if (idx !== -1) problemsOrder.splice(idx, 1);
                  problemLastElapsed.delete(problemId);
                }
              }
            }
          } else {
            const prob = ensureProblem(problemId, eventMaxPoints ?? explicitPoints ?? 1, !seededProblems);
            if (prob) {
              if (eventMaxPoints !== undefined && (!seededProblems || prob.max_points < eventMaxPoints)) {
                prob.max_points = Math.max(prob.max_points, eventMaxPoints);
              }
              if (explicitPoints !== undefined && !seededProblems && explicitPoints > prob.max_points) {
                prob.max_points = explicitPoints;
              }
              if (isAcceptedVerdict(verdict) && awarded === undefined) {
                awarded = prob.max_points;
              }
              problemLastElapsed.set(problemId, Math.max(problemLastElapsed.get(problemId) ?? 0, event.elapsed_ms));
            }
          }

          if (sub) {
            sub.judged_ms = event.elapsed_ms;
            sub.verdict = verdict;
            if (awarded !== undefined) sub.score = awarded;
            if (eventMaxPoints !== undefined) sub.max_points = eventMaxPoints;
          }
          if (buildFrames && !invalidVerdict) {
            recomputeSingleProblemForFrames(problemId, event.elapsed_ms);
          }
        }

        activityProblemId = problemId;
        activitySubmissionId = submissionId;
        activityLanguage = sub?.language;
        activityVerdict = verdict;
        activityScore = awarded;

        if (buildFrames) {
          frames.push({
            seq: event.seq,
            elapsed_ms: event.elapsed_ms,
            kind: 'submission_judged',
            summary: buildSafeActivitySummary(event, problemId, sub?.language, verdict, awarded),
            problem_id: problemId,
            submission_id: submissionId,
            language: sub?.language,
            verdict,
            score: awarded,
            points_awarded: awarded,
            cumulative_score: cumulativeScore,
            solved_count: cumulativeSolved,
          });
        }
      } else if (event.type === 'settling' || event.type === 'judge_error' || event.type === 'finish') {
        if (buildFrames) {
          frames.push({
            seq: event.seq,
            elapsed_ms: event.elapsed_ms,
            kind: event.type,
            summary: buildSafeActivitySummary(event),
            cumulative_score: cumulativeScore,
            solved_count: cumulativeSolved,
          });
        }
      } else if (event.type === 'run_ended') {
        status = raw.status === 'completed' ? 'completed' : raw.status === 'void' ? 'void' : 'unknown';
        reason = typeof raw.reason === 'string' && raw.reason.trim() ? sanitizeString(raw.reason.trim()) : undefined;
        terminalScore = toNonNegNum(raw.score);
        terminalMaxScore = toNonNegNum(raw.max_score);
        if (buildFrames) {
          frames.push({
            seq: event.seq,
            elapsed_ms: event.elapsed_ms,
            kind: 'run_ended',
            summary: buildSafeActivitySummary(event),
            status,
            reason,
            score: terminalScore,
            cumulative_score: cumulativeScore,
            solved_count: cumulativeSolved,
          });
        }
      }

      if (maxActivity > 0) {
        activityRing.push({
          seq: event.seq,
          elapsed_ms: event.elapsed_ms,
          type: event.type,
          summary: buildSafeActivitySummary(event, activityProblemId, activityLanguage, activityVerdict, activityScore, turnRaw),
          ...(activityProblemId ? { problem_id: activityProblemId } : {}),
          ...(activitySubmissionId ? { submission_id: activitySubmissionId } : {}),
          ...(activityLanguage ? { language: activityLanguage } : {}),
          ...(activityVerdict ? { verdict: activityVerdict } : {}),
          ...(activityScore !== undefined ? { score: activityScore } : {}),
          ...(turnRaw !== undefined ? { turn: turnRaw } : {}),
        });
      }
    });

    void totalEvents;

    let totalModelWaitMs = 0;
    for (const w of turnWaitMs.values()) totalModelWaitMs += w;
    let totalInputTokens = 0;
    for (const v of turnInputTokens.values()) totalInputTokens += v;
    let totalOutputTokens = 0;
    for (const v of turnOutputTokens.values()) totalOutputTokens += v;

    const telemetry: RunProgressTelemetry = {
      model_turns: seenTurns.size,
      total_model_wait_ms: totalModelWaitMs,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
    };

    const sessionSummaries = opts.includeSession ? await readSessionSummariesFromPinned(runDir) : undefined;

    return {
      runId: validRunId,
      meta,
      scoringMode,
      explicitScoringMode,
      status,
      reason,
      startedAt,
      timeLimitMs,
      maxSubmissions,
      lastEventElapsedMs,
      lastActivityType,
      terminalScore,
      terminalMaxScore,
      seededProblems,
      problems: problemsOrder.map(id => {
        const p = problemMetaMap.get(id)!;
        return { id: p.id, max_points: p.max_points };
      }),
      problemLastElapsed,
      submissions: [...submissionsMap.values()],
      recentActivities: activityRing.toNewestFirst(),
      frames,
      telemetry,
      sessionSummaries,
    };
  } finally {
    await runDir.close();
  }
}

export async function readRunProgress(
  root: string,
  runId: string,
  opts: { maxActivity?: number; now?: number } = {},
): Promise<RunProgress> {
  const maxActivity = Math.max(0, Math.min(200, Math.floor(opts.maxActivity ?? 30)));
  const state = await parseRunState(root, runId, {
    includeSources: false,
    includeSession: false,
    buildFrames: false,
    maxActivity,
  });

  let elapsedMs = state.lastEventElapsedMs;
  if (state.status === 'running' && state.startedAt) {
    const startedEpoch = Date.parse(state.startedAt);
    if (Number.isFinite(startedEpoch)) {
      const wallElapsed = Math.max(0, Math.floor((opts.now ?? Date.now()) - startedEpoch));
      elapsedMs = Math.max(state.lastEventElapsedMs, Math.min(state.timeLimitMs, wallElapsed));
    }
  }
  const remainingMs = Math.max(0, state.timeLimitMs - elapsedMs);

  const projectionTime = Math.max(
    state.lastEventElapsedMs,
    ...state.submissions.map(s => Math.max(s.received_ms, s.judged_ms ?? s.received_ms)),
  );
  const projected = projectBoard(
    state.problems,
    state.submissions,
    state.timeLimitMs,
    projectionTime,
    state.scoringMode,
  );

  const problems: RunProgressProblem[] = projected.problems.map(p => {
    const lastElapsed = state.problemLastElapsed.get(p.id);
    return {
      id: p.id,
      max_points: p.max_points,
      attempts: p.attempts,
      status: p.status,
      best_score: p.score,
      ...(p.first_ac_ms !== undefined ? { first_ac_ms: p.first_ac_ms } : {}),
      ...(p.last_verdict !== undefined ? { last_verdict: p.last_verdict } : {}),
      ...(lastElapsed !== undefined ? { last_elapsed_ms: lastElapsed } : {}),
    };
  });

  const maxScore = state.scoringMode === 'icpc'
    ? projected.max_score
    : Math.max(projected.max_score, state.terminalMaxScore ?? state.meta.max_score ?? 0);
  const score = state.status === 'completed' && state.terminalScore !== undefined && !state.seededProblems && state.scoringMode !== 'icpc' && state.terminalScore > projected.score
    ? roundScore(state.terminalScore) : projected.score;

  return runProgressSchema.parse({
    run_id: state.runId,
    status: state.status,
    ...(state.reason !== undefined ? { reason: state.reason } : {}),
    agent_id: state.meta.agent_id,
    ...(state.meta.agent_name !== undefined ? { agent_name: state.meta.agent_name } : {}),
    contest_id: state.meta.contest_id,
    ...(state.meta.contest_title !== undefined ? { contest_title: state.meta.contest_title } : {}),
    data_version: state.meta.data_version,
    ...(state.explicitScoringMode !== undefined ? { scoring_mode: state.explicitScoringMode } : {}),
    ...(state.startedAt !== undefined ? { started_at: state.startedAt } : {}),
    elapsed_ms: elapsedMs,
    time_limit_ms: state.timeLimitMs,
    remaining_ms: remainingMs,
    submissions_used: state.submissions.length,
    max_submissions: state.maxSubmissions,
    model_turns: state.telemetry.model_turns,
    last_activity_ms: state.lastEventElapsedMs,
    ...(state.lastActivityType !== undefined ? { last_activity_type: state.lastActivityType } : {}),
    score,
    max_score: maxScore,
    solved_count: projected.solved_count,
    problem_count: problems.length,
    ...(!state.seededProblems ? { problem_breakdown_unavailable: true } : {}),
    problems,
    recent_activity: state.recentActivities,
    telemetry: state.telemetry,
  });
}

export function summarizeLiveRun(progress: RunProgress): LiveRunSummary {
  let lastSubmission: LiveRunSummary['last_submission'];
  for (const act of progress.recent_activity) {
    if ((act.type === 'submission_judged' || act.type === 'submission_received') && act.problem_id) {
      lastSubmission = {
        problem_id: act.problem_id,
        verdict: act.verdict ?? (act.type === 'submission_received' ? 'pending' : 'unknown'),
        elapsed_ms: act.elapsed_ms,
      };
      break;
    }
  }
  if (!lastSubmission) {
    let latest: RunProgressProblem | undefined;
    for (const p of progress.problems) {
      if (p.attempts > 0 && p.last_elapsed_ms !== undefined && (!latest || p.last_elapsed_ms >= (latest.last_elapsed_ms ?? -1))) {
        latest = p;
      }
    }
    if (latest && latest.last_elapsed_ms !== undefined) {
      lastSubmission = {
        problem_id: latest.id,
        verdict: latest.last_verdict ?? latest.status,
        elapsed_ms: latest.last_elapsed_ms,
      };
    }
  }
  return liveRunSummarySchema.parse({
    solved_count: progress.solved_count,
    problem_count: progress.problem_count,
    score: progress.score,
    max_score: progress.max_score,
    remaining_ms: progress.remaining_ms,
    ...(lastSubmission ? { last_submission: lastSubmission } : {}),
    active: progress.status === 'running',
  });
}

function trimIncompleteUtf8Tail(buffer: Buffer, length: number, allowEmptyTrim: boolean): number {
  if (length <= 0) return 0;
  const lastByte = buffer[length - 1]!;
  if ((lastByte & 0x80) === 0) return length;

  let leadIdx = length - 1;
  let continuations = 0;
  while (leadIdx >= 0 && (buffer[leadIdx]! & 0xc0) === 0x80 && continuations < 3) {
    leadIdx--;
    continuations++;
  }
  if (leadIdx < 0) return length;

  const lead = buffer[leadIdx]!;
  let expectedLength = 1;
  if ((lead & 0xe0) === 0xc0) expectedLength = 2;
  else if ((lead & 0xf0) === 0xe0) expectedLength = 3;
  else if ((lead & 0xf8) === 0xf0) expectedLength = 4;
  else return length;

  const actualLength = length - leadIdx;
  if (actualLength < expectedLength && (allowEmptyTrim || leadIdx > 0)) return leadIdx;
  return length;
}

export async function readRunLogSlice(
  root: string,
  runId: string,
  stream: 'stdout' | 'stderr',
  offset = 0,
  maxBytes = 65536,
): Promise<LogSlice> {
  const validRunId = z.uuid().parse(runId);
  const validStream = z.enum(['stdout', 'stderr']).parse(stream);
  const requestedOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const clampedMaxBytes = Number.isFinite(maxBytes) ? Math.max(4, Math.min(4 * 1024 * 1024, Math.floor(maxBytes))) : 65536;

  let runDir: PinnedDir;
  try {
    runDir = await openPinnedDir(join(root, validRunId));
  } catch (error) {
    if (missing(error)) {
      return logSliceSchema.parse({
        stream: validStream,
        offset: 0,
        next_offset: 0,
        total_bytes: 0,
        has_more: false,
        chunk: '',
      });
    }
    throw error;
  }

  try {
    let handle: FileHandle;
    try {
      handle = await openChildInPinnedDir(runDir, `agent.${validStream}.log`);
    } catch (error) {
      if (missing(error)) {
        return logSliceSchema.parse({
          stream: validStream,
          offset: 0,
          next_offset: 0,
          total_bytes: 0,
          has_more: false,
          chunk: '',
        });
      }
      throw error;
    }

    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Run log is not a regular file');
      const totalBytes = info.size;
      const startOffset = requestedOffset > totalBytes ? 0 : requestedOffset;
      const available = totalBytes - startOffset;
      if (available <= 0) {
        return logSliceSchema.parse({
          stream: validStream,
          offset: startOffset,
          next_offset: startOffset,
          total_bytes: totalBytes,
          has_more: false,
          chunk: '',
        });
      }

      const toRead = Math.min(clampedMaxBytes, available);
      const buffer = Buffer.allocUnsafe(toRead);
      let totalRead = 0;
      while (totalRead < toRead) {
        const { bytesRead } = await handle.read(buffer, totalRead, toRead - totalRead, startOffset + totalRead);
        if (!bytesRead) break;
        totalRead += bytesRead;
      }

      const rawHasMore = startOffset + totalRead < totalBytes;
      const safeLength = trimIncompleteUtf8Tail(buffer, totalRead, !rawHasMore);
      const nextOffset = startOffset + safeLength;

      return logSliceSchema.parse({
        stream: validStream,
        offset: startOffset,
        next_offset: nextOffset,
        total_bytes: totalBytes,
        has_more: rawHasMore,
        chunk: buffer.subarray(0, safeLength).toString('utf8'),
      });
    } finally {
      await handle.close();
    }
  } finally {
    await runDir.close();
  }
}

export async function buildRunReplay(
  root: string,
  runId: string,
  opts: { includeSession?: boolean; includeSources?: boolean } = {},
): Promise<RunReplay> {
  const state = await parseRunState(root, runId, {
    includeSources: opts.includeSources === true,
    includeSession: opts.includeSession === true,
    buildFrames: true,
    maxActivity: 0,
  });
  const contestRevision = state.meta.contest_revision ?? state.meta.input_sha256?.contest;

  return runReplaySchema.parse({
    run_id: state.runId,
    status: state.status,
    ...(state.reason !== undefined ? { reason: state.reason } : {}),
    agent_id: state.meta.agent_id,
    ...(state.meta.agent_name !== undefined ? { agent_name: state.meta.agent_name } : {}),
    contest_id: state.meta.contest_id,
    ...(state.meta.contest_title !== undefined ? { contest_title: state.meta.contest_title } : {}),
    data_version: state.meta.data_version,
    ...(contestRevision !== undefined ? { contest_revision: contestRevision } : {}),
    ...(state.meta.protocol_id !== undefined ? { protocol_id: state.meta.protocol_id } : {}),
    ...(state.meta.protocol_version !== undefined ? { protocol_version: state.meta.protocol_version } : {}),
    ...(state.meta.protocol_sha256 !== undefined ? { protocol_sha256: state.meta.protocol_sha256 } : {}),
    scoring_mode: state.scoringMode,
    ...(state.startedAt !== undefined ? { started_at: state.startedAt } : {}),
    time_limit_ms: state.timeLimitMs,
    duration_ms: state.lastEventElapsedMs,
    ...(!state.seededProblems ? { problem_breakdown_unavailable: true } : {}),
    problems: state.problems,
    submissions: state.submissions,
    frames: state.frames,
    telemetry: state.telemetry,
    ...(state.sessionSummaries !== undefined ? { session_summaries: state.sessionSummaries } : {}),
  });
}

export function projectScoreAt(
  replay: RunReplay,
  atElapsedMs: number,
  scoringMode: ScoringMode = replay.scoring_mode,
): ScoreProjection {
  const mode = scoringModeSchema.parse(scoringMode);
  return projectBoard(
    replay.problems,
    replay.submissions,
    replay.time_limit_ms,
    atElapsedMs,
    mode,
  );
}

function compareEffectiveLastAc(a: Omit<GhostRaceStanding, 'rank'>, b: Omit<GhostRaceStanding, 'rank'>): number {
  const aTime = a.solved_count > 0 ? a.last_ac_ms : Infinity;
  const bTime = b.solved_count > 0 ? b.last_ac_ms : Infinity;
  if (aTime === bTime) return 0;
  return aTime - bTime;
}

function compareStandings(a: Omit<GhostRaceStanding, 'rank'>, b: Omit<GhostRaceStanding, 'rank'>, mode: ScoringMode): number {
  if (a.unranked !== b.unranked) return a.unranked ? 1 : -1;
  if (a.unranked && b.unranked) return 0;

  if (mode === 'icpc') {
    return (b.score - a.score) || (a.penalty - b.penalty) || (a.penalty_ms - b.penalty_ms) || compareEffectiveLastAc(a, b);
  }
  if (mode === 'cf') {
    return (b.score - a.score) || (b.solved_count - a.solved_count) || compareEffectiveLastAc(a, b);
  }
  if (mode === 'ioi') {
    return (b.score - a.score) || (b.solved_count - a.solved_count) || (a.penalty - b.penalty);
  }
  // last_ac: aligned with runner/results.ts (score desc, then effective last_ac_ms asc; do not tiebreak by solved_count).
  return (b.score - a.score) || compareEffectiveLastAc(a, b);
}

export function evaluateGhostRaceAt(
  race: GhostRaceData,
  atElapsedMs: number,
  scoringMode: ScoringMode = race.scoring_mode,
): GhostRaceSnapshot {
  const mode = scoringModeSchema.parse(scoringMode);
  const t = Math.max(0, Math.floor(atElapsedMs));

  const rows: Array<Omit<GhostRaceStanding, 'rank'>> = race.participants.map(participant => {
    const isVoid = participant.status === 'void';
    const isProvisional = participant.status === 'running' || participant.status === 'unknown';
    const projected = projectBoard(
      race.problems,
      participant.submissions,
      participant.time_limit_ms,
      t,
      mode,
    );
    return {
      status: participant.status,
      provisional: isProvisional,
      unranked: isVoid,
      run_id: participant.run_id,
      agent_id: participant.agent_id,
      ...(participant.agent_name !== undefined ? { agent_name: participant.agent_name } : {}),
      score: isVoid ? 0 : projected.score,
      max_score: projected.max_score,
      solved_count: isVoid ? 0 : projected.solved_count,
      penalty: isVoid ? 0 : projected.penalty,
      penalty_ms: isVoid ? 0 : projected.penalty_ms,
      last_ac_ms: isVoid ? 0 : projected.last_ac_ms,
      submissions_used: projected.submissions_used,
      finished: participant.status !== 'running' && t >= participant.duration_ms,
      problems: projected.problems,
    };
  });

  rows.sort((a, b) => compareStandings(a, b, mode) || a.run_id.localeCompare(b.run_id));

  let currentRank = 0;
  let rankedIndex = 0;
  let prevRanked: Omit<GhostRaceStanding, 'rank'> | undefined;

  const standings: GhostRaceStanding[] = rows.map(row => {
    if (row.unranked) {
      return { rank: null, ...row };
    }
    rankedIndex++;
    if (!prevRanked || compareStandings(prevRanked, row, mode) !== 0) {
      currentRank = rankedIndex;
    }
    prevRanked = row;
    return { rank: currentRank, ...row };
  });

  return ghostRaceSnapshotSchema.parse({
    at_elapsed_ms: t,
    scoring_mode: mode,
    standings,
  });
}

function problemSetKey(problems: ProblemMeta[]): string {
  const entries: Array<[string, number]> = problems.map(p => [p.id, p.max_points]);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

export async function buildGhostRace(
  root: string,
  runIds: string[],
  opts: { scoringMode?: ScoringMode; sampleStepMs?: number } = {},
): Promise<GhostRace> {
  if (!Array.isArray(runIds) || runIds.length === 0) throw new Error('Ghost race requires at least 1 run');
  if (runIds.length > 8) throw new Error('Ghost race supports at most 8 runs');
  const validatedIds = runIds.map(id => z.uuid().parse(id));
  if (new Set(validatedIds).size !== validatedIds.length) throw new Error('Duplicate run IDs in ghost race');

  const replays = await Promise.all(
    validatedIds.map(id => buildRunReplay(root, id, { includeSession: false, includeSources: false })),
  );

  for (const replay of replays) {
    if (
      !replay.contest_revision ||
      !replay.protocol_id ||
      replay.protocol_version === undefined ||
      !replay.protocol_sha256
    ) {
      throw new Error(`Run ${replay.run_id} is missing required compatibility metadata for ghost racing`);
    }
    if (replay.problem_breakdown_unavailable || replay.problems.length === 0) {
      throw new Error(`Run ${replay.run_id} has unverified or missing problem breakdown; cannot rank in ghost race`);
    }
  }

  const baseline = replays[0]!;
  const baselineProblemsKey = problemSetKey(baseline.problems);
  const contestId = baseline.contest_id;
  const contestTitle = replays.find(r => r.contest_title)?.contest_title;

  for (const replay of replays.slice(1)) {
    if (replay.contest_id !== baseline.contest_id) {
      throw new Error(`Contest mismatch in ghost race: expected ${baseline.contest_id}, got ${replay.contest_id}`);
    }
    if (replay.data_version !== baseline.data_version) {
      throw new Error(`Data version mismatch in ghost race: expected ${baseline.data_version}, got ${replay.data_version}`);
    }
    if (replay.contest_revision !== baseline.contest_revision) {
      throw new Error('Contest revision mismatch in ghost race');
    }
    if (
      replay.protocol_id !== baseline.protocol_id ||
      replay.protocol_version !== baseline.protocol_version ||
      replay.protocol_sha256 !== baseline.protocol_sha256
    ) {
      throw new Error('Protocol mismatch in ghost race');
    }
    if (replay.time_limit_ms !== baseline.time_limit_ms) {
      throw new Error(`Time limit mismatch in ghost race: expected ${baseline.time_limit_ms}, got ${replay.time_limit_ms}`);
    }
    if (problemSetKey(replay.problems) !== baselineProblemsKey) {
      throw new Error('Problem set or weight mismatch in ghost race');
    }
  }

  const scoringMode: ScoringMode = opts.scoringMode ? scoringModeSchema.parse(opts.scoringMode) : baseline.scoring_mode;
  const timeLimitMs = baseline.time_limit_ms;
  const problems: ProblemMeta[] = baseline.problems.map(p => ({ id: p.id, max_points: p.max_points }));

  const timelineEndMs = Math.max(
    timeLimitMs,
    ...replays.map(r => r.duration_ms),
    ...replays.flatMap(r => r.submissions.map(s => s.judged_ms ?? s.received_ms)),
  );

  const participants: GhostRaceParticipant[] = replays.map(replay => {
    const isVoid = replay.status === 'void';
    const finalProjection = projectBoard(
      problems,
      replay.submissions,
      replay.time_limit_ms,
      timelineEndMs,
      scoringMode,
    );
    return {
      run_id: replay.run_id,
      agent_id: replay.agent_id,
      ...(replay.agent_name !== undefined ? { agent_name: replay.agent_name } : {}),
      status: replay.status,
      time_limit_ms: replay.time_limit_ms,
      duration_ms: replay.duration_ms,
      final_score: isVoid ? 0 : finalProjection.score,
      final_solved_count: isVoid ? 0 : finalProjection.solved_count,
      final_penalty: isVoid ? 0 : finalProjection.penalty,
      submissions: replay.submissions,
    };
  });

  const milestones: GhostRaceMilestone[] = [];
  for (const replay of replays) {
    for (const frame of replay.frames) {
      if (
        frame.kind === 'submission_received' ||
        frame.kind === 'submission_judged' ||
        frame.kind === 'finish' ||
        frame.kind === 'run_ended'
      ) {
        milestones.push({
          elapsed_ms: frame.elapsed_ms,
          run_id: replay.run_id,
          agent_id: replay.agent_id,
          ...(replay.agent_name !== undefined ? { agent_name: replay.agent_name } : {}),
          seq: frame.seq,
          kind: frame.kind,
          ...(frame.problem_id !== undefined ? { problem_id: frame.problem_id } : {}),
          ...(frame.submission_id !== undefined ? { submission_id: frame.submission_id } : {}),
          ...(frame.language !== undefined ? { language: frame.language } : {}),
          ...(frame.verdict !== undefined ? { verdict: frame.verdict } : {}),
          ...(frame.score !== undefined ? { score: frame.score } : {}),
          summary: frame.summary,
        });
      }
    }
  }
  milestones.sort((a, b) => (a.elapsed_ms - b.elapsed_ms) || a.run_id.localeCompare(b.run_id) || (a.seq - b.seq));

  const baseData: GhostRaceData = {
    contest_id: contestId,
    ...(contestTitle !== undefined ? { contest_title: contestTitle } : {}),
    data_version: baseline.data_version,
    contest_revision: baseline.contest_revision!,
    protocol_id: baseline.protocol_id!,
    protocol_version: baseline.protocol_version!,
    protocol_sha256: baseline.protocol_sha256!,
    time_limit_ms: timeLimitMs,
    timeline_end_ms: timelineEndMs,
    scoring_mode: scoringMode,
    problems,
    participants,
    milestones,
  };

  if (opts.sampleStepMs !== undefined) {
    const step = Math.floor(opts.sampleStepMs);
    if (!Number.isFinite(step) || step <= 0) throw new Error('sampleStepMs must be a positive integer');
    const samples: GhostRaceSnapshot[] = [];
    const maxSamples = 500;
    const effectiveStep = Math.max(step, Math.ceil(timelineEndMs / maxSamples));
    for (let t = 0; t < timelineEndMs; t += effectiveStep) {
      samples.push(evaluateGhostRaceAt(baseData, t, scoringMode));
    }
    if (timelineEndMs > timeLimitMs && !samples.some(s => s.at_elapsed_ms === timeLimitMs)) {
      samples.push(evaluateGhostRaceAt(baseData, timeLimitMs, scoringMode));
      samples.sort((a, b) => a.at_elapsed_ms - b.at_elapsed_ms);
    }
    samples.push(evaluateGhostRaceAt(baseData, timelineEndMs, scoringMode));
    baseData.samples = samples;
  }

  const validated = ghostRaceSchema.parse(baseData);
  const race = { ...validated } as GhostRace;
  Object.defineProperty(race, 'evaluateAt', {
    value: (atElapsedMs: number, mode?: ScoringMode) => evaluateGhostRaceAt(validated, atElapsedMs, mode ?? validated.scoring_mode),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return race;
}
