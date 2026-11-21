import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Inputs } from './config.js';
import { createContest, type EventSink } from './contest.js';
import type { ProgramJudge } from './codeforces.js';

export const submissionSchema = z.union([
  z.strictObject({ problem_id: z.string().max(128), answer: z.string().min(1).max(4096) }),
  z.strictObject({ problem_id: z.string().max(128), language: z.string().max(128), source: z.string().min(1).max(200_000) }),
]);
export const statusSchema = z.strictObject({ submission_id: z.string().max(20).optional() });
export function match(inputs: Inputs, emit: EventSink, judge?: ProgramJudge, now = () => performance.now(), pollMs = 2500) {
  const start = now();
  const elapsed = () => Math.max(0, Math.floor(now() - start));
  const { time_limit_ms, max_submissions } = inputs.contest.rules;
  const local = createContest(inputs.judge, emit, { timeLimitMs: time_limit_ms, maxSubmissions: max_submissions }, now);
  const accepted = new Set<string>();
  const jobs = new Map<string, { problem: string; verdict: string; remote?: number }>();
  const problems = new Map(inputs.contest.problems.map(p => [p.id, p.max_points]));
  const uploads = new Set<Promise<void>>();
  const remote = new Map<number, string>();
  const stop = new AbortController();
  let closed = false, score = 0;
  let failure: unknown;
  let chain = Promise.resolve();
  let nextPoll = 0;
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
    const verdicts = await judge.verdicts(pending.map(j => j.remote!), remote, stop.signal);
    for (const [id, verdict] of verdicts) {
      const entry = [...jobs].find(([, row]) => row.remote === id && row.verdict === 'pending');
      if (!entry) continue;
      const [submission_id, row] = entry;
      row.verdict = verdict;
      emit({ type: 'submission_judged', submission_id, verdict, remote_submission_id: id });
    }
    accepted.clear();
    score = 0;
    for (const row of jobs.values()) if ((row.verdict === 'OK' || row.verdict === 'AC') && !accepted.has(row.problem)) {
      accepted.add(row.problem); score += problems.get(row.problem)!;
    }
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
    if (!('source' in raw) || backend.kind !== 'codeforces' || !problems.has(raw.problem_id) ||
      !Object.hasOwn(backend.languages, raw.language) || Buffer.byteLength(raw.source) > 200_000) return { verdict: 'invalid_submission' };
    if (jobs.size >= max_submissions) return { verdict: 'submission_limit' };
    const submission_id = `s${jobs.size + 1}`;
    const row: { problem: string; verdict: string; remote?: number } = { problem: raw.problem_id, verdict: 'pending' };
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
    if (submission_id) return { submission_id, verdict: jobs.get(submission_id)?.verdict ?? 'unknown_submission' };
    return { remaining_ms: Math.max(0, time_limit_ms - elapsed()), accepted: [...accepted], pending: [...jobs].filter(([, j]) => j.verdict === 'pending').map(([id]) => id) };
  }
  return { elapsed, submit, status, close: () => { closed = true; }, score: () => judge ? score : local.score(), failed: () => !!failure,
    hasPending: () => [...jobs.values()].some(j => j.verdict === 'pending'),
    async settle(signal: AbortSignal) {
      const abort = () => stop.abort(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      try {
        while (!signal.aborted && !failure && (uploads.size || [...jobs.values()].some(j => j.verdict === 'pending'))) {
          await poll();
          await new Promise<void>(resolve => {
            const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve(); };
            const timer = setTimeout(end, Math.min(250, pollMs));
            signal.addEventListener('abort', end, { once: true });
            if (signal.aborted) end();
          });
        }
        if (failure || signal.aborted) throw new Error('Judge did not settle');
      } finally { signal.removeEventListener('abort', abort); }
    },
    async dispose() { closed = true; clearInterval(timer); stop.abort(); await Promise.allSettled([...uploads, polling]); },
  };
}
