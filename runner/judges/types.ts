import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'parse5';
import { z } from 'zod';
import {
  OjAccountError,
  type OjAccount,
  type OjAccounts,
  type OjPlatform,
  defaultOriginFor,
  effectiveOriginFor,
  submissionQueueKey,
} from '../oj-accounts.js';

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

export interface JudgeInfrastructureErrorDetails {
  platform?: OjPlatform;
  status?: number;
  exitCode?: number | null;
  signal?: string | null;
}

export class JudgeInfrastructureError extends Error {
  constructor(
    readonly code: JudgeInfrastructureErrorCode,
    message: string,
    readonly details?: JudgeInfrastructureErrorDetails,
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

  // 1. Pending / in-flight verdicts
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

  // 2. Infrastructure / judge error verdicts MUST take precedence over wrong_answer or partial scores
  if (
    normalized === 'je' ||
    normalized === 'se' ||
    normalized === 'uke' ||
    normalized === 'judge_error' ||
    normalized === 'judgement_failed' ||
    normalized === 'judgment_failed' ||
    normalized === 'judge_failed' ||
    normalized === 'crawling_failed' ||
    normalized === 'system_error' ||
    normalized === 'unknown_error' ||
    normalized === 'submit_failed' ||
    normalized === 'remote_oj_unavailable' ||
    normalized === 'sync_error' ||
    normalized === 'crashed' ||
    normalized === 'input_preparation_crashed' ||
    normalized === 'failed' ||
    normalized === 'denial_of_judgement' ||
    normalized === 'denial_of_judgment' ||
    normalized === 'security_violated'
  ) {
    return 'judge_error';
  }

  // 3. Accepted (never classify as accepted if score is strictly less than maxScore)
  if (
    normalized === 'ok' ||
    normalized === 'ac' ||
    normalized === 'accepted' ||
    normalized === 'happy_new_year!'
  ) {
    if (score !== undefined && maxScore !== undefined && maxScore > 0 && score < maxScore) {
      return score > 0 ? 'partial' : 'wrong_answer';
    }
    return 'accepted';
  }

  // 4. Explicit partial
  if (
    normalized === 'partial' ||
    normalized === 'partially_accepted' ||
    normalized === 'partial_accepted' ||
    normalized === 'partial_score'
  ) {
    return 'partial';
  }

  // 5. Compilation / presentation / idleness
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

  // 6. Wrong answer / TLE / MLE / RE (upgrade to partial when positive score < maxScore)
  const isPartialScore = score !== undefined && score > 0 && (maxScore === undefined || score < maxScore);

  if (
    normalized === 'wa' ||
    normalized === 'wrong_answer' ||
    normalized === 'incorrect' ||
    normalized === 'rejected' ||
    normalized === 'hacked' ||
    normalized === 'challenged'
  ) {
    return isPartialScore ? 'partial' : 'wrong_answer';
  }

  if (normalized === 'tle' || normalized === 'time_limit_exceeded' || normalized === 'time_limit') {
    return isPartialScore ? 'partial' : 'time_limit_exceeded';
  }

  if (normalized === 'mle' || normalized === 'memory_limit_exceeded' || normalized === 'memory_limit') {
    return isPartialScore ? 'partial' : 'memory_limit_exceeded';
  }

  if (
    normalized === 're' ||
    normalized === 'rte' ||
    normalized === 'runtime_error' ||
    normalized === 'dangerous_syscalls' ||
    normalized === 'output_limit_exceeded' ||
    normalized === 'ole'
  ) {
    return isPartialScore ? 'partial' : 'runtime_error';
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

export interface ValidatedEndpoint {
  baseUrl: string;
  origin: string;
}

export function resolveBaseUrl(raw: string, platform: OjPlatform): ValidatedEndpoint {
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
  return {
    baseUrl: u.href.replace(/\/+$/, ''),
    origin: u.origin,
  };
}

export function validateOriginUrl(raw: string, platform: OjPlatform): string {
  return resolveBaseUrl(raw, platform).baseUrl;
}

export function safeParseJson(
  text: string,
  platform: OjPlatform,
  context: string,
  code: JudgeInfrastructureErrorCode = 'upstream_unavailable',
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JudgeInfrastructureError(code, `${platform} ${context} returned invalid JSON`, { platform });
  }
}

export async function safeResponseJson(
  response: Response,
  platform: OjPlatform,
  context: string,
  code: JudgeInfrastructureErrorCode = 'upstream_unavailable',
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new JudgeInfrastructureError(code, `${platform} ${context} response stream failed`, {
      platform,
      status: response.status,
    });
  }
  return safeParseJson(text, platform, context, code);
}

export interface ResolvedAdapterTransport {
  mode: 'cookie' | 'submitter';
  handle: string;
  cookie?: string;
  executable?: string;
  accountId?: string;
  queueKey: string;
}

export interface AdapterTransportDeps {
  accounts?: OjAccounts;
  account?: OjAccount;
  cookie?: string;
  executable?: string;
}

const ENV_PREFIX_FOR_PLATFORM: Record<OjPlatform, string> = {
  codeforces: 'CODEFORCES',
  qoj: 'QOJ',
  vjudge: 'VJUDGE',
  hydro: 'HYDRO',
};

/**
 * Shared transport resolver for all OJ adapters.
 * Guarantees:
 * - Origin & platform binding checked BEFORE any credential is read or released.
 * - `deps.account` works for BOTH `'cookie'` and `'submitter'` accounts without silently falling back to env vars.
 * - Environment cookie fallbacks (`CR_<PLATFORM>_COOKIE`) require `CR_<PLATFORM>_BASE_URL` approval for non-default origins.
 * - Never swallows `OjAccountError` or `JudgeInfrastructureError`.
 */
export async function resolveAdapterTransport(input: {
  platform: OjPlatform;
  baseUrl: string;
  origin: string;
  configHandle?: string;
  configAccountId?: string;
  deps: AdapterTransportDeps;
}): Promise<ResolvedAdapterTransport> {
  const { platform, baseUrl, origin, configHandle, configAccountId, deps } = input;
  const defaultOrigin = defaultOriginFor(platform);

  // 1. Explicit pool-leased account takes precedence over raw env fallbacks
  if (deps.account) {
    const account = deps.account;
    if (account.platform !== platform) {
      throw new JudgeInfrastructureError(
        'auth_expired',
        `OJ account ${account.id} belongs to ${account.platform}, not ${platform}`,
        { platform },
      );
    }
    const boundOrigin = effectiveOriginFor(account);
    if (!boundOrigin || boundOrigin !== origin) {
      throw new JudgeInfrastructureError(
        'auth_expired',
        `OJ account ${account.id} origin does not match target ${platform} origin`,
        { platform },
      );
    }
    const handle = account.handle;
    const queueKey = submissionQueueKey(platform, origin, handle);
    if (account.transport === 'submitter') {
      const executable = deps.executable ?? account.executable_path;
      if (!executable) {
        throw new JudgeInfrastructureError('submitter_failed', `${platform} submitter account missing executable_path`, {
          platform,
        });
      }
      return { mode: 'submitter', executable, handle, accountId: account.id, queueKey };
    }
    // Cookie transport on leased account: prefer explicit deps.cookie, else resolve from OjAccounts with origin binding.
    if (deps.cookie) {
      return { mode: 'cookie', cookie: deps.cookie, handle, accountId: account.id, queueKey };
    }
    if (!deps.accounts) {
      throw new JudgeInfrastructureError(
        'auth_expired',
        `Cookie OJ account ${account.id} requires OjAccounts store to resolve secret`,
        { platform },
      );
    }
    try {
      const secret = await deps.accounts.resolveSecret(account.id, { platform, origin });
      return { mode: 'cookie', cookie: secret, handle, accountId: account.id, queueKey };
    } catch (err) {
      if (err instanceof OjAccountError) {
        throw new JudgeInfrastructureError('auth_expired', err.message, { platform, status: err.status });
      }
      throw err;
    }
  }

  // 2. Account ID resolved atomically from OjAccounts (single read + platform/origin binding)
  if (configAccountId) {
    if (!deps.accounts) {
      throw new JudgeInfrastructureError(
        'auth_expired',
        `${platform} account_id "${configAccountId}" requires OjAccounts store`,
        { platform },
      );
    }
    try {
      const resolved = await deps.accounts.resolveAccountTransport(configAccountId, { platform, origin });
      const handle = resolved.account.handle;
      const queueKey = submissionQueueKey(platform, origin, handle);
      if (resolved.account.transport === 'submitter') {
        const executable = deps.executable ?? resolved.executable_path;
        if (!executable) {
          throw new JudgeInfrastructureError('submitter_failed', `${platform} submitter account missing executable_path`, {
            platform,
          });
        }
        return { mode: 'submitter', executable, handle, accountId: resolved.account.id, queueKey };
      }
      return {
        mode: 'cookie',
        cookie: deps.cookie ?? resolved.secret!,
        handle,
        accountId: resolved.account.id,
        queueKey,
      };
    } catch (err) {
      if (err instanceof OjAccountError) {
        throw new JudgeInfrastructureError(
          err.status === 503 && err.message.includes('submitter') ? 'submitter_failed' : 'auth_expired',
          err.message,
          { platform, status: err.status },
        );
      }
      throw err;
    }
  }

  const handle = configHandle?.trim();
  if (!handle) {
    throw new JudgeInfrastructureError('auth_expired', `${platform} judge requires handle or account_id`, { platform });
  }
  const queueKey = submissionQueueKey(platform, origin, handle);

  // 3. Direct injected executable or cookie (for tests / explicit caller wiring)
  if (deps.executable) {
    return { mode: 'submitter', executable: deps.executable, handle, queueKey };
  }
  if (deps.cookie) {
    return { mode: 'cookie', cookie: deps.cookie, handle, queueKey };
  }

  // 4. Environment fallbacks with explicit origin approval for non-default origins
  const envPrefix = ENV_PREFIX_FOR_PLATFORM[platform];
  const envExec = process.env[`CR_${envPrefix}_SUBMITTER`]?.trim();
  if (envExec) {
    return { mode: 'submitter', executable: envExec, handle, queueKey };
  }
  const envCookie = process.env[`CR_${envPrefix}_COOKIE`]?.trim();
  if (envCookie) {
    const approvedEnvBase = process.env[`CR_${envPrefix}_BASE_URL`]?.trim();
    const isDefaultOrigin = defaultOrigin !== undefined && origin === defaultOrigin;
    if (!isDefaultOrigin) {
      let approvedOrigin: string | undefined;
      if (approvedEnvBase) {
        try {
          approvedOrigin = resolveBaseUrl(approvedEnvBase, platform).origin;
        } catch {
          approvedOrigin = undefined;
        }
      }
      if (!approvedOrigin || approvedOrigin !== origin) {
        throw new JudgeInfrastructureError(
          'auth_expired',
          `Approve ${baseUrl} via CR_${envPrefix}_BASE_URL before sending CR_${envPrefix}_COOKIE to a non-default origin`,
          { platform },
        );
      }
    }
    return { mode: 'cookie', cookie: envCookie, handle, queueKey };
  }

  throw new JudgeInfrastructureError('auth_expired', `No ${platform} OJ account, cookie, or submitter configured`, {
    platform,
  });
}

const submitterOutputSchema = z.strictObject({
  submission_id: z.union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String),
    z.string().trim().min(1).max(128),
  ]),
});

const ALLOWLISTED_HOST_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_ENV'] as const;

function buildMinimalSubmitterEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWLISTED_HOST_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      env[k] = v;
    }
  }
  return env;
}

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
      env: buildMinimalSubmitterEnv({
        CR_SOURCE_FILE: file,
        ...(input.env ?? {}),
      }),
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new JudgeInfrastructureError(
        'submitter_failed',
        `${input.platform} submitter returned invalid JSON`,
        { platform: input.platform },
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
    if (input.signal.aborted) throw err;
    const rawErr = err as { code?: number | string | null; signal?: string | null };
    const exitCode = typeof rawErr?.code === 'number' ? rawErr.code : null;
    const sig = typeof rawErr?.signal === 'string' ? rawErr.signal : null;
    // Never include err.message / stderr in error message or details (may contain credentials/source).
    throw new JudgeInfrastructureError(
      'submitter_failed',
      `${input.platform} external submitter failed`,
      { platform: input.platform, exitCode, signal: sig },
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
