import { z } from 'zod';
import type { OjAccount, OjAccountPool, OjAccounts } from '../oj-accounts.js';
import {
  type ContestPreview,
  type ContestPreviewProblem,
  type ExecFileLike,
  type FetchLike,
  type JudgeVerdict,
  JudgeInfrastructureError,
  type LanguagePreset,
  type ProgramJudge,
  htmlAttr,
  htmlText,
  isFinalVerdict,
  mergeSetCookies,
  normalizeVerdict,
  parseCookieHeader,
  parseHtmlNodes,
  runExternalSubmitter,
  serializeCookieHeader,
  validateOriginUrl,
} from './types.js';

export const VJUDGE_DEFAULT_ORIGIN = 'https://vjudge.net';
export const VJUDGE_DEFAULT_SETTLEMENT_MS = 300_000;

export const VJUDGE_LANGUAGE_PRESETS: LanguagePreset[] = [
  { id: 'cpp20', label: 'C++20 (Generic / GCC)', remote_id: 'C++20', family: 'cpp' },
  { id: 'cpp17', label: 'C++17 (Generic / GCC)', remote_id: 'C++17', family: 'cpp' },
  { id: 'python3', label: 'Python 3', remote_id: 'Python 3', family: 'python' },
  { id: 'pypy3', label: 'PyPy 3', remote_id: 'PyPy 3', family: 'python' },
  { id: 'rust', label: 'Rust', remote_id: 'Rust', family: 'rust' },
  { id: 'java', label: 'Java', remote_id: 'Java', family: 'java' },
];

export interface UpstreamProblemRef {
  oj: string;
  probNum: string;
}

/**
 * Parse an upstream problem reference like "CodeForces-1234A", "QOJ-1420",
 * "AtCoder-abc300_a", or "SPOJ-TEST".
 */
export function parseUpstreamProblemRef(ref: string): UpstreamProblemRef {
  const trimmed = ref.trim();
  const dash = trimmed.indexOf('-');
  if (dash <= 0 || dash === trimmed.length - 1) {
    throw new Error(`Invalid VJudge upstream problem reference "${ref}" (expected "<OJ>-<ProblemID>")`);
  }
  return {
    oj: trimmed.slice(0, dash).trim(),
    probNum: trimmed.slice(dash + 1).trim(),
  };
}

function classifyHttpError(status: number, context: string): JudgeInfrastructureError {
  if (status === 401 || status === 403) {
    return new JudgeInfrastructureError('auth_expired', `VJudge ${context}: HTTP ${status}`, {
      platform: 'vjudge',
      status,
    });
  }
  if (status === 429) {
    return new JudgeInfrastructureError('rate_limited', `VJudge ${context}: HTTP 429 rate limited`, {
      platform: 'vjudge',
      status,
    });
  }
  return new JudgeInfrastructureError('upstream_unavailable', `VJudge ${context}: HTTP ${status}`, {
    platform: 'vjudge',
    status,
  });
}

function detectVjudgeInfraFault(message: string, statusCode?: number): JudgeInfrastructureError | null {
  const lower = message.toLowerCase();
  if (/captcha|recaptcha|turnstile|verification code|verify you are human/.test(lower)) {
    return new JudgeInfrastructureError('captcha_required', `VJudge requires captcha: ${message}`, {
      platform: 'vjudge',
      status: statusCode,
    });
  }
  if (/not logged in|please login|login required|session expired|unauthorized|sign in/.test(lower)) {
    return new JudgeInfrastructureError('auth_expired', `VJudge authentication required: ${message}`, {
      platform: 'vjudge',
      status: statusCode,
    });
  }
  if (/too frequent|rate limit|try again later|too many/.test(lower)) {
    return new JudgeInfrastructureError('rate_limited', `VJudge rate limited: ${message}`, {
      platform: 'vjudge',
      status: statusCode,
    });
  }
  if (
    /submit failed|remote oj unavailable|sync error|upstream unavailable|cannot connect to remote|judge error|system error|judgement failed/.test(
      lower,
    )
  ) {
    return new JudgeInfrastructureError('upstream_unavailable', `VJudge infrastructure fault: ${message}`, {
      platform: 'vjudge',
      status: statusCode,
    });
  }
  return null;
}

