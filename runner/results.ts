import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { z } from 'zod';
import { speedTierSchema } from './harnesses.js';
import { readJson } from './plan.js';
import { scoringModes, type ScoringMode } from './protocol.js';
import { getBatch } from './queue.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const legacySubmission = z.strictObject({ id: z.string(), problem_id: z.string(), elapsed_ms: count, verdict: z.string() });
const submission = legacySubmission.extend({
  language: z.string().optional(),
  score: z.number().nonnegative().optional(),
  max_points: count.optional(),
  remote_submission_id: z.union([z.string(), z.number().int()]).optional(),
});
export const telemetrySchema = z.strictObject({
  model_turns: count,
  model_wait_ms: count,
  total_input_tokens: count.optional(),
  total_output_tokens: count.optional(),
  wall_ms: count.optional(),
});
const v2ModelSchema = z.strictObject({
  requested: z.string(),
  observed: z.array(z.string()),
  family: z.string().optional(),
  vendor: z.string().optional(),
  reasoning_effort: z.string().optional(),
});
const v3ModelSchema = v2ModelSchema.extend({
  speed_tier: speedTierSchema.optional(),
  service_tier: z.string().optional(),
});
const v2ResultSchema = z.strictObject({
  run_id: z.uuid(), contest_id: z.string(), contest_title: z.string().optional(),
  data_version: count, contest_revision: digest, protocol_id: z.string(), protocol_version: count, protocol_sha256: digest,
  agent_id: z.string(), agent_revision: digest, harness: z.object({ kind: z.string(), version: z.string() }).strict(),
  model: v2ModelSchema,
  score: count, max_score: count, submissions: z.array(legacySubmission),
});
const v1ResultSchema = v2ResultSchema.extend({ model: v2ModelSchema.omit({ vendor: true }) });
export const resultSchema = z.strictObject({
  run_id: z.uuid(),
  contest_id: z.string(),
  contest_title: z.string().optional(),
  data_version: count,
  contest_revision: digest,
  protocol_id: z.string(),
  protocol_version: count,
  protocol_sha256: digest,
  protocol_preset: z.string().optional(),
  scoring_mode: z.enum(scoringModes).optional(),
  agent_id: z.string(),
  agent_name: z.string().optional(),
  agent_revision: digest,
  harness: z.object({ kind: z.string(), version: z.string() }).strict(),
  model: v3ModelSchema,
  score: z.number().nonnegative(),
  max_score: count,
  telemetry: telemetrySchema.optional(),
  submissions: z.array(submission),
});
export type Result = z.infer<typeof resultSchema>;
export type ResultSubmission = z.infer<typeof submission>;
export type ResultTelemetry = z.infer<typeof telemetrySchema>;

export const resultsSchema = z.discriminatedUnion('schema_version', [
  z.strictObject({ schema_version: z.literal(1), results: z.array(v1ResultSchema) }),
  z.strictObject({ schema_version: z.literal(2), results: z.array(v2ResultSchema) }),
  z.strictObject({ schema_version: z.literal(3), results: z.array(resultSchema) }),
]);
export const resultBundle = (results: Result[]) => ({ schema_version: 3 as const, results });

const metadata = resultSchema.omit({ score: true, max_score: true, submissions: true, model: true, telemetry: true }).strip().extend({
  contest_revision: digest.optional(),
  problems: z.array(z.object({ id: z.string(), max_points: count })).optional(),
  input_sha256: z.object({ contest: digest }),
  model: z.object({
    model: z.string(),
    model_family_id: z.string().optional(),
    vendor: z.string().optional(),
    reasoning_effort: z.string().optional(),
    speed_tier: speedTierSchema.optional(),
    service_tier: z.string().optional(),
  }),
});

