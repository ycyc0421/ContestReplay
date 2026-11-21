import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { exactPracticeCandidates } from '../codeforces.js';
import type { OjAccount, OjAccountPool, OjAccounts } from '../oj-accounts.js';
import {
  type ContestPreview,
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
  safeResponseJson,
  serializeCookieHeader,
  walkHtml,
} from './types.js';

export const CODEFORCES_DEFAULT_ORIGIN = 'https://codeforces.com';
export const CODEFORCES_DEFAULT_SETTLEMENT_MS = 120_000;

export const CODEFORCES_LANGUAGE_PRESETS: LanguagePreset[] = [
  { id: 'cpp23', label: 'GNU G++23 14.2 (64 bit, msys2)', remote_id: '91', family: 'cpp' },
  { id: 'cpp20', label: 'GNU G++20 13.2 (64 bit, winlibs)', remote_id: '89', family: 'cpp' },
  { id: 'cpp17', label: 'GNU G++17 7.3.0', remote_id: '54', family: 'cpp' },
  { id: 'python3', label: 'Python 3.12', remote_id: '31', family: 'python' },
  { id: 'pypy3', label: 'PyPy 3.10 (7.3.15, 64bit)', remote_id: '70', family: 'python' },
  { id: 'rust', label: 'Rust 1.75.0 (2021)', remote_id: '75', family: 'rust' },
  { id: 'java21', label: 'Java 21 (64bit)', remote_id: '87', family: 'java' },
  { id: 'go', label: 'Go 1.22', remote_id: '32', family: 'go' },
];

const cfStatusResponseSchema = z.object({
  status: z.literal('OK'),
  result: z.array(
    z.object({
      id: z.number().int().positive(),
      contestId: z.number().int().optional(),
      problem: z.object({
        index: z.string(),
        contestId: z.number().int().optional(),
        points: z.number().optional(),
      }),
      author: z.object({
        members: z.array(z.object({ handle: z.string() })),
        participantType: z.string().optional(),
      }),
      programmingLanguage: z.string().optional(),
      creationTimeSeconds: z.number().int().optional(),
      verdict: z.string().optional(),
      points: z.number().optional(),
      timeConsumedMillis: z.number().int().nonnegative().optional(),
      memoryConsumedBytes: z.number().int().nonnegative().optional(),
    }),
  ),
});

type CfStatusRow = z.infer<typeof cfStatusResponseSchema>['result'][number];

const cfStandingsResponseSchema = z.object({
  status: z.literal('OK'),
  result: z.object({
    contest: z.object({
      id: z.number().int().positive().optional(),
      name: z.string(),
      phase: z.string(),
    }),
    problems: z
      .array(
        z.object({
          index: z.string(),
          name: z.string().optional(),
          points: z.number().optional(),
        }),
      )
      .min(1),
  }),
});

function routePrefix(gym: boolean): 'gym' | 'contest' {
  return gym ? 'gym' : 'contest';
}

function classifyHttpError(status: number, context: string): JudgeInfrastructureError {
  if (status === 401 || status === 403) {
    return new JudgeInfrastructureError('auth_expired', `Codeforces ${context}: HTTP ${status}`, {
      platform: 'codeforces',
      status,
    });
  }
  if (status === 429) {
    return new JudgeInfrastructureError('rate_limited', `Codeforces ${context}: HTTP 429 rate limited`, {
      platform: 'codeforces',
      status,
    });
  }
  return new JudgeInfrastructureError('upstream_unavailable', `Codeforces ${context}: HTTP ${status}`, {
    platform: 'codeforces',
    status,
  });
}

function detectCaptchaChallenge(html: string): boolean {
  return /cf-turnstile|g-recaptcha|h-captcha|just a moment\.\.\.|verify you are human|ddos-guard/i.test(html);
}