const vjudgeSubmitResponseSchema = z.object({
  runId: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  error: z.string().optional(),
  captcha: z.boolean().optional(),
});

const vjudgeSolutionResponseSchema = z.object({
  runId: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  status: z.string().optional(),
  statusCanonical: z.string().optional(),
  statusType: z.number().int().optional(),
  processing: z.boolean().optional(),
  score: z.number().optional(),
  maxScore: z.number().optional(),
  max_score: z.number().optional(),
  runtime: z.number().optional(),
  memory: z.number().optional(),
  author: z.string().optional(),
  username: z.string().optional(),
  oj: z.string().optional(),
  probNum: z.string().optional(),
  contestNum: z.string().optional(),
  error: z.string().optional(),
  captcha: z.boolean().optional(),
});

const vjudgeContestJsonSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  title: z.string(),
  begin: z.number().optional(),
  end: z.number().optional(),
  problems: z.array(
    z.object({
      num: z.string(),
      title: z.string().optional(),
      oj: z.string().optional(),
      probNum: z.string().optional(),
      weight: z.number().optional(),
    }),
  ),
});

export async function previewVjudgeContest(
  contestId: number | string,
  opts?: { baseUrl?: string; fetchImpl?: FetchLike; signal?: AbortSignal },
): Promise<ContestPreview> {
  const cleanId = String(contestId).replace(/^vjudge:/i, '').trim();
  if (!/^\d+$/.test(cleanId)) {
    throw new JudgeInfrastructureError('upstream_unavailable', `Invalid VJudge contest ID: ${contestId}`, {
      platform: 'vjudge',
    });
  }
  const origin = validateOriginUrl(opts?.baseUrl ?? VJUDGE_DEFAULT_ORIGIN, 'vjudge');
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(opts?.signal ? [opts.signal] : [])]);

  let response: Response;
  try {
    response = await fetchImpl(`${origin}/contest/${cleanId}`, { redirect: 'follow', signal });
  } catch (cause) {
    if (opts?.signal?.aborted) throw cause;
    throw new JudgeInfrastructureError('upstream_unavailable', 'VJudge contest preview request failed', {
      platform: 'vjudge',
      cause,
    });
  }
  if (!response.ok) throw classifyHttpError(response.status, 'contest preview');

  const body = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let jsonCandidate: unknown;

  if (contentType.includes('application/json') || body.trim().startsWith('{')) {
    jsonCandidate = JSON.parse(body);
  } else {
    // VJudge embeds contest JSON inside <textarea name="dataJson">...</textarea>
    const nodes = parseHtmlNodes(body);
    const dataTextarea = nodes.find(
      n => n.tagName === 'textarea' && (htmlAttr(n, 'name') === 'dataJson' || htmlAttr(n, 'id') === 'dataJson'),
    );
    if (dataTextarea) {
      jsonCandidate = JSON.parse(htmlText(dataTextarea));
    }
  }

  const parsed = vjudgeContestJsonSchema.safeParse(jsonCandidate);
  if (!parsed.success) {
    throw new JudgeInfrastructureError('upstream_unavailable', 'Could not parse VJudge contest metadata', {
      platform: 'vjudge',
    });
  }

  const data = parsed.data;
  const now = Date.now();
  let status: ContestPreview['status'] = 'unknown';
  if (data.end !== undefined) {
    if (now > data.end) status = 'finished';
    else if (data.begin === undefined || now >= data.begin) status = 'active';
  }

  const problems: ContestPreviewProblem[] = data.problems.map(p => ({
    remote_id: p.num,
    ...(p.title ? { title: p.title } : {}),
    ...(p.weight !== undefined ? { max_points: p.weight } : {}),
    ...(p.oj ? { upstream_oj: p.oj } : {}),
    ...(p.probNum ? { upstream_problem: p.probNum } : {}),
  }));

  return {
    platform: 'vjudge',
    contest_ref: `vjudge:${cleanId}`,
    title: data.title,
    status,
    problems,
    suggested_languages: VJUDGE_LANGUAGE_PRESETS,
  };
}