const isAccepted = (verdict: string) => ['accepted', 'OK', 'AC'].includes(verdict);
const isNonPenalized = (verdict: string) => [
  'CE', 'COMPILATION_ERROR', 'compilation_error',
  'pending', 'already_accepted',
  'invalid_submission', 'SKIPPED', 'REJECTED',
].includes(verdict);
const isUnambiguouslyZeroVerdict = (verdict: string) => [
  'wrong_answer', 'WRONG_ANSWER', 'WA',
  'time_limit_exceeded', 'TIME_LIMIT_EXCEEDED', 'TLE',
  'memory_limit_exceeded', 'MEMORY_LIMIT_EXCEEDED', 'MLE',
  'runtime_error', 'RUNTIME_ERROR', 'RE',
  'compilation_error', 'COMPILATION_ERROR', 'CE',
  'presentation_error', 'PE',
  'idleness_limit_exceeded', 'ILE',
  'invalid_submission', 'SKIPPED', 'REJECTED',
  'pending', 'already_accepted',
].includes(verdict);

export async function exportRun(root: string, id: string): Promise<Result> {
  const directory = join(root, z.uuid().parse(id));
  const { input_sha256, model, problems, ...meta } = metadata.parse(await readJson(join(directory, 'run.json')));
  if (meta.run_id !== id) throw new Error('Run ID mismatch');
  const problemPoints = new Map((problems ?? []).map(p => [p.id, p.max_points]));
  const lines = createInterface({ input: createReadStream(join(directory, 'events.jsonl')), crlfDelay: Infinity });
  const rows = new Map<string, Partial<ResultSubmission>>();
  const observed = new Set<string>();
  const responseDurations = new Map<number, number>();
  const timingDurations = new Map<number, number>();
  // Deduplicate token usage per turn (e.g. Anthropic message_start + message_delta,
  // or repeated model_response + model_usage for the same turn).
  const turnTokens = new Map<number, { inp?: number; out?: number }>();
  let modelTurns = 0;
  let terminal: Record<string, unknown> | undefined;
  let seq = 0;

  const recordUsage = (turnKey: number, usage: unknown) => {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    const inp = typeof u.input_tokens === 'number' ? u.input_tokens : typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
    const out = typeof u.output_tokens === 'number' ? u.output_tokens : typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
    const prev = turnTokens.get(turnKey) ?? {};
    let updated = false;
    if (inp !== undefined && Number.isFinite(inp) && inp >= 0) { prev.inp = Math.round(inp); updated = true; }
    if (out !== undefined && Number.isFinite(out) && out >= 0) { prev.out = Math.round(out); updated = true; }
    if (updated) turnTokens.set(turnKey, prev);
  };

  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (terminal || event.schema_version !== 1 || event.seq !== ++seq) throw new Error('Invalid run event sequence');
      if (event.type === 'submission_received') {
        const entry: Partial<ResultSubmission> = {
          id: event.submission_id,
          problem_id: event.problem_id,
          elapsed_ms: event.elapsed_ms,
        };
        if (typeof event.language === 'string') entry.language = event.language;
        const maxPts = problemPoints.get(event.problem_id);
        if (maxPts !== undefined) entry.max_points = maxPts;
        rows.set(event.submission_id, entry);
      }
      if (event.type === 'submission_delivered' && rows.has(event.submission_id)) {
        const row = rows.get(event.submission_id)!;
        if (typeof event.remote_submission_id === 'string' || typeof event.remote_submission_id === 'number') {
          row.remote_submission_id = event.remote_submission_id;
        }
      }
      if (event.type === 'submission_judged' && rows.has(event.submission_id)) {
        const row = rows.get(event.submission_id)!;
        row.verdict = event.verdict;
        if (typeof event.remote_submission_id === 'string' || typeof event.remote_submission_id === 'number') {
          row.remote_submission_id = event.remote_submission_id;
        }
        if (typeof event.max_points === 'number') row.max_points = event.max_points;
        if (typeof event.points_awarded === 'number') row.score = event.points_awarded;
        else if (typeof event.score === 'number') row.score = event.score;
        else if (typeof event.verdict === 'string' && isAccepted(event.verdict) && row.max_points !== undefined) row.score = row.max_points;
      }
      if (event.type === 'model_request') modelTurns++;
      if (['model_response', 'model_identity'].includes(event.type) && typeof event.model === 'string') observed.add(event.model);
      if (event.type === 'model_response') {
        const turnKey = typeof event.turn === 'number' ? event.turn : modelTurns || responseDurations.size + 1;
        if (typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms) && event.duration_ms >= 0) {
          responseDurations.set(turnKey, event.duration_ms);
        }
        if (event.usage) recordUsage(turnKey, event.usage);
      }
      if (event.type === 'model_timing' && typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms) && event.duration_ms >= 0) {
        const turnKey = typeof event.turn === 'number' ? event.turn : timingDurations.size + 1;
        timingDurations.set(turnKey, event.duration_ms);
      }
      if (event.type === 'model_usage') {
        const turnKey = typeof event.turn === 'number' ? event.turn : modelTurns || turnTokens.size + 1;
        recordUsage(turnKey, event.usage);
      }
      if (event.type === 'run_ended') terminal = event;
    }
  } finally { lines.close(); }
  if (terminal?.status !== 'completed') throw new Error(`Run ${id} did not complete`);

  let modelWaitMs = 0;
  const seenTurns = new Set<number>();
  for (const [turnKey, ms] of timingDurations) { modelWaitMs += ms; seenTurns.add(turnKey); }
  for (const [turnKey, ms] of responseDurations) { if (!seenTurns.has(turnKey)) modelWaitMs += ms; }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let hasInputTokens = false;
  let hasOutputTokens = false;
  for (const t of turnTokens.values()) {
    if (t.inp !== undefined) { totalInputTokens += t.inp; hasInputTokens = true; }
    if (t.out !== undefined) { totalOutputTokens += t.out; hasOutputTokens = true; }
  }

  const telemetry: ResultTelemetry = {
    model_turns: modelTurns,
    model_wait_ms: Math.round(modelWaitMs),
    ...(hasInputTokens ? { total_input_tokens: totalInputTokens } : {}),
    ...(hasOutputTokens ? { total_output_tokens: totalOutputTokens } : {}),
    ...(typeof terminal.elapsed_ms === 'number' && terminal.elapsed_ms >= 0 ? { wall_ms: Math.round(terminal.elapsed_ms) } : {}),
  };

  return resultSchema.parse({
    ...meta,
    contest_revision: meta.contest_revision ?? input_sha256.contest,
    score: terminal.score,
    max_score: terminal.max_score,
    model: {
      requested: model.model,
      observed: [...observed],
      ...(model.model_family_id !== undefined ? { family: model.model_family_id } : {}),
      ...(model.vendor !== undefined ? { vendor: model.vendor } : {}),
      ...(model.reasoning_effort !== undefined ? { reasoning_effort: model.reasoning_effort } : {}),
      ...(model.speed_tier !== undefined ? { speed_tier: model.speed_tier } : {}),
      ...(model.service_tier !== undefined ? { service_tier: model.service_tier } : {}),
    },
    telemetry,
    submissions: [...rows.values()],
  });
}