export function cfFormForContest(
  markup: string,
  contest: number,
  handle: string,
  opts?: { gym?: boolean; origin?: string },
) {
  const gym = Boolean(opts?.gym);
  const { baseUrl, origin } = resolveBaseUrl(opts?.origin ?? CODEFORCES_DEFAULT_ORIGIN, 'codeforces');
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const expectedPath = `${basePath}/${routePrefix(gym)}/${contest}/submit`;
  const submitPageUrl = `${origin}${expectedPath}`;
  const nodes = parseHtmlNodes(markup);
  const profile = nodes.some(
    el =>
      el.tagName === 'a' &&
      htmlAttr(el, 'href')?.toLowerCase() === `/profile/${handle.toLowerCase()}` &&
      htmlText(el).trim().toLowerCase() === handle.toLowerCase(),
  );
  const form = nodes.find(
    el =>
      el.tagName === 'form' &&
      walkHtml(el).some(node => htmlAttr(node, 'name') === 'submittedProblemIndex') &&
      walkHtml(el).some(node => htmlAttr(node, 'name') === 'source'),
  );
  // Check signed-in form FIRST so a problem title mentioning "captcha" does not false-positive.
  if (!profile || !form) {
    if (detectCaptchaChallenge(markup)) {
      throw new JudgeInfrastructureError('captcha_required', 'Codeforces returned a bot/captcha challenge page', {
        platform: 'codeforces',
      });
    }
    throw new JudgeInfrastructureError(
      'auth_expired',
      'Codeforces did not return the signed-in submission form (session expired or wrong handle)',
      { platform: 'codeforces' },
    );
  }
  // Resolve relative action (e.g. "?csrf_token=...") against the actual submit page URL.
  const rawAction = htmlAttr(form, 'action');
  const action = new URL(rawAction || expectedPath, submitPageUrl);
  if (action.origin !== origin || action.pathname !== expectedPath) {
    throw new JudgeInfrastructureError('upstream_unavailable', 'Unexpected Codeforces form route', {
      platform: 'codeforces',
    });
  }
  const fields = new URLSearchParams();
  for (const el of walkHtml(form)) {
    if (el.tagName === 'input' && htmlAttr(el, 'type') === 'hidden' && htmlAttr(el, 'name')) {
      fields.set(htmlAttr(el, 'name')!, htmlAttr(el, 'value') ?? '');
    }
  }
  if (!fields.get('csrf_token')) {
    throw new JudgeInfrastructureError('upstream_unavailable', 'Codeforces form has no CSRF token', {
      platform: 'codeforces',
    });
  }
  return { action, fields };
}

export function cfReceiptForContest(
  location: string | null,
  contest: number,
  opts?: { gym?: boolean; origin?: string },
): string | undefined {
  if (!location) return undefined;
  const gym = Boolean(opts?.gym);
  const { baseUrl, origin } = resolveBaseUrl(opts?.origin ?? CODEFORCES_DEFAULT_ORIGIN, 'codeforces');
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const url = new URL(location, `${baseUrl}/`);
  if (url.origin !== origin) return undefined;
  const prefix = routePrefix(gym);
  const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = url.pathname.match(new RegExp(`^${escapedBase}/${prefix}/${contest}/submission/(\\d+)/?$`))?.[1];
  if (!matched) return undefined;
  const value = Number(matched);
  return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}

/**
 * Parse authenticated `/gym/<id>/my` HTML status table into CfStatusRow records
 * as a fallback when Codeforces API `contest.status` is restricted for a Gym.
 */
