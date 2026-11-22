import type { RunReplayContract } from '@studio-api';

type Replay = RunReplayContract;
type Problem = Replay['problems'][number];
type Submission = Replay['submissions'][number];
type ScoringMode = Replay['scoring_mode'];
type Status = 'unattempted' | 'pending' | 'accepted' | 'partial' | 'wrong';

const roundScore = (value: number) => Math.round(Math.max(0, value) * 100) / 100;
const accepted = (verdict: string) => ['accepted', 'ac', 'ok'].includes(verdict.trim().toLowerCase());
const pending = (verdict: string) => ['pending', 'testing', 'queued', 'running', 'judging'].includes(verdict.trim().toLowerCase());
const explicitWrong = (verdict: string) => ['wrong_answer', 'wa', 'time_limit_exceeded', 'tle', 'memory_limit_exceeded', 'mle', 'runtime_error', 're', 'compilation_error', 'ce', 'compile_error', 'invalid_submission', 'presentation_error', 'pe', 'output_limit_exceeded', 'ole', 'rejected'].includes(verdict.trim().toLowerCase());
const noPenalty = (verdict: string) => ['compilation_error', 'ce', 'compile_error', 'invalid_submission', 'already_accepted', 'contest_closed', 'submission_limit', 'judge_unavailable', 'skipped'].includes(verdict.trim().toLowerCase());

export interface ReplayProblemProjection {
  id: string; status: Status; attempts: number; wrong_attempts: number; score: number; max_points: number;
  first_ac_ms?: number; last_verdict?: string;
}

function projectProblem(problem: Problem, submissions: Submission[], timeLimitMs: number, cursor: number, mode: ScoringMode) {
  let attempts = 0; let wrongBeforeAc = 0; let isAccepted = false; let firstAcMs: number | undefined;
  let bestPartial = 0; let hasPending = false; let lastVerdict: string | undefined;
  for (const submission of submissions) {
    attempts++;
    const verdictKnown = !pending(submission.verdict) && (submission.judged_ms === undefined || submission.judged_ms <= cursor);
    if (!verdictKnown) {
      hasPending = true;
      if (!isAccepted) lastVerdict = 'pending';
      continue;
    }
    if (!isAccepted) lastVerdict = submission.verdict;
    const wrong = explicitWrong(submission.verdict);
    const rawPoints = submission.score !== undefined
      ? problem.max_points > 0 ? Math.min(problem.max_points, submission.score) : submission.score
      : accepted(submission.verdict) ? problem.max_points : 0;
    if (submission.verdict.trim().toLowerCase() === 'already_accepted') continue;
    if (mode === 'ioi') {
      const solved = problem.max_points > 0 && rawPoints >= problem.max_points && !wrong;
      bestPartial = Math.max(bestPartial, rawPoints);
      if (solved) {
        isAccepted = true;
        firstAcMs = Math.min(firstAcMs ?? Infinity, submission.received_ms);
        lastVerdict = submission.verdict;
      } else if (!isAccepted && !noPenalty(submission.verdict)) wrongBeforeAc++;
    } else {
      if (accepted(submission.verdict)) {
        isAccepted = true;
        firstAcMs = Math.min(firstAcMs ?? Infinity, submission.received_ms);
        lastVerdict = submission.verdict;
      } else if (!isAccepted && !noPenalty(submission.verdict)) {
        wrongBeforeAc++;
        bestPartial = Math.max(bestPartial, rawPoints);
      }
    }
  }
  let score = 0; let maxPoints = problem.max_points;
  if (mode === 'icpc') {
    score = isAccepted ? 1 : 0;
    maxPoints = 1;
  } else if (mode === 'cf' && isAccepted && firstAcMs !== undefined) {
    const fraction = timeLimitMs > 0 ? Math.min(1, Math.max(0, firstAcMs / timeLimitMs)) : 0;
    const wrongPenalty = (problem.max_points >= 500 ? 50 : 0.1 * problem.max_points) * wrongBeforeAc;
    score = roundScore(Math.max(0.3 * problem.max_points, problem.max_points * (1 - 0.5 * fraction) - wrongPenalty));
  } else if (mode === 'ioi') score = roundScore(bestPartial);
  else if (mode === 'last_ac') score = roundScore(isAccepted ? problem.max_points : bestPartial);
  const status: Status = isAccepted ? 'accepted' : hasPending ? 'pending' : score > 0 ? 'partial' : attempts > 0 ? 'wrong' : 'unattempted';
  return {
    projected: { id: problem.id, status, attempts, wrong_attempts: wrongBeforeAc, score, max_points: maxPoints,
      ...(firstAcMs !== undefined ? { first_ac_ms: firstAcMs } : {}), ...(lastVerdict !== undefined ? { last_verdict: lastVerdict } : {}) } satisfies ReplayProblemProjection,
    isAccepted, firstAcMs,
  };
}

export function projectReplayAt(replay: Replay, atElapsedMs: number) {
  const cursor = Math.max(0, Math.floor(atElapsedMs));
  const byProblem = new Map<string, Submission[]>();
  for (const submission of replay.submissions) {
    if (submission.received_ms > cursor) continue;
    const list = byProblem.get(submission.problem_id) ?? [];
    list.push(submission);
    byProblem.set(submission.problem_id, list);
  }
  for (const list of byProblem.values()) list.sort((a, b) => a.received_ms - b.received_ms);
  let score = 0; let maxScore = 0; let solved = 0; let lastAcMs = 0;
  const problems = replay.problems.map(problem => {
    const result = projectProblem(problem, byProblem.get(problem.id) ?? [], replay.time_limit_ms, cursor, replay.scoring_mode);
    score += result.projected.score;
    maxScore += result.projected.max_points;
    if (result.isAccepted) {
      solved++;
      if (result.firstAcMs !== undefined) lastAcMs = Math.max(lastAcMs, result.firstAcMs);
    }
    return result.projected;
  });
  return { at_elapsed_ms: cursor, scoring_mode: replay.scoring_mode, score: roundScore(score), max_score: roundScore(maxScore), solved_count: solved, last_ac_ms: lastAcMs, problems };
}