export async function exportBatch(root: string, batchId: string) {
  const batch = await getBatch(root, batchId);
  const results = [];
  for (const job of batch.jobs) if (job.status === 'completed') results.push(await exportRun(root, job.run_id!));
  return resultBundle(results);
}

function coreFingerprint(result: Result) {
  return JSON.stringify({
    run_id: result.run_id,
    contest_id: result.contest_id,
    data_version: result.data_version,
    contest_revision: result.contest_revision,
    protocol_id: result.protocol_id,
    protocol_version: result.protocol_version,
    protocol_sha256: result.protocol_sha256,
    agent_id: result.agent_id,
    agent_revision: result.agent_revision,
    harness: result.harness,
    model: {
      requested: result.model.requested,
      observed: [...result.model.observed].sort(),
      family: result.model.family ?? null,
    },
    score: result.score,
    max_score: result.max_score,
    submissions: result.submissions.map(s => ({
      id: s.id,
      problem_id: s.problem_id,
      elapsed_ms: s.elapsed_ms,
      verdict: s.verdict,
    })),
  });
}

function mergeOptionalField<T>(a: T | undefined, b: T | undefined, runId: string): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Conflicting run ${runId}`);
  return a;
}

function mergeCompatibleRun(existing: Result, incoming: Result): Result {
  if (JSON.stringify(existing) === JSON.stringify(incoming)) return existing;
  if (coreFingerprint(existing) !== coreFingerprint(incoming)) throw new Error(`Conflicting run ${existing.run_id}`);
  const runId = existing.run_id;
  const submissions: ResultSubmission[] = existing.submissions.map((a, idx) => {
    const b = incoming.submissions[idx]!;
    const language = mergeOptionalField(a.language, b.language, runId);
    const score = mergeOptionalField(a.score, b.score, runId);
    const max_points = mergeOptionalField(a.max_points, b.max_points, runId);
    const remote_submission_id = mergeOptionalField(a.remote_submission_id, b.remote_submission_id, runId);
    return {
      id: a.id,
      problem_id: a.problem_id,
      elapsed_ms: a.elapsed_ms,
      verdict: a.verdict,
      ...(language !== undefined ? { language } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(max_points !== undefined ? { max_points } : {}),
      ...(remote_submission_id !== undefined ? { remote_submission_id } : {}),
    };
  });
  const contest_title = mergeOptionalField(existing.contest_title, incoming.contest_title, runId);
  const protocol_preset = mergeOptionalField(existing.protocol_preset, incoming.protocol_preset, runId);
  const scoring_mode = mergeOptionalField(existing.scoring_mode, incoming.scoring_mode, runId);
  const agent_name = mergeOptionalField(existing.agent_name, incoming.agent_name, runId);
  const telemetry = mergeOptionalField(existing.telemetry, incoming.telemetry, runId);
  const vendor = mergeOptionalField(existing.model.vendor, incoming.model.vendor, runId);
  const reasoning_effort = mergeOptionalField(existing.model.reasoning_effort, incoming.model.reasoning_effort, runId);
  const speed_tier = mergeOptionalField(existing.model.speed_tier, incoming.model.speed_tier, runId);
  const service_tier = mergeOptionalField(existing.model.service_tier, incoming.model.service_tier, runId);
  return resultSchema.parse({
    run_id: existing.run_id,
    contest_id: existing.contest_id,
    ...(contest_title !== undefined ? { contest_title } : {}),
    data_version: existing.data_version,
    contest_revision: existing.contest_revision,
    protocol_id: existing.protocol_id,
    protocol_version: existing.protocol_version,
    protocol_sha256: existing.protocol_sha256,
    ...(protocol_preset !== undefined ? { protocol_preset } : {}),
    ...(scoring_mode !== undefined ? { scoring_mode } : {}),
    agent_id: existing.agent_id,
    ...(agent_name !== undefined ? { agent_name } : {}),
    agent_revision: existing.agent_revision,
    harness: existing.harness,
    model: {
      requested: existing.model.requested,
      observed: existing.model.observed,
      ...(existing.model.family !== undefined ? { family: existing.model.family } : {}),
      ...(vendor !== undefined ? { vendor } : {}),
      ...(reasoning_effort !== undefined ? { reasoning_effort } : {}),
      ...(speed_tier !== undefined ? { speed_tier } : {}),
      ...(service_tier !== undefined ? { service_tier } : {}),
    },
    score: existing.score,
    max_score: existing.max_score,
    ...(telemetry !== undefined ? { telemetry } : {}),
    submissions,
  });
}

export function mergeResults(bundles: unknown[]) {
  const results = new Map<string, Result>();
  for (const bundle of bundles) for (const result of resultsSchema.parse(bundle).results) {
    const normalized = result as Result;
    const current = results.get(normalized.run_id);
    results.set(normalized.run_id, current ? mergeCompatibleRun(current, normalized) : normalized);
  }
  return resultBundle([...results.values()]);
}

export type ProblemScoreBreakdown = {
  solved: boolean;
  attempts_before_ac: number;
  first_ac_ms?: number;
  penalty_minutes?: number;
  points: number;
};

export type ScoredResult = {
  mode: ScoringMode;
  primary: number;
  secondary: number;
  solved: number;
  penalty_minutes?: number;
  points?: number;
  tie_break_ms: number;
  last_ac_ms?: number;
  scoring_unavailable?: boolean;
  per_problem: Record<string, ProblemScoreBreakdown>;
};

export function scoreResult(result: Result, mode: ScoringMode = result.scoring_mode ?? 'last_ac'): ScoredResult {
  const byProblem = new Map<string, ResultSubmission[]>();
  for (const s of result.submissions) {
    const list = byProblem.get(s.problem_id) ?? [];
    list.push(s);
    byProblem.set(s.problem_id, list);
  }
  const per_problem: Record<string, ProblemScoreBreakdown> = {};
  let solved = 0;
  let penaltyMinutes = 0;
  let ioiPoints = 0;
  let cfPoints = 0;
  let missingCfWeight = false;
  let lastAcMs = 0;
  let lastImproveMs = 0;
  const hasCompleteIoiEvidence = result.submissions.every(s => {
    if (typeof s.score === 'number') return true;
    if (isAccepted(s.verdict)) return typeof s.max_points === 'number';
    return isUnambiguouslyZeroVerdict(s.verdict);
  });
  const hasAnyIoiScoreEvidence = result.submissions.some(s => typeof s.score === 'number' || (isAccepted(s.verdict) && typeof s.max_points === 'number'));
  const canComputeIoiFromSubs = hasCompleteIoiEvidence && (hasAnyIoiScoreEvidence || result.score === 0);

  for (const [problemId, subs] of byProblem) {
    const ordered = subs.map((s, idx) => ({ s, idx })).sort((a, b) => a.s.elapsed_ms - b.s.elapsed_ms || a.idx - b.idx).map(x => x.s);
    let firstAc: ResultSubmission | undefined;
    let wrongBeforeAc = 0;
    let bestSubScore = 0;
    let bestSubElapsed = 0;

    for (const s of ordered) {
      const subPts = typeof s.score === 'number' ? s.score : isAccepted(s.verdict) ? (s.max_points ?? 0) : 0;
      if (subPts > bestSubScore) {
        bestSubScore = subPts;
        bestSubElapsed = s.elapsed_ms;
      }
      if (!firstAc) {
        if (isAccepted(s.verdict)) firstAc = s;
        else if (!isNonPenalized(s.verdict)) wrongBeforeAc++;
      }
    }

    if (bestSubScore > 0) {
      ioiPoints += bestSubScore;
      lastImproveMs = Math.max(lastImproveMs, bestSubElapsed);
    }

    if (firstAc) {
      solved++;
      lastAcMs = Math.max(lastAcMs, firstAc.elapsed_ms);
      const minutes = Math.floor(firstAc.elapsed_ms / 60_000);
      const icpcPen = minutes + 20 * wrongBeforeAc;
      penaltyMinutes += icpcPen;

      const explicitCfBase = typeof firstAc.max_points === 'number'
        ? firstAc.max_points
        : (typeof firstAc.score === 'number' && firstAc.score > 0 ? firstAc.score : undefined);
      let problemCf = 0;
      if (explicitCfBase !== undefined) {
        const wrongDeduction = explicitCfBase >= 500 ? 50 : explicitCfBase * 0.1;
        const rawCf = Math.max(0.3 * explicitCfBase, explicitCfBase * (1 - minutes / 250) - wrongDeduction * wrongBeforeAc);
        problemCf = explicitCfBase >= 100 ? Math.round(rawCf) : Math.round(rawCf * 100) / 100;
        cfPoints += problemCf;
      } else {
        missingCfWeight = true;
      }

      per_problem[problemId] = {
        solved: true,
        attempts_before_ac: wrongBeforeAc,
        first_ac_ms: firstAc.elapsed_ms,
        ...(mode === 'icpc' ? { penalty_minutes: icpcPen } : {}),
        points: mode === 'cf' ? problemCf : mode === 'ioi' ? bestSubScore : (firstAc.score ?? firstAc.max_points ?? 1),
      };
    } else {
      per_problem[problemId] = {
        solved: false,
        attempts_before_ac: wrongBeforeAc,
        points: mode === 'ioi' ? bestSubScore : 0,
      };
    }
  }

  const resolvedLastAc = solved > 0 ? lastAcMs : undefined;

  if (mode === 'icpc') {
    return {
      mode, primary: solved, secondary: penaltyMinutes, solved, penalty_minutes: penaltyMinutes,
      tie_break_ms: lastAcMs, ...(resolvedLastAc !== undefined ? { last_ac_ms: resolvedLastAc } : {}), per_problem,
    };
  }
  if (mode === 'ioi') {
    if (canComputeIoiFromSubs) {
      const total = Math.round(ioiPoints * 1000) / 1000;
      return {
        mode, primary: total, secondary: lastImproveMs, solved, points: total,
        tie_break_ms: lastImproveMs, ...(resolvedLastAc !== undefined ? { last_ac_ms: resolvedLastAc } : {}), per_problem,
      };
    }
    return {
      mode, primary: result.score, secondary: lastAcMs, solved, points: result.score,
      tie_break_ms: lastAcMs, ...(resolvedLastAc !== undefined ? { last_ac_ms: resolvedLastAc } : {}),
      ...(result.submissions.length > 0 && result.score > 0 ? { scoring_unavailable: true } : {}),
      per_problem,
    };
  }
  if (mode === 'cf') {
    if (missingCfWeight) {
      return {
        mode, primary: result.score, secondary: lastAcMs, solved, points: result.score,
        tie_break_ms: lastAcMs, ...(resolvedLastAc !== undefined ? { last_ac_ms: resolvedLastAc } : {}),
        scoring_unavailable: true, per_problem,
      };
    }
    const total = Math.round(cfPoints * 100) / 100;
    return {
      mode, primary: total, secondary: lastAcMs, solved, points: total,
      tie_break_ms: lastAcMs, ...(resolvedLastAc !== undefined ? { last_ac_ms: resolvedLastAc } : {}), per_problem,
    };
  }
  return {
    mode: 'last_ac', primary: result.score, secondary: lastAcMs, solved, points: result.score,
    tie_break_ms: lastAcMs, ...(resolvedLastAc !== undefined ? { last_ac_ms: resolvedLastAc } : {}), per_problem,
  };
}

export function compareScoredResults(a: ScoredResult, b: ScoredResult) {
  return b.primary - a.primary || a.secondary - b.secondary || a.tie_break_ms - b.tie_break_ms;
}

export type RankOptions = {
  family?: string;
  vendor?: string;
  scoring?: ScoringMode;
  groupBy?: 'revision' | 'model';
};

export type RankedEntry = {
  result: Result;
  finish_ms: number;
  scoring: ScoredResult;
};

export type RankedRow = RankedEntry & {
  rank: number | null;
  variants?: RankedEntry[];
};

export function rankResults(bundle: unknown, family?: string, vendor?: string): RankedRow[][];
export function rankResults(bundle: unknown, opts: RankOptions): RankedRow[][];
export function rankResults(bundle: unknown, familyOrOpts?: string | RankOptions, vendorArg?: string): RankedRow[][] {
  const opts: RankOptions = typeof familyOrOpts === 'object' && familyOrOpts !== null
    ? familyOrOpts
    : { family: familyOrOpts, vendor: vendorArg };
  const groupBy = opts.groupBy ?? 'revision';
  const group = new Map<string, Result[]>();
  for (const rawResult of resultsSchema.parse(bundle).results) {
    const result = rawResult as Result;
    if ((opts.family && result.model.family !== opts.family) || (opts.vendor && (!('vendor' in result.model) || result.model.vendor !== opts.vendor))) continue;
    const key = JSON.stringify([result.contest_id, result.data_version, result.contest_revision, result.protocol_id, result.protocol_version, result.protocol_sha256]);
    const rows = group.get(key) ?? [];
    rows.push(result);
    group.set(key, rows);
  }
  return [...group.values()].map(rows => {
    const mode = opts.scoring ?? rows.find(r => r.scoring_mode)?.scoring_mode ?? 'last_ac';
    // Rankable entries always sort ahead of entries whose score cannot be recomputed in the selected mode.
    const sorted: RankedEntry[] = rows
      .map(result => {
        const scoring = scoreResult(result, mode);
        return { result, finish_ms: scoring.tie_break_ms, scoring };
      })
      .sort((a, b) =>
        Number(Boolean(a.scoring.scoring_unavailable)) - Number(Boolean(b.scoring.scoring_unavailable)) ||
        compareScoredResults(a.scoring, b.scoring) ||
        a.result.run_id.localeCompare(b.result.run_id),
      );

    if (groupBy === 'model') {
      // Policy C: group first by canonical (vendor, requested_model), then deduplicate
      // distinct (agent_id, agent_revision, reasoning_effort, speed_tier) variants within each group.
      // Because `sorted` places rankable entries first, a rankable variant is always chosen as primary
      // over an unrankable one; models with only unrankable variants receive rank: null.
      const modelGroups = new Map<string, { seenVariants: Set<string>; variants: RankedEntry[] }>();
      for (const row of sorted) {
        const modelKey = JSON.stringify([(row.result.model.vendor ?? '').toLowerCase(), row.result.model.requested]);
        let bucket = modelGroups.get(modelKey);
        if (!bucket) {
          bucket = { seenVariants: new Set(), variants: [] };
          modelGroups.set(modelKey, bucket);
        }
        const variantKey = JSON.stringify([
          row.result.agent_id,
          row.result.agent_revision,
          row.result.model.reasoning_effort ?? '',
          row.result.model.speed_tier ?? 'standard',
        ]);
        if (bucket.seenVariants.has(variantKey)) continue;
        bucket.seenVariants.add(variantKey);
        bucket.variants.push(row);
      }
      let rank = 0;
      let index = 0;
      let prev: RankedEntry | undefined;
      return [...modelGroups.values()].map<RankedRow>(({ variants }) => {
        const primary = variants[0]!;
        if (primary.scoring.scoring_unavailable) {
          return { rank: null, ...primary, variants };
        }
        index++;
        if (!prev || compareScoredResults(prev.scoring, primary.scoring) !== 0) rank = index;
        prev = primary;
        return { rank, ...primary, variants };
      });
    }

    const seen = new Set<string>();
    let rank = 0;
    let index = 0;
    let prev: RankedEntry | undefined;
    return sorted.flatMap<RankedRow>(row => {
      const key = JSON.stringify([row.result.agent_id, row.result.agent_revision, row.result.model.speed_tier ?? 'standard']);
      if (seen.has(key)) return [];
      seen.add(key);
      if (row.scoring.scoring_unavailable) {
        return [{ rank: null, ...row }];
      }
      index++;
      if (!prev || compareScoredResults(prev.scoring, row.scoring) !== 0) rank = index;
      prev = row;
      return [{ rank, ...row }];
    });
  });
}

export function rankResultsGrouped(bundle: unknown, opts: Omit<RankOptions, 'groupBy'> = {}): RankedRow[][] {
  return rankResults(bundle, { ...opts, groupBy: 'model' });
}
