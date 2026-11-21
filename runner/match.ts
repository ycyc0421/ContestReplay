import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Inputs } from './config.js';
import { createContest, type EventSink } from './contest.js';
import type { ProgramJudge as LegacyProgramJudge } from './codeforces.js';
import { normalizeVerdict, type JudgeVerdict, type ProgramJudge as UnifiedProgramJudge } from './judges/types.js';

export type AnyProgramJudge = LegacyProgramJudge | UnifiedProgramJudge;

export const submissionSchema = z.union([
  z.strictObject({ problem_id: z.string().max(128), answer: z.string().min(1).max(4096) }),
  z.strictObject({ problem_id: z.string().max(128), language: z.string().max(128), source: z.string().min(1).max(200_000) }),
]);
export const statusSchema = z.strictObject({ submission_id: z.string().max(20).optional() });

function scalePartialScore(value: number, maxPoints: number, remoteMaxScore?: number): number {
  if (!Number.isFinite(value) || value <= 0 || maxPoints <= 0) return 0;
  if (remoteMaxScore !== undefined && Number.isFinite(remoteMaxScore) && remoteMaxScore > 0 && remoteMaxScore !== maxPoints) {
    const scaled = (value / remoteMaxScore) * maxPoints;
    return Math.min(maxPoints, Math.max(0, Math.round(scaled * 1000) / 1000));
  }
  return Math.min(maxPoints, Math.max(0, value));
}

