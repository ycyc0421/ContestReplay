import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'parse5';
import { z } from 'zod';
import type { OjPlatform } from '../oj-accounts.js';

export type NormalizedVerdict =
  | 'pending'
  | 'accepted'
  | 'partial'
  | 'wrong_answer'
  | 'time_limit_exceeded'
  | 'memory_limit_exceeded'
  | 'runtime_error'
  | 'compilation_error'
  | 'presentation_error'
  | 'idleness_limit_exceeded'
  | 'judge_error'
  | 'other';

export interface JudgeVerdict {
  remote_submission_id: string;
  verdict: NormalizedVerdict;
  raw_verdict: string;
  score?: number;
  max_score?: number;
  time_ms?: number;
  memory_kb?: number;
  final: boolean;
}

export interface LanguagePreset {
  id: string;
  label: string;
  remote_id: string;
  family?: string;
}

export interface ContestPreviewProblem {
  remote_id: string;
  title?: string;
  max_points?: number;
  upstream_oj?: string;
  upstream_problem?: string;
}

export interface ContestPreview {
  platform: OjPlatform;
  contest_ref: string;
  title: string;
  status: 'finished' | 'active' | 'unknown';
  problems: ContestPreviewProblem[];
  suggested_languages: LanguagePreset[];
  statement_pdf_url?: string;
}

export interface ProgramJudge {
  readonly kind: OjPlatform;
  readonly settlementMs: number;
  submit(problem: string, language: string, source: string, signal: AbortSignal): Promise<string>;
  verdicts(ids: string[], problems: Map<string, string>, signal: AbortSignal): Promise<Map<string, JudgeVerdict>>;
  dispose?(): Promise<void>;
}

export type JudgeInfrastructureErrorCode =
  | 'auth_expired'
  | 'captcha_required'
  | 'upstream_unavailable'
  | 'rate_limited'
  | 'submission_unconfirmed'
  | 'identity_mismatch'
  | 'submitter_failed';

export class JudgeInfrastructureError extends Error {
  constructor(
    readonly code: JudgeInfrastructureErrorCode,
    message: string,
    readonly details?: { platform?: OjPlatform; status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = 'JudgeInfrastructureError';
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

export const defaultExecFile: ExecFileLike = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

export function normalizeVerdict(raw: string, score?: number, maxScore?: number): NormalizedVerdict {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');

  if (
    !normalized ||
    normalized === 'pending' ||
    normalized === 'waiting' ||
    normalized === 'queued' ||
    normalized === 'in_queue' ||
    normalized === 'submitted' ||
    normalized === 'submitting' ||
    normalized === 'testing' ||
    normalized === 'judging' ||
    normalized === 'running' ||
    normalized === 'compiling' ||
    normalized === 'fetched' ||
    normalized === 'rejudging' ||
    normalized.startsWith('running_on_test') ||
    normalized.startsWith('judging_on_test')
  ) {
    return 'pending';
  }

  if (
    normalized === 'ok' ||
    normalized === 'ac' ||
    normalized === 'accepted' ||
    normalized === 'happy_new_year!'
  ) {
    return 'accepted';
  }

  if (
    normalized === 'partial' ||
    normalized === 'partially_accepted' ||
    normalized === 'partial_accepted' ||
    normalized === 'partial_score'
  ) {
    return 'partial';
  }

  if (
    normalized === 'wa' ||
    normalized === 'wrong_answer' ||
    normalized === 'incorrect' ||
    normalized === 'rejected' ||
    normalized === 'failed' ||
    normalized === 'hacked' ||
    normalized === 'challenged'
  ) {
    if (score !== undefined && score > 0 && (maxScore === undefined || score < maxScore)) {
      return 'partial';
    }
    return 'wrong_answer';
  }

  if (normalized === 'tle' || normalized === 'time_limit_exceeded' || normalized === 'time_limit') {
    if (score !== undefined && score > 0 && (maxScore === undefined || score < maxScore)) {
      return 'partial';
    }
    return 'time_limit_exceeded';
  }

  if (normalized === 'mle' || normalized === 'memory_limit_exceeded' || normalized === 'memory_limit') {
    if (score !== undefined && score > 0 && (maxScore === undefined || score < maxScore)) {
      return 'partial';
    }
    return 'memory_limit_exceeded';
  }

  if (
    normalized === 're' ||
    normalized === 'rte' ||
    normalized === 'runtime_error' ||
    normalized === 'dangerous_syscalls' ||
    normalized === 'output_limit_exceeded' ||
    normalized === 'ole'
  ) {
    if (score !== undefined && score > 0 && (maxScore === undefined || score < maxScore)) {
      return 'partial';
    }
    return 'runtime_error';
  }

  if (
    normalized === 'ce' ||
    normalized === 'compile_error' ||
    normalized === 'compilation_error' ||
    normalized === 'compile_time_error'
  ) {
    return 'compilation_error';
  }

  if (normalized === 'pe' || normalized === 'presentation_error') {
    return 'presentation_error';
  }

  if (normalized === 'ile' || normalized === 'idleness_limit_exceeded' || normalized === 'idleness_limit') {
    return 'idleness_limit_exceeded';
  }

  if (
    normalized === 'je' ||
    normalized === 'se' ||
    normalized === 'uke' ||
    normalized === 'judge_error' ||
    normalized === 'judgement_failed' ||
    normalized === 'judgment_failed' ||
    normalized === 'system_error' ||
    normalized === 'unknown_error' ||
    normalized === 'submit_failed' ||
    normalized === 'remote_oj_unavailable' ||
    normalized === 'sync_error' ||
    normalized === 'crashed'
  ) {
    return 'judge_error';
  }

  if (score !== undefined && maxScore !== undefined && maxScore > 0) {
    if (score >= maxScore) return 'accepted';
    if (score > 0) return 'partial';
  } else if (score !== undefined && score > 0) {
    return 'partial';
  }

  return 'other';
}

export function isFinalVerdict(verdict: NormalizedVerdict): boolean {
  return verdict !== 'pending';
}

export function parseCookieHeader(cookie: string, platform: OjPlatform): Map<string, string> {
  if (/[\r\n]/.test(cookie)) {
    throw new JudgeInfrastructureError('auth_expired', `Invalid ${platform} session cookie`, { platform });
  }
  const session = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      session.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
    }
  }
  if (!session.size) {
    throw new JudgeInfrastructureError('auth_expired', `Empty or malformed ${platform} session cookie`, { platform });
  }
  return session;
}

export function serializeCookieHeader(session: Map<string, string>): string {
  return [...session].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function mergeSetCookies(session: Map<string, string>, headers: Headers): void {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : [];
  for (const value of setCookies) {
    const pair = value.split(';')[0] ?? '';
    const idx = pair.indexOf('=');
    if (idx > 0) {
      session.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
}

export function validateOriginUrl(raw: string, platform: OjPlatform): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new JudgeInfrastructureError('upstream_unavailable', `Invalid ${platform} base_url`, { platform });
  }
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (
    (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback)) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  ) {
    throw new JudgeInfrastructureError(
      'upstream_unavailable',
      `${platform} base_url must use HTTPS or loopback HTTP without credentials, query, or fragment`,
      { platform },
    );
  }
  return u.href.replace(/\/+$/, '');
}

const submitterOutputSchema = z.strictObject({
  submission_id: z.union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String),
    z.string().trim().min(1).max(128),
  ]),
});

