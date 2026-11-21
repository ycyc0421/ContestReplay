import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Inputs } from './config.js';
import { submitCodeforcesWeb } from './cf-web.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const exec = promisify(execFile);
const statuses = z.object({ status: z.literal('OK'), result: z.array(z.object({ id: z.number().int().positive(), contestId: z.number().int().optional(),
  problem: z.object({ index: z.string(), contestId: z.number().int().optional() }), author: z.object({ members: z.array(z.object({ handle: z.string() })), participantType: z.string().optional() }),
  programmingLanguage: z.string().optional(), creationTimeSeconds: z.number().int().optional(), verdict: z.string().optional() })) });
type StatusRow = z.infer<typeof statuses>['result'][number];
async function userSubmissions(handle: string, count: number, signal: AbortSignal) {
  return statuses.parse(await cfApi('user.status', { handle, from: '1', count: String(count) }, signal)).result;
}
export function exactPracticeCandidates(rows: StatusRow[], query: { baseline: number; contest: number; problem: string; handle: string; since: number }) {
  return rows.filter(row => row.id > query.baseline && (row.contestId ?? row.problem.contestId) === query.contest &&
    row.problem.index === query.problem && row.author.participantType === 'PRACTICE' &&
    row.author.members.length === 1 && row.author.members[0]?.handle.toLowerCase() === query.handle.toLowerCase() &&
    (row.creationTimeSeconds ?? 0) >= query.since).map(row => row.id);
}
export async function cfApi(method: 'user.status' | 'contest.standings', params: Record<string, string>, signal?: AbortSignal) {
  const url = new URL(`https://codeforces.com/api/${method}`);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
  if (!response.ok) throw new Error(`Codeforces API HTTP ${response.status}`);
  return await response.json() as unknown;
}
export async function importCodeforces(contest: number, signal?: AbortSignal) {
  return z.object({ status: z.literal('OK'), result: z.object({ contest: z.object({ name: z.string(), phase: z.literal('FINISHED') }),
    problems: z.array(z.object({ index: z.string(), points: z.number().positive().optional() })).min(1) }) }).parse(await cfApi('contest.standings', {
    contestId: String(contest),
  }, signal)).result;
}
function cfExecutable() {
  const executable = process.env.CR_CODEFORCES_SUBMITTER;
  if (executable && !isAbsolute(executable)) throw new Error('CR_CODEFORCES_SUBMITTER must be an absolute executable path');
  return executable;
}
export async function checkCodeforces() {
  const executable = cfExecutable();
  if (executable) await access(executable, constants.X_OK);
  else if (!process.env.CR_CODEFORCES_COOKIE?.trim()) throw new Error('Set CR_CODEFORCES_SUBMITTER or CR_CODEFORCES_COOKIE');
}
type Backend = Extract<Inputs['contest']['judge'], { kind: 'codeforces' }>;
export interface ProgramJudge {
  submit(problem: string, language: string, source: string, signal: AbortSignal): Promise<number>;
  verdicts(ids: number[], problems: Map<number, string>, signal: AbortSignal): Promise<Map<number, string>>;
}
export function codeforces(backend: Backend): ProgramJudge {
  const executable = cfExecutable();
  let checkedContest: Promise<unknown> | undefined;
  const targetFor = (problem: string) => Object.hasOwn(backend.problem_map ?? {}, problem) ? backend.problem_map![problem]! : problem;
  return {
    async submit(problem, language, source, signal) {
      checkedContest ??= importCodeforces(backend.contest_id, signal);
      await checkedContest;
      const target = targetFor(problem);
      if (!executable) {
        const cookie = process.env.CR_CODEFORCES_COOKIE;
        if (!cookie) throw new Error('Missing Codeforces session');
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        let baseline = 0;
        let since = 0;
        return submitCodeforcesWeb({ contest: backend.contest_id, problem: target,
          language: backend.languages[language]!, source, handle: backend.handle, cookie, signal: requestSignal,
          async beforePost() {
            const before = await userSubmissions(backend.handle, 10, requestSignal);
            baseline = Math.max(0, ...before.map(row => row.id));
            since = Math.floor(Date.now() / 1000) - 10;
          },
          async correlate() {
            const { setTimeout: delay } = await import('node:timers/promises');
            for (let i = 0; i < 4; i++) {
              await delay(2500, undefined, { signal: requestSignal });
              const rows = await userSubmissions(backend.handle, 30, requestSignal);
              const candidates = exactPracticeCandidates(rows, { baseline, contest: backend.contest_id, problem: target, handle: backend.handle, since });
              if (candidates.length === 1 && rows.filter(row => row.id > baseline).length === 1) return candidates[0]!;
              if (rows.some(row => row.id > baseline)) throw new Error('Ambiguous Codeforces submission: the account must be dedicated to this run');
            }
            throw new Error('Could not confirm the Codeforces submission ID');
          },
        });
      }
      const dir = await mkdtemp(join(tmpdir(), 'cr-submit-'));
      try {
        const file = join(dir, 'source');
        await writeFile(file, source, { mode: 0o600 });
        // No shell, no discovery of "latest submission", and never retry a write
        // whose outcome is unknown. Operator installs the authorized transport.
        const { stdout } = await exec(executable, [String(backend.contest_id), target,
          String(backend.languages[language]), file, backend.handle], { signal, timeout: 30_000, maxBuffer: 4096 });
        return z.strictObject({ submission_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).parse(JSON.parse(stdout)).submission_id;
      } finally { await rm(dir, { recursive: true, force: true }); }
    },
    async verdicts(ids, problems, signal) {
      const rows = await userSubmissions(backend.handle, 1000, signal);
      const wanted = new Set(ids);
      const result = new Map<number, string>();
      for (const row of rows) if (wanted.has(row.id)) {
        const problem = problems.get(row.id)!;
        if ((row.contestId ?? row.problem.contestId) !== backend.contest_id || row.problem.index !== targetFor(problem) || row.author.participantType !== 'PRACTICE' ||
          row.author.members.length !== 1 || row.author.members[0]?.handle.toLowerCase() !== backend.handle.toLowerCase()) throw new Error('Remote submission identity mismatch');
        if (row.verdict && !['TESTING', 'SUBMITTED'].includes(row.verdict)) result.set(row.id, row.verdict);
      }
      return result;
    },
  };
}
