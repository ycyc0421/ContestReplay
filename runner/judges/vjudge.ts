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
  resolveAdapterTransport,
  resolveBaseUrl,
  runExternalSubmitter,
  safeParseJson,
  serializeAccountSubmission,
  serializeCookieHeader,
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

const KNOWN_HYPHENATED_OJS = [
  'E-Olymp',
  '2050-OJ',
  'Hiho-Coder',
  'Open-Judge',
  'AC-Coder',
];

/**
 * Parse an upstream problem reference like "CodeForces-1234A", "QOJ-1420",
 * "AtCoder-abc300_a", "Kattis-two-sum", or hyphenated OJ names like "E-Olymp-1234".
 */
export function parseUpstreamProblemRef(ref: string): UpstreamProblemRef {
  const trimmed = ref.trim();
  const lower = trimmed.toLowerCase();
  for (const ojName of KNOWN_HYPHENATED_OJS) {
    const prefix = `${ojName.toLowerCase()}-`;
    if (lower.startsWith(prefix) && trimmed.length > prefix.length) {
      return {
        oj: trimmed.slice(0, ojName.length),
        probNum: trimmed.slice(ojName.length + 1).trim(),
      };
    }
  }
  const dash = trimmed.indexOf('-');
  if (dash <= 0 || dash === trimmed.length - 1) {
    throw new Error(`Invalid VJudge upstream problem reference (expected "<OJ>-<ProblemID>")`);
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
    return new JudgeInfrastructureError('captcha_required', 'VJudge requires captcha verification', {
      platform: 'vjudge',
      status: statusCode,
    });
  }
  if (/not logged in|please login|login required|session expired|unauthorized|sign in/.test(lower)) {
    return new JudgeInfrastructureError('auth_expired', 'VJudge authentication required or session expired', {
      platform: 'vjudge',
      status: statusCode,
    });
  }
  if (/too frequent|rate limit|try again later|too many/.test(lower)) {
    return new JudgeInfrastructureError('rate_limited', 'VJudge rate limit exceeded', {
      platform: 'vjudge',
      status: statusCode,
    });
  }
  if (
    /submit failed|remote oj unavailable|sync error|upstream unavailable|cannot connect to remote|judge error|judge failed|judgement failed|judgment failed|crawling failed|system error|unknown error|denial of/.test(
      lower,
    )
  ) {
    return new JudgeInfrastructureError('upstream_unavailable', 'VJudge reported an upstream infrastructure fault', {
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
  contestId: z.union([z.number().int(), z.string()]).optional(),
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

function normalizeEpochMs(ts: number): number {
  // Handle Unix seconds (< 1e12) vs milliseconds (>= 1e12)
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

async function fetchSameOriginManual(
  url: string,
  origin: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hops = 0; hops < 3; hops++) {
    let response: Response;
    try {
      response = await fetchImpl(current, { redirect: 'manual', signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JudgeInfrastructureError('upstream_unavailable', 'VJudge HTTP request failed', { platform: 'vjudge' });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new JudgeInfrastructureError('upstream_unavailable', 'VJudge redirect missing location header', {
          platform: 'vjudge',
          status: response.status,
        });
      }
      const next = new URL(location, current);
      if (next.origin !== origin) {
        throw new JudgeInfrastructureError('upstream_unavailable', 'VJudge redirected across origins', {
          platform: 'vjudge',
          status: response.status,
        });
      }
      current = next.href;
      continue;
    }
    return response;
  }
  throw new JudgeInfrastructureError('upstream_unavailable', 'VJudge exceeded redirect limit', { platform: 'vjudge' });
}

export async function previewVjudgeContest(
  contestId: number | string,
  opts?: { baseUrl?: string; fetchImpl?: FetchLike; signal?: AbortSignal },
): Promise<ContestPreview> {
  const cleanId = String(contestId).replace(/^vjudge:/i, '').trim();
  if (!/^\d+$/.test(cleanId)) {
    throw new JudgeInfrastructureError('upstream_unavailable', 'Invalid VJudge contest ID', {
      platform: 'vjudge',
    });
  }
  const { baseUrl, origin } = resolveBaseUrl(opts?.baseUrl ?? VJUDGE_DEFAULT_ORIGIN, 'vjudge');
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(opts?.signal ? [opts.signal] : [])]);

  const response = await fetchSameOriginManual(`${baseUrl}/contest/${encodeURIComponent(cleanId)}`, origin, fetchImpl, signal);
  if (!response.ok) throw classifyHttpError(response.status, 'contest preview');

  const body = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let jsonCandidate: unknown;

  if (contentType.includes('application/json') || body.trim().startsWith('{')) {
    jsonCandidate = safeParseJson(body, 'vjudge', 'contest preview');
  } else {
    const nodes = parseHtmlNodes(body);
    const dataTextarea = nodes.find(
      n => n.tagName === 'textarea' && (htmlAttr(n, 'name') === 'dataJson' || htmlAttr(n, 'id') === 'dataJson'),
    );
    if (dataTextarea) {
      jsonCandidate = safeParseJson(htmlText(dataTextarea), 'vjudge', 'contest dataJson');
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
    const endMs = normalizeEpochMs(data.end);
    const beginMs = data.begin !== undefined ? normalizeEpochMs(data.begin) : undefined;
    if (now > endMs) status = 'finished';
    else if (beginMs === undefined || now >= beginMs) status = 'active';
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
  handle?: string;
  languages: Record<string, string>;
  /**
   * In contest mode: maps local problem ID -> contest index (e.g. "A", "B").
   * In direct mode: maps local problem ID -> "<OJ>-<ProbNum>" (e.g. "CodeForces-1234A", "QOJ-1420").
   */
  problem_map?: Record<string, string>;
  account_id?: string;
  base_url?: string;
  settlement_ms?: number;
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
  const { baseUrl, origin } = resolveBaseUrl(config.base_url ?? VJUDGE_DEFAULT_ORIGIN, 'vjudge');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const settlementMs = config.settlement_ms ?? VJUDGE_DEFAULT_SETTLEMENT_MS;
  const normalizedContestId =
    config.contest_id !== undefined ? String(config.contest_id).replace(/^vjudge:/i, '').trim() : undefined;

  const targetFor = (problem: string) =>
    Object.hasOwn(config.problem_map ?? {}, problem) ? config.problem_map![problem]! : problem;

  function resolveTransport() {
    return resolveAdapterTransport({
      platform: 'vjudge',
      baseUrl,
      origin,
      configHandle: config.handle,
      configAccountId: config.account_id,
      deps,
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

    const isContest = normalizedContestId !== undefined;
    const endpointUrl = isContest ? `${baseUrl}/contest/submit` : `${baseUrl}/problem/submit`;
    const body = new URLSearchParams();
    body.set('method', '0');
    body.set('language', remoteLang);
    body.set('open', '0');
    body.set('source', Buffer.from(source, 'utf8').toString('base64'));
    if (isContest) {
      body.set('contestId', normalizedContestId);
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
          referer: isContest ? `${baseUrl}/contest/${encodeURIComponent(normalizedContestId)}` : `${baseUrl}/problem/${encodeURIComponent(target)}`,
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        body,
        redirect: 'manual',
        signal: requestSignal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge submit request failed; will not retry', {
        platform: 'vjudge',
      });
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new JudgeInfrastructureError('auth_expired', 'VJudge redirected submit request (login required)', {
        platform: 'vjudge',
        status: response.status,
      });
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      await response.body?.cancel();
      throw classifyHttpError(response.status, 'submit');
    }
    if (!response.ok) {
      // Post-write 5xx / non-ok status is ambiguous and must NOT be retried as a preflight failure.
      await response.body?.cancel();
      throw new JudgeInfrastructureError(
        'submission_unconfirmed',
        `VJudge submit POST returned HTTP ${response.status}; will not retry`,
        { platform: 'vjudge', status: response.status },
      );
    }
    mergeSetCookies(session, response.headers);

    let rawText: string;
    try {
      rawText = await response.text();
    } catch {
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge response stream interrupted after submit POST', {
        platform: 'vjudge',
        status: response.status,
      });
    }
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(rawText);
    } catch {
      const textFault = detectVjudgeInfraFault(rawText, response.status);
      if (textFault && (textFault.code === 'captcha_required' || textFault.code === 'auth_expired' || textFault.code === 'rate_limited')) {
        throw textFault;
      }
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge submit returned truncated or non-JSON response', {
        platform: 'vjudge',
        status: response.status,
      });
    }

    const parsed = vjudgeSubmitResponseSchema.safeParse(rawParsed);
    if (!parsed.success) {
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge submit returned unexpected JSON schema', {
        platform: 'vjudge',
      });
    }

    if (parsed.data.captcha) {
      throw new JudgeInfrastructureError('captcha_required', 'VJudge requires captcha verification before submitting', {
        platform: 'vjudge',
      });
    }
    if (parsed.data.error) {
      const fault = detectVjudgeInfraFault(parsed.data.error, response.status);
      if (fault) throw fault;
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge rejected submission', {
        platform: 'vjudge',
      });
    }
    if (parsed.data.runId === undefined) {
      throw new JudgeInfrastructureError('submission_unconfirmed', 'VJudge submit response missing runId', {
        platform: 'vjudge',
      });
    }
    return String(parsed.data.runId);
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
          const isContest = normalizedContestId !== undefined;
          return runExternalSubmitter({
            platform: 'vjudge',
            executable: transport.executable!,
            args: [
              isContest ? `contest:${normalizedContestId}` : 'direct',
              target,
              remoteLang,
              '__SOURCE_FILE__',
              transport.handle,
            ],
            source,
            env: {
              CR_OJ_PLATFORM: 'vjudge',
              CR_VJUDGE_BASE_URL: baseUrl,
              CR_VJUDGE_CONTEST_ID: normalizedContestId ?? '',
              CR_VJUDGE_TARGET: target,
              CR_VJUDGE_LANGUAGE: remoteLang,
              CR_VJUDGE_HANDLE: transport.handle,
            },
            signal,
            execImpl: deps.execImpl,
          });
        }
        return submitViaCookie(target, remoteLang, source, transport.cookie!, signal);
      };

      return serializeAccountSubmission(transport.queueKey, execute, signal, deps.pool);
    },

    async verdicts(ids, problems, signal) {
      if (!ids.length) return new Map();
      for (const id of ids) {
        if (!problems.has(id)) {
          throw new JudgeInfrastructureError('identity_mismatch', `Missing expected problem mapping for VJudge submission #${id}`, {
            platform: 'vjudge',
          });
        }
      }
      const transport = await resolveTransport();
      const headers: Record<string, string> = { 'x-requested-with': 'XMLHttpRequest' };
      if (transport.mode === 'cookie') {
        headers.cookie = serializeCookieHeader(parseCookieHeader(transport.cookie!, 'vjudge'));
      }
      const handle = transport.handle;
      const result = new Map<string, JudgeVerdict>();

      for (const id of ids) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        let resp: Response;
        try {
          resp = await fetchImpl(`${baseUrl}/solution/data/${encodeURIComponent(id)}`, {
            headers,
            redirect: 'manual',
            signal: requestSignal,
          });
        } catch (err) {
          if (signal.aborted) throw err;
          throw new JudgeInfrastructureError('upstream_unavailable', `VJudge verdict poll failed for #${id}`, {
            platform: 'vjudge',
          });
        }
        if (resp.status >= 300 && resp.status < 400) {
          await resp.body?.cancel();
          throw new JudgeInfrastructureError('auth_expired', `VJudge redirected while polling #${id}`, {
            platform: 'vjudge',
            status: resp.status,
          });
        }
        if (!resp.ok) {
          await resp.body?.cancel();
          throw classifyHttpError(resp.status, `solution #${id}`);
        }

        const rawText = await resp.text();
        let rawJson: unknown;
        try {
          rawJson = JSON.parse(rawText);
        } catch {
          const fault = detectVjudgeInfraFault(rawText, resp.status);
          if (fault) throw fault;
          throw new JudgeInfrastructureError('upstream_unavailable', `VJudge returned invalid JSON for #${id}`, {
            platform: 'vjudge',
          });
        }
        const parsed = vjudgeSolutionResponseSchema.safeParse(rawJson);
        if (!parsed.success) {
          throw new JudgeInfrastructureError('upstream_unavailable', `VJudge returned unexpected JSON schema for #${id}`, {
            platform: 'vjudge',
          });
        }
        const data = parsed.data;

        if (data.captcha) {
          throw new JudgeInfrastructureError('captcha_required', `VJudge captcha triggered polling #${id}`, {
            platform: 'vjudge',
          });
        }
        if (data.error) {
          const fault = detectVjudgeInfraFault(data.error, resp.status);
          if (fault) throw fault;
          throw new JudgeInfrastructureError('upstream_unavailable', `VJudge poll error for #${id}`, {
            platform: 'vjudge',
          });
        }

        // Strict fail-closed identity verification: runId, handle, and target problem/contest MUST match.
        if (data.runId === undefined || String(data.runId) !== id) {
          throw new JudgeInfrastructureError('identity_mismatch', `VJudge submission ID mismatch for #${id}`, {
            platform: 'vjudge',
          });
        }
        const remoteAuthor = data.author ?? data.username;
        if (!remoteAuthor || remoteAuthor.toLowerCase() !== handle.toLowerCase()) {
          throw new JudgeInfrastructureError('identity_mismatch', `VJudge submission #${id} missing or mismatched handle`, {
            platform: 'vjudge',
          });
        }

        const localProblem = problems.get(id)!;
        const expected = targetFor(localProblem);
        if (normalizedContestId !== undefined) {
          if (data.contestId === undefined || String(data.contestId) !== normalizedContestId) {
            throw new JudgeInfrastructureError('identity_mismatch', `VJudge submission #${id} missing or mismatched contestId`, {
              platform: 'vjudge',
            });
          }
          if (!data.contestNum || data.contestNum !== expected) {
            throw new JudgeInfrastructureError(
              'identity_mismatch',
              `VJudge submission #${id} missing or mismatched contest problem index`,
              { platform: 'vjudge' },
            );
          }
        } else {
          const upstream = parseUpstreamProblemRef(expected);
          if (
            !data.oj ||
            !data.probNum ||
            data.oj.toLowerCase() !== upstream.oj.toLowerCase() ||
            data.probNum !== upstream.probNum
          ) {
            throw new JudgeInfrastructureError(
              'identity_mismatch',
              `VJudge submission #${id} missing or mismatched upstream problem`,
              { platform: 'vjudge' },
            );
          }
        }

        // Prioritize VJudge infrastructure fault detection (statusType === 2, statusCanonical === 'FAILED', text faults)
        const rawVerdict = data.status ?? data.statusCanonical ?? 'Pending';
        const canonicalUpper = data.statusCanonical?.trim().toUpperCase();
        if (data.statusType === 2 || canonicalUpper === 'FAILED') {
          throw new JudgeInfrastructureError(
            'upstream_unavailable',
            `VJudge reported submission/judge failure for #${id}`,
            { platform: 'vjudge' },
          );
        }
        const statusFault =
          detectVjudgeInfraFault(rawVerdict, resp.status) ??
          (data.statusCanonical ? detectVjudgeInfraFault(data.statusCanonical, resp.status) : null);
        if (statusFault) throw statusFault;

        if (data.processing === true) continue;

        const score = data.score;
        const maxScore = data.maxScore ?? data.max_score;
        const normalized = normalizeVerdict(data.statusCanonical ?? rawVerdict, score, maxScore);
        if (normalized === 'judge_error') {
          throw new JudgeInfrastructureError(
            'upstream_unavailable',
            `VJudge reported infrastructure verdict for #${id}`,
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