export async function runExternalSubmitter(input: {
  platform: OjPlatform;
  executable: string;
  args: string[];
  source: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  execImpl?: ExecFileLike;
  timeoutMs?: number;
}): Promise<string> {
  if (!isAbsolute(input.executable)) {
    throw new JudgeInfrastructureError(
      'submitter_failed',
      `${input.platform} submitter must be an absolute executable path`,
      { platform: input.platform },
    );
  }
  const execImpl = input.execImpl ?? defaultExecFile;
  const dir = await mkdtemp(join(tmpdir(), `cr-submit-${input.platform}-`));
  try {
    const file = join(dir, 'source');
    await writeFile(file, input.source, { mode: 0o600 });
    const resolvedArgs = input.args.map(arg => (arg === '__SOURCE_FILE__' ? file : arg));
    const { stdout } = await execImpl(input.executable, resolvedArgs, {
      signal: input.signal,
      timeout: input.timeoutMs ?? 30_000,
      maxBuffer: 16_384,
      env: {
        ...process.env,
        CR_SOURCE_FILE: file,
        ...(input.env ?? {}),
      },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (cause) {
      throw new JudgeInfrastructureError(
        'submitter_failed',
        `${input.platform} submitter returned invalid JSON`,
        { platform: input.platform, cause },
      );
    }
    const result = submitterOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new JudgeInfrastructureError(
        'submitter_failed',
        `${input.platform} submitter output missing valid submission_id`,
        { platform: input.platform },
      );
    }
    return result.data.submission_id;
  } catch (err) {
    if (err instanceof JudgeInfrastructureError) throw err;
    throw new JudgeInfrastructureError(
      'submitter_failed',
      `${input.platform} submitter failed: ${err instanceof Error ? err.message : String(err)}`,
      { platform: input.platform, cause: err },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface HtmlNode {
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  value?: string;
}

export function walkHtml(root: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = [];
  const stack: HtmlNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    const children = node.childNodes;
    if (children) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]!);
      }
    }
  }
  return out;
}

export function parseHtmlNodes(markup: string): HtmlNode[] {
  return walkHtml(parse(markup) as HtmlNode);
}

export function htmlAttr(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find(a => a.name.toLowerCase() === name.toLowerCase())?.value;
}

export function htmlText(node: HtmlNode): string {
  return (node.value ?? '') + (node.childNodes ?? []).map(htmlText).join('');
}