export function parseCfMySubmissionsHtml(markup: string, contest: number, handle: string): CfStatusRow[] {
  const nodes = parseHtmlNodes(markup);
  const rows: CfStatusRow[] = [];
  for (const tr of nodes) {
    if (tr.tagName !== 'tr') continue;
    const rawSubId = htmlAttr(tr, 'data-submission-id');
    const subId = rawSubId ? Number(rawSubId) : undefined;
    if (!subId || !Number.isSafeInteger(subId) || subId <= 0) continue;

    const tds = (tr.childNodes ?? []).filter(c => c.tagName === 'td');
    if (tds.length < 6) continue;

    let problemIndex: string | undefined;
    let authorHandle: string | undefined;
    let verdictText = '';
    let timeMs: number | undefined;
    let memBytes: number | undefined;

    for (const td of tds) {
      const tdNodes = walkHtml(td);
      for (const n of tdNodes) {
        if (n.tagName === 'a') {
          const href = htmlAttr(n, 'href') ?? '';
          const pMatch = href.match(new RegExp(`/(?:gym|contest)/${contest}/problem/([A-Za-z0-9]+)`));
          if (pMatch?.[1] && !problemIndex) problemIndex = pMatch[1];
          const uMatch = href.match(/^\/profile\/([^/?#]+)$/);
          if (uMatch?.[1] && !authorHandle) authorHandle = decodeURIComponent(uMatch[1]);
        }
        const verdictAttr = htmlAttr(n, 'submissionverdict');
        if (verdictAttr) verdictText = verdictAttr;
      }
      const cls = htmlAttr(td, 'class') ?? '';
      const txt = htmlText(td).replace(/\s+/g, ' ').trim();
      if (cls.includes('status-verdict-cell') && !verdictText) verdictText = txt;
      if (cls.includes('time-consumed-cell')) {
        const m = txt.match(/(\d+)\s*ms/i);
        if (m?.[1]) timeMs = Number(m[1]);
      }
      if (cls.includes('memory-consumed-cell')) {
        const m = txt.match(/(\d+)\s*KB/i);
        if (m?.[1]) memBytes = Number(m[1]) * 1024;
      }
    }

    if (!problemIndex) continue;
    const effectiveHandle = authorHandle ?? handle;
    rows.push({
      id: subId,
      contestId: contest,
      problem: { index: problemIndex, contestId: contest },
      author: {
        participantType: 'PRACTICE',
        members: [{ handle: effectiveHandle }],
      },
      creationTimeSeconds: Math.floor(Date.now() / 1000),
      ...(verdictText ? { verdict: verdictText } : {}),
      ...(timeMs !== undefined ? { timeConsumedMillis: timeMs } : {}),
      ...(memBytes !== undefined ? { memoryConsumedBytes: memBytes } : {}),
    });
  }
  return rows;
}

async function cfApiRequest(
  method: 'user.status' | 'contest.status' | 'contest.standings',
  params: Record<string, string>,
  opts: { baseUrl: string; fetchImpl: FetchLike; signal?: AbortSignal },
): Promise<unknown> {
  const url = new URL(`${opts.baseUrl}/api/${method}`);
  url.search = new URLSearchParams(params).toString();
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(opts.signal ? [opts.signal] : [])]);
  let response: Response;
  try {
    response = await opts.fetchImpl(url, { redirect: 'error', signal });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new JudgeInfrastructureError('upstream_unavailable', `Codeforces API ${method} request failed`, {
      platform: 'codeforces',
    });
  }
  if (!response.ok) throw classifyHttpError(response.status, `API ${method}`);
  return safeResponseJson(response, 'codeforces', `API ${method}`);
}

export async function previewCodeforcesContest(
  contestId: number | string,
  opts?: { gym?: boolean; baseUrl?: string; fetchImpl?: FetchLike; signal?: AbortSignal },
): Promise<ContestPreview> {
  const numericId = typeof contestId === 'number' ? contestId : Number(String(contestId).replace(/^gym:/i, ''));
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new JudgeInfrastructureError('upstream_unavailable', `Invalid Codeforces contest ID`, {
      platform: 'codeforces',
    });
  }
  const gym = opts?.gym ?? (typeof contestId === 'string' && /^gym:/i.test(contestId));
  const { baseUrl } = resolveBaseUrl(opts?.baseUrl ?? CODEFORCES_DEFAULT_ORIGIN, 'codeforces');
  const fetchImpl = opts?.fetchImpl ?? fetch;

  // Regular contests do not pass extra from/count params (matching runner/codeforces.ts).
  const params: Record<string, string> = gym
    ? { contestId: String(numericId), showUnofficial: 'false' }
    : { contestId: String(numericId) };

  const raw = await cfApiRequest('contest.standings', params, { baseUrl, fetchImpl, signal: opts?.signal });
  const parsed = cfStandingsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new JudgeInfrastructureError('upstream_unavailable', 'Unexpected Codeforces contest.standings payload', {
      platform: 'codeforces',
    });
  }
  const { contest, problems } = parsed.data.result;
  const phase = contest.phase.toUpperCase();
  const status: ContestPreview['status'] =
    phase === 'FINISHED'
      ? 'finished'
      : phase === 'CODING' || phase === 'PENDING_SYSTEM_TEST' || phase === 'SYSTEM_TEST'
        ? 'active'
        : 'unknown';

  return {
    platform: 'codeforces',
    contest_ref: gym ? `gym:${numericId}` : String(numericId),
    title: contest.name,
    status,
    problems: problems.map(p => ({
      remote_id: p.index,
      ...(p.name ? { title: p.name } : {}),
      ...(p.points !== undefined ? { max_points: p.points } : {}),
    })),
    suggested_languages: CODEFORCES_LANGUAGE_PRESETS,
  };
}