export function match(
  inputs: Inputs,
  emit: EventSink,
  judge?: AnyProgramJudge,
  now = () => performance.now(),
  pollMs = 2500,
) {
  const start = now();
  const elapsed = () => Math.max(0, Math.floor(now() - start));
  const { time_limit_ms, max_submissions } = inputs.contest.rules;
  const local = createContest(inputs.judge, emit, { timeLimitMs: time_limit_ms, maxSubmissions: max_submissions }, now);
  const accepted = new Set<string>();
  const bestScores = new Map<string, number>();
  const jobs = new Map<string, { problem: string; verdict: string; remote?: string | number; score?: number }>();
  const problems = new Map(inputs.contest.problems.map(p => [p.id, p.max_points]));
  const uploads = new Set<Promise<void>>();
  const remote = new Map<string | number, string>();
  const stop = new AbortController();
  let closed = false;
  let score = 0;
  let failure: unknown;
  let chain = Promise.resolve();
  let nextPoll = 0;

  const recomputeScore = () => {
    let total = 0;
    for (const pts of bestScores.values()) total += pts;
    score = Math.round(total * 1000) / 1000;
  };

  const fault = (err: unknown) => {
    if (failure || stop.signal.aborted) return;
    failure = err ?? new Error('Judge error');
    emit({ type: 'judge_error' });
  };

  const refresh = async () => {
    if (!judge || failure || performance.now() < nextPoll) return;
    const pending = [...jobs.values()].filter(j => j.verdict === 'pending' && j.remote !== undefined);
    if (!pending.length) return;
    nextPoll = performance.now() + pollMs;
    const pendingIds = pending.map(j => j.remote!);
    const verdicts = await (
      judge.verdicts as (
        ids: (string | number)[],
        problems: Map<string | number, string>,
        signal: AbortSignal,
      ) => Promise<Map<string | number, string | JudgeVerdict>>
    )(pendingIds, remote, stop.signal);

    for (const [id, rawVerdict] of verdicts) {
      const entry = [...jobs].find(([, row]) =>
        row.verdict === 'pending' && (row.remote === id || (row.remote !== undefined && String(row.remote) === String(id))),
      );
      if (!entry) continue;
      const [submission_id, row] = entry;
      const maxPts = problems.get(row.problem) ?? 0;

      if (typeof rawVerdict === 'string') {
        const normalized = normalizeVerdict(rawVerdict);
        if (normalized === 'pending') continue;
        if (normalized === 'judge_error') {
          row.verdict = 'judge_error';
          fault(new Error(`Judge infrastructure verdict: ${rawVerdict || 'judge_error'}`));
          return;
        }
        row.verdict = rawVerdict;
        const isAc = normalized === 'accepted';
        const subScore = isAc ? maxPts : 0;
        row.score = subScore;
        if (isAc) {
          accepted.add(row.problem);
        }
        bestScores.set(row.problem, Math.max(bestScores.get(row.problem) ?? 0, subScore));
        emit({
          type: 'submission_judged',
          submission_id,
          problem_id: row.problem,
          verdict: rawVerdict,
          remote_submission_id: id,
          score: subScore,
          max_points: maxPts,
          max_score: maxPts,
        });
      } else {
        const jv = rawVerdict;
        if (!jv.final || jv.verdict === 'pending') continue;
        if (jv.verdict === 'judge_error') {
          row.verdict = 'judge_error';
          fault(new Error(`Judge infrastructure verdict: ${jv.raw_verdict || 'judge_error'}`));
          return;
        }
        row.verdict = jv.verdict;
        let subScore = 0;
        if (jv.verdict === 'accepted') {
          subScore = maxPts;
          accepted.add(row.problem);
        } else if (typeof jv.score === 'number' && Number.isFinite(jv.score) && (jv.verdict === 'partial' || jv.score > 0)) {
          subScore = scalePartialScore(jv.score, maxPts, jv.max_score);
        }
        row.score = subScore;
        bestScores.set(row.problem, Math.max(bestScores.get(row.problem) ?? 0, subScore));
        emit({
          type: 'submission_judged',
          submission_id,
          problem_id: row.problem,
          verdict: jv.verdict,
          raw_verdict: jv.raw_verdict,
          remote_submission_id: id,
          score: subScore,
          max_points: maxPts,
          max_score: maxPts,
          ...(jv.max_score !== undefined && jv.max_score !== maxPts ? { remote_max_score: jv.max_score } : {}),
          ...(jv.time_ms !== undefined ? { time_ms: jv.time_ms } : {}),
          ...(jv.memory_kb !== undefined ? { memory_kb: jv.memory_kb } : {}),
        });
      }
    }
    recomputeScore();
  };

  let polling: Promise<void> | undefined;
  const poll = () => polling ??= refresh().catch(fault).finally(() => { polling = undefined; });
  const timer = judge ? setInterval(() => { void poll(); }, pollMs) : undefined;
  timer?.unref();

  function submit(raw: z.infer<typeof submissionSchema>) {
    if (closed || elapsed() >= time_limit_ms) return { verdict: 'contest_closed' };
    if (failure) return { verdict: 'judge_unavailable' };
    if (!judge) {
      if (!('answer' in raw)) return { verdict: 'invalid_submission' };
      const value = local.submit(raw.problem_id, raw.answer);
      if (value.submission_id) jobs.set(value.submission_id, { problem: raw.problem_id, verdict: value.verdict });
      if (value.verdict === 'accepted') accepted.add(raw.problem_id);
      return value;
    }
    const backend = inputs.contest.judge;
    if (
      !('source' in raw) ||
      backend.kind === 'local' ||
      !problems.has(raw.problem_id) ||
      !Object.hasOwn(backend.languages, raw.language) ||
      Buffer.byteLength(raw.source) > 200_000
    ) {
      return { verdict: 'invalid_submission' };
    }
    if (jobs.size >= max_submissions) return { verdict: 'submission_limit' };
    const submission_id = `s${jobs.size + 1}`;
    const row: { problem: string; verdict: string; remote?: string | number; score?: number } = {
      problem: raw.problem_id,
      verdict: 'pending',
    };
    jobs.set(submission_id, row);
    emit({ type: 'submission_received', submission_id, problem_id: raw.problem_id, language: raw.language, source: raw.source });
    const upload = chain.then(async () => {
      stop.signal.throwIfAborted();
      if (failure) return;
      const id = await judge.submit(raw.problem_id, raw.language, raw.source, stop.signal);
      if (remote.has(id)) throw new Error('Duplicate remote submission ID');
      row.remote = id;
      remote.set(id, raw.problem_id);
      emit({ type: 'submission_delivered', submission_id, remote_submission_id: id });
    }).catch(fault);
    chain = upload;
    uploads.add(upload);
    void upload.then(() => uploads.delete(upload));
    return { submission_id, verdict: 'pending' };
  }

  function status(submission_id?: string) {
    if (submission_id) {
      const row = jobs.get(submission_id);
      if (!row) return { submission_id, verdict: 'unknown_submission' };
      return {
        submission_id,
        verdict: row.verdict,
        ...(row.score !== undefined ? { score: row.score } : {}),
      };
    }
    return {
      remaining_ms: Math.max(0, time_limit_ms - elapsed()),
      accepted: [...accepted],
      pending: [...jobs].filter(([, j]) => j.verdict === 'pending').map(([id]) => id),
    };
  }

  return {
    elapsed,
    submit,
    status,
    close: () => { closed = true; },
    score: () => judge ? score : local.score(),
    failed: () => !!failure,
    hasPending: () => [...jobs.values()].some(j => j.verdict === 'pending'),
    async settle(signal: AbortSignal) {
      const abort = () => stop.abort(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      try {
        while (!signal.aborted && !failure && (uploads.size || [...jobs.values()].some(j => j.verdict === 'pending'))) {
          await poll();
          await new Promise<void>(resolve => {
            const end = () => { clearTimeout(t); signal.removeEventListener('abort', end); resolve(); };
            const t = setTimeout(end, Math.min(250, pollMs));
            signal.addEventListener('abort', end, { once: true });
            if (signal.aborted) end();
          });
        }
        if (failure || signal.aborted) throw new Error('Judge did not settle');
      } finally { signal.removeEventListener('abort', abort); }
    },
    async dispose() {
      closed = true;
      clearInterval(timer);
      stop.abort();
      await Promise.allSettled([...uploads, polling]);
    },
  };
}
