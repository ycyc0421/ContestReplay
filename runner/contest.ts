import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Inputs } from './config.js';

export type EventSink = (event: Record<string, unknown>) => void;

export function createContest(judge: Inputs['judge'], event: EventSink, limits: { timeLimitMs: number; maxSubmissions: number }, now = () => performance.now()) {
  const problems = new Map(judge.problems.map(p => [p.id, p]));
  const accepted = new Set<string>();
  const verdicts = new Map<string, string>();
  const start = now();
  let submissions = 0;
  let score = 0;
  let finished = false;
  const elapsed = () => Math.max(0, Math.floor(now() - start));
  const closed = () => finished || elapsed() >= limits.timeLimitMs;
  const submit = (problem_id: string, answer: string) => {
    const elapsed_ms = elapsed();
    if (finished || elapsed_ms >= limits.timeLimitMs) return { verdict: 'contest_closed' };
    if (submissions >= limits.maxSubmissions) return { verdict: 'submission_limit' };
    const submission_id = `s${++submissions}`;
    event({ type: 'submission_received', elapsed_ms, submission_id, problem_id, answer });
    const problem = problems.get(problem_id);
    let points_awarded = 0;
    let verdict = 'invalid_submission';
    if (problem && answer.trim()) {
      if (accepted.has(problem_id)) verdict = 'already_accepted';
      else if (!problem.accepted_answers.includes(answer.trim())) verdict = 'wrong_answer';
      else {
        verdict = 'accepted';
        points_awarded = problem.max_points;
        score += points_awarded;
        accepted.add(problem_id);
      }
    }
    verdicts.set(submission_id, verdict);
    event({ type: 'submission_judged', submission_id, verdict, points_awarded });
    return { submission_id, verdict };
  };
  const finish = () => {
    if (closed()) return { status: 'contest_closed' };
    finished = true;
    return { status: 'finished' };
  };
  const status = (submission_id?: string) => submission_id ? { submission_id, verdict: verdicts.get(submission_id) ?? 'unknown_submission' } :
    { remaining_ms: Math.max(0, limits.timeLimitMs - elapsed()), accepted: [...accepted], pending: [] };
  return { elapsed, submit, status, finish, finished: () => finished, score: () => score,
    maxScore: judge.problems.reduce((sum, p) => sum + p.max_points, 0) };
}

export const submitArgs = z.strictObject({ problem_id: z.string().max(128), answer: z.string().max(4096) });
export const statusArgs = z.strictObject({ submission_id: z.string().max(20).optional() });
export const finishArgs = z.strictObject({});

export function createMcp(contest: ReturnType<typeof createContest>) {
  const mcp = new McpServer({ name: 'contestreplay-contest', version: '0.1.0' });
  const result = (value: Record<string, unknown>) => ({ structuredContent: value,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  mcp.registerTool('submit', { description: 'Submit one final answer.', inputSchema: submitArgs },
    ({ problem_id, answer }) => result(contest.submit(problem_id, answer)));
  mcp.registerTool('status', { description: 'Read a verdict or contest status.', inputSchema: statusArgs }, ({ submission_id }) => result(contest.status(submission_id)));
  mcp.registerTool('finish', { description: 'End this contest.', inputSchema: finishArgs }, () => result(contest.finish()));
  return mcp;
}