export interface CodeforcesJudgeConfig {
  contest_id: number;
  gym?: boolean;
  handle?: string;
  languages: Record<string, string | number>;
  problem_map?: Record<string, string>;
  account_id?: string;
  base_url?: string;
  settlement_ms?: number;
}

export interface CodeforcesJudgeDeps {
  accounts?: OjAccounts;
  pool?: OjAccountPool;
  account?: OjAccount;
  cookie?: string;
  executable?: string;
  fetchImpl?: FetchLike;
  execImpl?: ExecFileLike;
  delayImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  skipContestCheck?: boolean;
}

export function createCodeforcesJudge(
  config: CodeforcesJudgeConfig,
  deps: CodeforcesJudgeDeps = {},
): ProgramJudge {
  const gym = Boolean(config.gym);
  const { baseUrl, origin } = resolveBaseUrl(config.base_url ?? CODEFORCES_DEFAULT_ORIGIN, 'codeforces');
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delayImpl = deps.delayImpl ?? ((ms, sig) => delay(ms, undefined, { signal: sig }));
  const settlementMs = config.settlement_ms ?? CODEFORCES_DEFAULT_SETTLEMENT_MS;
  const prefix = routePrefix(gym);

  const targetFor = (problem: string) =>
    Object.hasOwn(config.problem_map ?? {}, problem) ? config.problem_map![problem]! : problem;

  // Cache ONLY a verified contest check; clear on failure/cancellation so transient errors can retry.
  let checkedContest: Promise<ContestPreview> | undefined;

  function resolveTransport() {
    return resolveAdapterTransport({
      platform: 'codeforces',
      baseUrl,
      origin,
      configHandle: config.handle,
      configAccountId: config.account_id,
      deps,
    });
  }

  async function fetchGymMyHtml(handle: string, cookie: string, signal: AbortSignal): Promise<CfStatusRow[]> {
    const session = parseCookieHeader(cookie, 'codeforces');
    const url = `${baseUrl}/gym/${config.contest_id}/my`;
    const resp = await fetchImpl(url, {
      headers: { cookie: serializeCookieHeader(session) },
      redirect: 'manual',
      signal,
    });
    if (resp.status >= 300 && resp.status < 400) {
      throw new JudgeInfrastructureError('auth_expired', 'Codeforces redirected /gym/my request (sign-in required)', {
        platform: 'codeforces',
        status: resp.status,
      });
    }
    if (!resp.ok) throw classifyHttpError(resp.status, 'gym my submissions');
    return parseCfMySubmissionsHtml(await resp.text(), config.contest_id, handle);
  }

  async function fetchSubmissions(
    handle: string,
    count: number,
    signal: AbortSignal,
    cookie?: string,
  ): Promise<CfStatusRow[]> {
    if (gym) {
      // CF user.status does NOT return Gym submissions; use contest.status for Gym.
      try {
        const raw = await cfApiRequest(
          'contest.status',
          { contestId: String(config.contest_id), handle, from: '1', count: String(count) },
          { baseUrl, fetchImpl, signal },
        );
        const parsed = cfStatusResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new JudgeInfrastructureError('upstream_unavailable', 'Invalid Codeforces contest.status payload', {
            platform: 'codeforces',
          });
        }
        return parsed.data.result;
      } catch (err) {
        if (
          cookie &&
          err instanceof JudgeInfrastructureError &&
          (err.code === 'auth_expired' || err.details?.status === 400)
        ) {
          return fetchGymMyHtml(handle, cookie, signal);
        }
        throw err;
      }
    }

    const raw = await cfApiRequest(
      'user.status',
      { handle, from: '1', count: String(count) },
      { baseUrl, fetchImpl, signal },
    );
    const parsed = cfStatusResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new JudgeInfrastructureError('upstream_unavailable', 'Invalid Codeforces user.status payload', {
        platform: 'codeforces',
      });
    }
    return parsed.data.result;
  }

  async function submitViaCookie(
    target: string,
    languageId: string,
    source: string,
    handle: string,
    cookie: string,
    signal: AbortSignal,
  ): Promise<string> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const submitUrl = `${baseUrl}/${prefix}/${config.contest_id}/submit`;
    const session = parseCookieHeader(cookie, 'codeforces');
    const cookieHeader = () => ({ cookie: serializeCookieHeader(session) });

    let formResponse: Response;
    try {
      formResponse = await fetchImpl(submitUrl, { headers: cookieHeader(), redirect: 'manual', signal: requestSignal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JudgeInfrastructureError('upstream_unavailable', 'Codeforces submit form fetch failed', {
        platform: 'codeforces',
      });
    }
    if (formResponse.status >= 300 && formResponse.status < 400) {
      throw new JudgeInfrastructureError('auth_expired', 'Codeforces redirected away from submit page (sign-in required)', {
        platform: 'codeforces',
        status: formResponse.status,
      });
    }
    if (!formResponse.ok) throw classifyHttpError(formResponse.status, 'submit page');
    mergeSetCookies(session, formResponse.headers);

    const { action, fields } = cfFormForContest(await formResponse.text(), config.contest_id, handle, {
      gym,
      origin: baseUrl,
    });
    fields.set('action', 'submitSolutionFormSubmitted');
    fields.set('submittedProblemIndex', target);
    fields.set('programTypeId', languageId);
    fields.set('contestId', String(config.contest_id));
    fields.set('source', source);
    fields.set('tabSize', '4');

    const before = await fetchSubmissions(handle, 10, requestSignal, serializeCookieHeader(session));
    const baseline = Math.max(0, ...before.map(row => row.id));
    const since = Math.floor(Date.now() / 1000) - 10;

    let uploaded: Response;
    try {
      uploaded = await fetchImpl(action, {
        method: 'POST',
        headers: { ...cookieHeader(), origin, referer: submitUrl },
        body: fields,
        redirect: 'manual',
        signal: requestSignal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JudgeInfrastructureError('submission_unconfirmed', 'Codeforces submit POST failed; will not retry', {
        platform: 'codeforces',
      });
    }

    const location = uploaded.headers.get('location');
    const redirect = location && uploaded.status >= 300 && uploaded.status < 400 ? new URL(location, submitUrl) : undefined;
    const directId = redirect ? cfReceiptForContest(redirect.href, config.contest_id, { gym, origin: baseUrl }) : undefined;
    if (directId) {
      await uploaded.body?.cancel();
      return directId;
    }

    const expectedMyPath = `${basePath}/${prefix}/${config.contest_id}/my`;
    const listRedirect = redirect?.origin === origin && redirect.pathname === expectedMyPath;
    const bodyText = uploaded.ok ? await uploaded.text() : '';
    if (!uploaded.ok) await uploaded.body?.cancel();
    if (bodyText && detectCaptchaChallenge(bodyText)) {
      throw new JudgeInfrastructureError('captcha_required', 'Codeforces challenged the submission with captcha', {
        platform: 'codeforces',
      });
    }
    const confirmed = uploaded.ok && /submitted successfully/i.test(bodyText);

    if (listRedirect || confirmed) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await delayImpl(2500, requestSignal);
        const rows = await fetchSubmissions(handle, 30, requestSignal, serializeCookieHeader(session));
        const candidates = exactPracticeCandidates(rows, {
          baseline,
          contest: config.contest_id,
          problem: target,
          handle,
          since,
        });
        const newerCount = rows.filter(row => row.id > baseline).length;
        if (candidates.length === 1 && newerCount === 1) return String(candidates[0]!);
        if (newerCount > 0) {
          throw new JudgeInfrastructureError(
            'identity_mismatch',
            'Ambiguous Codeforces submission: the account must be dedicated to this run',
            { platform: 'codeforces' },
          );
        }
      }
      throw new JudgeInfrastructureError(
        'submission_unconfirmed',
        'Could not confirm the Codeforces submission ID after post',
        { platform: 'codeforces' },
      );
    }

    if (uploaded.status === 401 || uploaded.status === 403) {
      throw classifyHttpError(uploaded.status, 'submit POST');
    }
    if (uploaded.status === 429) {
      throw classifyHttpError(429, 'submit POST');
    }
    throw new JudgeInfrastructureError(
      'submission_unconfirmed',
      'Codeforces did not confirm submission; it will not be retried',
      { platform: 'codeforces', status: uploaded.status },
    );
  }

  return {
    kind: 'codeforces',
    settlementMs,

    async submit(problem, language, source, signal) {
      const langId = config.languages[language];
      if (langId === undefined) {
        throw new Error(`Unsupported Codeforces language key: ${language}`);
      }
      // Resolve transport & origin binding BEFORE any network requests.
      const transport = await resolveTransport();

      if (!deps.skipContestCheck) {
        if (!checkedContest) {
          const checkPromise = previewCodeforcesContest(config.contest_id, {
            gym,
            baseUrl,
            fetchImpl,
            signal,
          }).then(preview => {
            if (preview.status !== 'finished') {
              throw new JudgeInfrastructureError(
                'upstream_unavailable',
                `Codeforces contest ${config.contest_id} is not finished`,
                { platform: 'codeforces' },
              );
            }
            return preview;
          });
          checkedContest = checkPromise;
          checkPromise.catch(() => {
            if (checkedContest === checkPromise) checkedContest = undefined;
          });
        }
        await checkedContest;
      }

      const target = targetFor(problem);
      const execute = async () => {
        if (transport.mode === 'submitter') {
          return runExternalSubmitter({
            platform: 'codeforces',
            executable: transport.executable!,
            args: [
              String(config.contest_id),
              target,
              String(langId),
              '__SOURCE_FILE__',
              transport.handle,
              ...(gym ? ['--gym'] : []),
            ],
            source,
            env: {
              CR_OJ_PLATFORM: 'codeforces',
              CR_CF_CONTEST_ID: String(config.contest_id),
              CR_CF_GYM: gym ? '1' : '0',
              CR_CF_PROBLEM: target,
              CR_CF_LANGUAGE_ID: String(langId),
              CR_CF_HANDLE: transport.handle,
            },
            signal,
            execImpl: deps.execImpl,
          });
        }
        return submitViaCookie(target, String(langId), source, transport.handle, transport.cookie!, signal);
      };

      if (deps.pool) {
        return deps.pool.enqueueSubmission(transport.queueKey, execute, signal);
      }
      return execute();
    },

    async verdicts(ids, problems, signal) {
      if (!ids.length) return new Map();
      const transport = await resolveTransport();
      const handle = transport.handle;
      const rows = await fetchSubmissions(handle, 1000, signal, transport.mode === 'cookie' ? transport.cookie : undefined);
      const wanted = new Set(ids);
      const result = new Map<string, JudgeVerdict>();

      for (const row of rows) {
        const remoteId = String(row.id);
        if (!wanted.has(remoteId)) continue;
        const localProblem = problems.get(remoteId);
        if (!localProblem) continue;
        const expectedIndex = targetFor(localProblem);
        if (
          (row.contestId ?? row.problem.contestId) !== config.contest_id ||
          row.problem.index !== expectedIndex ||
          row.author.participantType !== 'PRACTICE' ||
          row.author.members.length !== 1 ||
          row.author.members[0]?.handle.toLowerCase() !== handle.toLowerCase()
        ) {
          throw new JudgeInfrastructureError('identity_mismatch', 'Remote Codeforces submission identity mismatch', {
            platform: 'codeforces',
          });
        }
        const rawVerdict = row.verdict ?? 'TESTING';
        // Only treat CF points as IOI partial score when the verdict is explicitly PARTIAL
        // (avoids confusing CF time-decayed contest points with partial scoring).
        const isExplicitPartial = rawVerdict.toUpperCase() === 'PARTIAL';
        const score = isExplicitPartial ? row.points : undefined;
        const maxScore = isExplicitPartial ? row.problem.points : undefined;
        const normalized = normalizeVerdict(rawVerdict, score, maxScore);
        if (normalized === 'judge_error') {
          throw new JudgeInfrastructureError(
            'upstream_unavailable',
            `Codeforces reported judge error for submission ${remoteId}`,
            { platform: 'codeforces' },
          );
        }
        if (isFinalVerdict(normalized)) {
          result.set(remoteId, {
            remote_submission_id: remoteId,
            verdict: normalized,
            raw_verdict: rawVerdict,
            ...(score !== undefined ? { score } : {}),
            ...(maxScore !== undefined ? { max_score: maxScore } : {}),
            ...(row.timeConsumedMillis !== undefined ? { time_ms: row.timeConsumedMillis } : {}),
            ...(row.memoryConsumedBytes !== undefined ? { memory_kb: Math.round(row.memoryConsumedBytes / 1024) } : {}),
            final: true,
          });
        }
      }
      return result;
    },
  };
}