export interface VjudgeJudgeConfig {
  /** Present for VJudge Contest mode; omit for direct/mixed upstream problem mode. */
  contest_id?: number | string;
  handle: string;
  languages: Record<string, string>;
  /**
   * In contest mode: maps local problem ID -> contest index (e.g. "A", "B").
   * In direct mode: maps local problem ID -> "<OJ>-<ProbNum>" (e.g. "CodeForces-1234A", "QOJ-1420").
   */
  problem_map?: Record<string, string>;
  account_id?: string;
  base_url?: string;
  settlement_ms?: number;
  /** Optional contest password if required by a private VJudge contest. */
  contest_password?: string;
}

export interface VjudgeJudgeDeps {
  accounts?: OjAccounts;
  pool?: OjAccountPool;
  account?: OjAccount;
  cookie?: string;
  executable?: string;
  fetchImpl?: FetchLike;
  execImpl?: ExecFileLike;
}

export function createVjudgeJudge(config: VjudgeJudgeConfig, deps: VjudgeJudgeDeps = {}): ProgramJudge {
  const origin = validateOriginUrl(config.base_url ?? VJUDGE_DEFAULT_ORIGIN, 'vjudge');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const settlementMs = config.settlement_ms ?? VJUDGE_DEFAULT_SETTLEMENT_MS;

  const targetFor = (problem: string) =>
    Object.hasOwn(config.problem_map ?? {}, problem) ? config.problem_map![problem]! : problem;

  async function resolveTransport(): Promise<
    { mode: 'submitter'; executable: string; handle: string; accountId?: string } |
    { mode: 'cookie'; cookie: string; handle: string; accountId?: string }
  > {
    if (deps.executable) {
      return { mode: 'submitter', executable: deps.executable, handle: config.handle, accountId: config.account_id };
    }
    if (deps.cookie) {
      return { mode: 'cookie', cookie: deps.cookie, handle: config.handle, accountId: config.account_id };
    }
    if (config.account_id && deps.accounts) {
      const account = await deps.accounts.get(config.account_id);
      if (account.platform !== 'vjudge') {
        throw new JudgeInfrastructureError('auth_expired', `OJ account ${account.id} is not a VJudge account`, {
          platform: 'vjudge',
        });
      }
      if (account.transport === 'submitter') {
        if (!account.executable_path) {
          throw new JudgeInfrastructureError('submitter_failed', 'VJudge submitter account has no executable_path', {
            platform: 'vjudge',
          });
        }
        return { mode: 'submitter', executable: account.executable_path, handle: account.handle, accountId: account.id };
      }
      const secret = await deps.accounts.resolveSecret(account.id);
      return { mode: 'cookie', cookie: secret, handle: account.handle, accountId: account.id };
    }
    if (deps.account?.transport === 'submitter' && deps.account.executable_path) {
      return {
        mode: 'submitter',
        executable: deps.account.executable_path,
        handle: deps.account.handle,
        accountId: deps.account.id,
      };
    }
    const envExec = process.env.CR_VJUDGE_SUBMITTER?.trim();
    if (envExec) {
      return { mode: 'submitter', executable: envExec, handle: config.handle, accountId: config.account_id };
    }
    const envCookie = process.env.CR_VJUDGE_COOKIE?.trim();
    if (envCookie) {
      return { mode: 'cookie', cookie: envCookie, handle: config.handle, accountId: config.account_id };
    }
    throw new JudgeInfrastructureError('auth_expired', 'No VJudge OJ account, cookie, or submitter configured', {
      platform: 'vjudge',
    });
  }

  async function submitViaCookie(
    target: string,
    remoteLang: string,
    source: string,
    cookie: string,
    signal: AbortSignal,
  ): Promise<string> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const session = parseCookieHeader(cookie, 'vjudge');
    const cookieHeader = () => ({ cookie: serializeCookieHeader(session) });

    const isContest = config.contest_id !== undefined;
    const endpointUrl = isContest ? `${origin}/contest/submit` : `${origin}/problem/submit`;
    const body = new URLSearchParams();
    body.set('method', '0');
    body.set('language', remoteLang);
    body.set('open', '0');
    body.set('source', Buffer.from(source, 'utf8').toString('base64'));
    if (isContest) {
      body.set('contestId', String(config.contest_id));
      body.set('num', target);
    } else {
      const upstream = parseUpstreamProblemRef(target);
      body.set('oj', upstream.oj);
      body.set('probNum', upstream.probNum);
    }

    let response: Response;
    try {
      response = await fetchImpl(endpointUrl, {
        method: 'POST',
        headers: {
          ...cookieHeader(),
          origin,
          referer: isContest ? `${origin}/contest/${config.contest_id}` : `${origin}/problem/${target}`,
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        body,
        redirect: 'manual',
        signal: requestSignal,
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge submit request failed; will not retry', {
        platform: 'vjudge',
        cause,
      });
    }

    if (response.status >= 300 && response.status < 400) {
      throw new JudgeInfrastructureError('auth_expired', 'VJudge redirected submit request (login required)', {
        platform: 'vjudge',
        status: response.status,
      });
    }
    if (!response.ok) throw classifyHttpError(response.status, 'submit');
    mergeSetCookies(session, response.headers);

    const rawText = await response.text();
    const textFault = detectVjudgeInfraFault(rawText, response.status);
    let parsedJson: z.infer<typeof vjudgeSubmitResponseSchema> | undefined;
    try {
      parsedJson = vjudgeSubmitResponseSchema.parse(JSON.parse(rawText));
    } catch {
      if (textFault) throw textFault;
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge submit returned non-JSON response', {
        platform: 'vjudge',
      });
    }

    if (parsedJson.captcha) {
      throw new JudgeInfrastructureError('captcha_required', 'VJudge requires captcha verification before submitting', {
        platform: 'vjudge',
      });
    }
    if (parsedJson.error) {
      const fault = detectVjudgeInfraFault(parsedJson.error, response.status);
      if (fault) throw fault;
      throw new JudgeInfrastructureError('submission_unconfirmed', `VJudge submit rejected: ${parsedJson.error}`, {
        platform: 'vjudge',
      });
    }
    if (parsedJson.runId === undefined) {
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge submit response missing runId', {
        platform: 'vjudge',
      });
    }
    return String(parsedJson.runId);
  }

  return {
    kind: 'vjudge',
    settlementMs,

    async submit(problem, language, source, signal) {
      const remoteLang = config.languages[language];
      if (!remoteLang) {
        throw new Error(`Unsupported VJudge language key: ${language}`);
      }
      const target = targetFor(problem);
      const transport = await resolveTransport();

      const execute = async () => {
        if (transport.mode === 'submitter') {
          const isContest = config.contest_id !== undefined;
          return runExternalSubmitter({
            platform: 'vjudge',
            executable: transport.executable,
            args: [
              isContest ? `contest:${config.contest_id}` : 'direct',
              target,
              remoteLang,
              '__SOURCE_FILE__',
              transport.handle,
            ],
            source,
            env: {
              CR_OJ_PLATFORM: 'vjudge',
              CR_VJUDGE_BASE_URL: origin,
              CR_VJUDGE_CONTEST_ID: config.contest_id !== undefined ? String(config.contest_id) : '',
              CR_VJUDGE_TARGET: target,
              CR_VJUDGE_LANGUAGE: remoteLang,
              CR_VJUDGE_HANDLE: transport.handle,
            },
            signal,
            execImpl: deps.execImpl,
          });
        }
        return submitViaCookie(target, remoteLang, source, transport.cookie, signal);
      };

      const serializationKey = transport.accountId ?? `vjudge:${transport.handle.toLowerCase()}`;
      if (deps.pool) {
        return deps.pool.enqueueSubmission(serializationKey, execute, signal);
      }
      return execute();
    },

    async verdicts(ids, problems, signal) {
      if (!ids.length) return new Map();
      const transport = await resolveTransport().catch(() => undefined);
      const headers: Record<string, string> = { 'x-requested-with': 'XMLHttpRequest' };
      if (transport?.mode === 'cookie') {
        headers.cookie = serializeCookieHeader(parseCookieHeader(transport.cookie, 'vjudge'));
      }
      const handle = transport?.handle ?? config.handle;
      const result = new Map<string, JudgeVerdict>();

      for (const id of ids) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        let resp: Response;
        try {
          resp = await fetchImpl(`${origin}/solution/data/${encodeURIComponent(id)}`, {
            headers,
            redirect: 'manual',
            signal: requestSignal,
          });
        } catch (cause) {
          if (signal.aborted) throw cause;
          throw new JudgeInfrastructureError('upstream_unavailable', `VJudge verdict poll failed for #${id}`, {
            platform: 'vjudge',
            cause,
          });
        }
        if (resp.status >= 300 && resp.status < 400) {
          throw new JudgeInfrastructureError('auth_expired', `VJudge redirected while polling #${id}`, {
            platform: 'vjudge',
            status: resp.status,
          });
        }
        if (!resp.ok) throw classifyHttpError(resp.status, `solution #${id}`);

        const rawText = await resp.text();
        let data: z.infer<typeof vjudgeSolutionResponseSchema>;
        try {
          data = vjudgeSolutionResponseSchema.parse(JSON.parse(rawText));
        } catch (cause) {
          const fault = detectVjudgeInfraFault(rawText, resp.status);
          if (fault) throw fault;
          throw new JudgeInfrastructureError('upstream_unavailable', `VJudge returned invalid JSON for #${id}`, {
            platform: 'vjudge',
            cause,
          });
        }

        if (data.captcha) {
          throw new JudgeInfrastructureError('captcha_required', `VJudge captcha triggered polling #${id}`, {
            platform: 'vjudge',
          });
        }
        if (data.error) {
          const fault = detectVjudgeInfraFault(data.error, resp.status);
          if (fault) throw fault;
          throw new JudgeInfrastructureError('upstream_unavailable', `VJudge poll error for #${id}: ${data.error}`, {
            platform: 'vjudge',
          });
        }

        const remoteAuthor = data.author ?? data.username;
        if (remoteAuthor && remoteAuthor.toLowerCase() !== handle.toLowerCase()) {
          throw new JudgeInfrastructureError('identity_mismatch', `VJudge submission #${id} handle mismatch`, {
            platform: 'vjudge',
          });
        }

        // Verify target problem when metadata is present
        const localProblem = problems.get(id);
        if (localProblem) {
          const expected = targetFor(localProblem);
          if (config.contest_id !== undefined) {
            if (data.contestNum && data.contestNum !== expected) {
              throw new JudgeInfrastructureError('identity_mismatch', `VJudge submission #${id} contest problem mismatch`, {
                platform: 'vjudge',
              });
            }
          } else if (data.oj && data.probNum) {
            const upstream = parseUpstreamProblemRef(expected);
            if (data.oj.toLowerCase() !== upstream.oj.toLowerCase() || data.probNum !== upstream.probNum) {
              throw new JudgeInfrastructureError('identity_mismatch', `VJudge submission #${id} upstream problem mismatch`, {
                platform: 'vjudge',
              });
            }
          }
        }

        const rawVerdict = data.status ?? data.statusCanonical ?? 'Pending';
        const statusFault = detectVjudgeInfraFault(rawVerdict, resp.status);
        if (statusFault) throw statusFault;

        if (data.processing === true) continue;

        const score = data.score;
        const maxScore = data.maxScore ?? data.max_score;
        const normalized = normalizeVerdict(data.statusCanonical ?? rawVerdict, score, maxScore);
        if (normalized === 'judge_error') {
          throw new JudgeInfrastructureError(
            'upstream_unavailable',
            `VJudge reported infrastructure verdict "${rawVerdict}" for #${id}`,
            { platform: 'vjudge' },
          );
        }

        if (isFinalVerdict(normalized)) {
          result.set(id, {
            remote_submission_id: id,
            verdict: normalized,
            raw_verdict: rawVerdict,
            ...(score !== undefined ? { score } : {}),
            ...(maxScore !== undefined ? { max_score: maxScore } : {}),
            ...(data.runtime !== undefined ? { time_ms: Math.round(data.runtime) } : {}),
            ...(data.memory !== undefined ? { memory_kb: Math.round(data.memory) } : {}),
            final: true,
          });
        }
      }

      return result;
    },
  };
}
