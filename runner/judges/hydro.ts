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
  type NormalizedVerdict,
  type ProgramJudge,
  isFinalVerdict,
  mergeSetCookies,
  normalizeVerdict,
  parseCookieHeader,
  runExternalSubmitter,
  serializeCookieHeader,
  validateOriginUrl,
} from './types.js';

export const HYDRO_DEFAULT_SETTLEMENT_MS = 120_000;

export const HYDRO_LANGUAGE_PRESETS: LanguagePreset[] = [
  { id: 'cpp20', label: 'C++20 (O2)', remote_id: 'cc.cc20o2', family: 'cpp' },
  { id: 'cpp17', label: 'C++17 (O2)', remote_id: 'cc.cc17o2', family: 'cpp' },
  { id: 'cpp14', label: 'C++14 (O2)', remote_id: 'cc.cc14o2', family: 'cpp' },
  { id: 'python3', label: 'Python 3', remote_id: 'py.py3', family: 'python' },
  { id: 'pypy3', label: 'PyPy 3', remote_id: 'py.pypy3', family: 'python' },
  { id: 'rust', label: 'Rust', remote_id: 'rs', family: 'rust' },
  { id: 'java', label: 'Java', remote_id: 'java', family: 'java' },
];

/**
 * Hydro OJ numeric status codes (from hydrooj/src/constant.ts):
 *   0: STATUS_WAITING
 *   1: STATUS_ACCEPTED
 *   2: STATUS_WRONG_ANSWER
 *   3: STATUS_TIME_LIMIT_EXCEEDED
 *   4: STATUS_MEMORY_LIMIT_EXCEEDED
 *   5: STATUS_OUTPUT_LIMIT_EXCEEDED
 *   6: STATUS_RUNTIME_ERROR
 *   7: STATUS_COMPILE_ERROR
 *   8: STATUS_SYSTEM_ERROR
 *   9: STATUS_CANCELED
 *  10: STATUS_ETC
 *  11: STATUS_HACKED
 *  20: STATUS_JUDGING
 *  21: STATUS_COMPILING
 *  22: STATUS_FETCHED
 *  30: STATUS_IGNORED
 */
export const HYDRO_STATUS = {
  WAITING: 0,
  ACCEPTED: 1,
  WRONG_ANSWER: 2,
  TIME_LIMIT_EXCEEDED: 3,
  MEMORY_LIMIT_EXCEEDED: 4,
  OUTPUT_LIMIT_EXCEEDED: 5,
  RUNTIME_ERROR: 6,
  COMPILE_ERROR: 7,
  SYSTEM_ERROR: 8,
  CANCELED: 9,
  ETC: 10,
  HACKED: 11,
  JUDGING: 20,
  COMPILING: 21,
  FETCHED: 22,
  IGNORED: 30,
} as const;

export function mapHydroStatus(
  status: number | string,
  score?: number,
  maxScore?: number,
): { verdict: NormalizedVerdict; raw: string; infraError?: boolean } {
  if (typeof status === 'string') {
    const normalized = normalizeVerdict(status, score, maxScore);
    return { verdict: normalized, raw: status, infraError: normalized === 'judge_error' };
  }

  const hasPartialScore = score !== undefined && score > 0 && (maxScore === undefined || score < maxScore);

  switch (status) {
    case HYDRO_STATUS.WAITING:
      return { verdict: 'pending', raw: 'WAITING' };
    case HYDRO_STATUS.JUDGING:
      return { verdict: 'pending', raw: 'JUDGING' };
    case HYDRO_STATUS.COMPILING:
      return { verdict: 'pending', raw: 'COMPILING' };
    case HYDRO_STATUS.FETCHED:
      return { verdict: 'pending', raw: 'FETCHED' };
    case HYDRO_STATUS.ACCEPTED:
      return { verdict: 'accepted', raw: 'ACCEPTED' };
    case HYDRO_STATUS.WRONG_ANSWER:
      return { verdict: hasPartialScore ? 'partial' : 'wrong_answer', raw: 'WRONG_ANSWER' };
    case HYDRO_STATUS.TIME_LIMIT_EXCEEDED:
      return { verdict: hasPartialScore ? 'partial' : 'time_limit_exceeded', raw: 'TIME_LIMIT_EXCEEDED' };
    case HYDRO_STATUS.MEMORY_LIMIT_EXCEEDED:
      return { verdict: hasPartialScore ? 'partial' : 'memory_limit_exceeded', raw: 'MEMORY_LIMIT_EXCEEDED' };
    case HYDRO_STATUS.OUTPUT_LIMIT_EXCEEDED:
      return { verdict: hasPartialScore ? 'partial' : 'runtime_error', raw: 'OUTPUT_LIMIT_EXCEEDED' };
    case HYDRO_STATUS.RUNTIME_ERROR:
      return { verdict: hasPartialScore ? 'partial' : 'runtime_error', raw: 'RUNTIME_ERROR' };
    case HYDRO_STATUS.COMPILE_ERROR:
      return { verdict: 'compilation_error', raw: 'COMPILE_ERROR' };
    case HYDRO_STATUS.SYSTEM_ERROR:
      return { verdict: 'judge_error', raw: 'SYSTEM_ERROR', infraError: true };
    case HYDRO_STATUS.CANCELED:
      return { verdict: 'judge_error', raw: 'CANCELED', infraError: true };
    case HYDRO_STATUS.HACKED:
      return { verdict: 'wrong_answer', raw: 'HACKED' };
    case HYDRO_STATUS.IGNORED:
      return { verdict: 'other', raw: 'IGNORED' };
    default:
      return { verdict: hasPartialScore ? 'partial' : 'other', raw: `STATUS_${status}` };
  }
}

function classifyHttpError(status: number, context: string): JudgeInfrastructureError {
  if (status === 401 || status === 403) {
    return new JudgeInfrastructureError('auth_expired', `Hydro ${context}: HTTP ${status}`, {
      platform: 'hydro',
      status,
    });
  }
  if (status === 429) {
    return new JudgeInfrastructureError('rate_limited', `Hydro ${context}: HTTP 429 rate limited`, {
      platform: 'hydro',
      status,
    });
  }
  return new JudgeInfrastructureError('upstream_unavailable', `Hydro ${context}: HTTP ${status}`, {
    platform: 'hydro',
    status,
  });
}

function domainPrefix(domain?: string): string {
  const clean = domain?.trim();
  if (!clean || clean === 'system') return '';
  return `/d/${encodeURIComponent(clean)}`;
}

const hydroRecordSchema = z.object({
  _id: z.union([z.string().min(1), z.number()]).optional(),
  id: z.union([z.string().min(1), z.number()]).optional(),
  status: z.union([z.number().int(), z.string()]),
  score: z.number().optional(),
  maxScore: z.number().optional(),
  time: z.number().optional(),
  memory: z.number().optional(),
  pid: z.union([z.string(), z.number()]).optional(),
  uname: z.string().optional(),
});

const hydroRecordEnvelopeSchema = z.object({
  rdoc: hydroRecordSchema.optional(),
  record: hydroRecordSchema.optional(),
  pdoc: z.object({ pid: z.union([z.string(), z.number()]).optional(), docId: z.union([z.string(), z.number()]).optional(), maxScore: z.number().optional() }).optional(),
  udoc: z.object({ uname: z.string().optional() }).optional(),
  error: z.object({ message: z.string().optional(), name: z.string().optional() }).optional(),
});

const hydroSubmitResponseSchema = z.object({
  rid: z.union([z.string().min(1), z.number()]).optional(),
  id: z.union([z.string().min(1), z.number()]).optional(),
  url: z.string().optional(),
  error: z.object({ message: z.string().optional(), name: z.string().optional() }).optional(),
});

const hydroContestPreviewSchema = z.object({
  tdoc: z.object({
    docId: z.union([z.string(), z.number()]).optional(),
    title: z.string(),
    beginAt: z.string().optional(),
    endAt: z.string().optional(),
    pids: z.array(z.union([z.string(), z.number()])).optional(),
  }),
  pdict: z
    .record(
      z.string(),
      z.object({
        docId: z.union([z.string(), z.number()]).optional(),
        pid: z.union([z.string(), z.number()]).optional(),
        title: z.string().optional(),
        maxScore: z.number().optional(),
      }),
    )
    .optional(),
});

export async function previewHydroContest(
  contestId: string,
  opts: { baseUrl: string; domain?: string; cookie?: string; fetchImpl?: FetchLike; signal?: AbortSignal },
): Promise<ContestPreview> {
  const origin = validateOriginUrl(opts.baseUrl, 'hydro');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(opts.signal ? [opts.signal] : [])]);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.cookie) {
    headers.cookie = serializeCookieHeader(parseCookieHeader(opts.cookie, 'hydro'));
  }

  const url = `${origin}${domainPrefix(opts.domain)}/contest/${encodeURIComponent(contestId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, redirect: 'manual', signal });
  } catch (cause) {
    if (opts.signal?.aborted) throw cause;
    throw new JudgeInfrastructureError('upstream_unavailable', 'Hydro contest preview request failed', {
      platform: 'hydro',
      cause,
    });
  }
  if (!response.ok) throw classifyHttpError(response.status, 'contest preview');

  const parsed = hydroContestPreviewSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new JudgeInfrastructureError('upstream_unavailable', 'Unexpected Hydro contest JSON payload', {
      platform: 'hydro',
    });
  }

  const { tdoc, pdict } = parsed.data;
  const now = Date.now();
  let status: ContestPreview['status'] = 'unknown';
  if (tdoc.endAt) {
    const endTs = Date.parse(tdoc.endAt);
    const beginTs = tdoc.beginAt ? Date.parse(tdoc.beginAt) : undefined;
    if (Number.isFinite(endTs)) {
      if (now > endTs) status = 'finished';
      else if (beginTs === undefined || !Number.isFinite(beginTs) || now >= beginTs) status = 'active';
    }
  }

  const pids = tdoc.pids ?? (pdict ? Object.keys(pdict) : []);
  const problems: ContestPreviewProblem[] = pids.map(rawPid => {
    const key = String(rawPid);
    const info = pdict?.[key];
    return {
      remote_id: info?.pid !== undefined ? String(info.pid) : key,
      ...(info?.title ? { title: info.title } : {}),
      ...(info?.maxScore !== undefined ? { max_points: info.maxScore } : {}),
    };
  });

  return {
    platform: 'hydro',
    contest_ref: opts.domain ? `hydro:${opts.domain}:${contestId}` : `hydro:${contestId}`,
    title: tdoc.title,
    status,
    problems,
    suggested_languages: HYDRO_LANGUAGE_PRESETS,
  };
}

export interface HydroJudgeConfig {
  base_url: string;
  domain?: string;
  contest_id?: string;
  handle: string;
  languages: Record<string, string>;
  problem_map?: Record<string, string>;
  account_id?: string;
  settlement_ms?: number;
}

export interface HydroJudgeDeps {
  accounts?: OjAccounts;
  pool?: OjAccountPool;
  account?: OjAccount;
  cookie?: string;
  executable?: string;
  fetchImpl?: FetchLike;
  execImpl?: ExecFileLike;
}

export function createHydroJudge(config: HydroJudgeConfig, deps: HydroJudgeDeps = {}): ProgramJudge {
  const origin = validateOriginUrl(config.base_url, 'hydro');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const settlementMs = config.settlement_ms ?? HYDRO_DEFAULT_SETTLEMENT_MS;
  const prefix = domainPrefix(config.domain);

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
      if (account.platform !== 'hydro') {
        throw new JudgeInfrastructureError('auth_expired', `OJ account ${account.id} is not a Hydro account`, {
          platform: 'hydro',
        });
      }
      if (account.base_url && new URL(account.base_url).origin !== new URL(origin).origin) {
        throw new JudgeInfrastructureError('auth_expired', 'Hydro account origin does not match judge base_url', {
          platform: 'hydro',
        });
      }
      if (account.transport === 'submitter') {
        if (!account.executable_path) {
          throw new JudgeInfrastructureError('submitter_failed', 'Hydro submitter account has no executable_path', {
            platform: 'hydro',
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
    const envExec = process.env.CR_HYDRO_SUBMITTER?.trim();
    if (envExec) {
      return { mode: 'submitter', executable: envExec, handle: config.handle, accountId: config.account_id };
    }
    const envCookie = process.env.CR_HYDRO_COOKIE?.trim();
    if (envCookie) {
      return { mode: 'cookie', cookie: envCookie, handle: config.handle, accountId: config.account_id };
    }
    throw new JudgeInfrastructureError('auth_expired', 'No Hydro OJ account, cookie, or submitter configured', {
      platform: 'hydro',
    });
  }

  async function submitViaCookie(
    remoteProblemId: string,
    remoteLang: string,
    source: string,
    cookie: string,
    signal: AbortSignal,
  ): Promise<string> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const session = parseCookieHeader(cookie, 'hydro');
    const submitUrl = config.contest_id
      ? `${origin}${prefix}/contest/${encodeURIComponent(config.contest_id)}/p/${encodeURIComponent(remoteProblemId)}/submit`
      : `${origin}${prefix}/p/${encodeURIComponent(remoteProblemId)}/submit`;

    let response: Response;
    try {
      response = await fetchImpl(submitUrl, {
        method: 'POST',
        headers: {
          cookie: serializeCookieHeader(session),
          accept: 'application/json',
          'content-type': 'application/json',
          origin,
          referer: submitUrl,
        },
        body: JSON.stringify({ lang: remoteLang, code: source }),
        redirect: 'manual',
        signal: requestSignal,
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new JudgeInfrastructureError('submission_unconfirmed', 'Hydro submit POST failed; will not retry', {
        platform: 'hydro',
        cause,
      });
    }

    const location = response.headers.get('location');
    if (location && response.status >= 300 && response.status < 400) {
      const targetUrl = new URL(location, origin);
      if (targetUrl.origin === origin) {
        const ridMatch = targetUrl.pathname.match(/\/record\/([A-Za-z0-9_-]+)\/?$/);
        if (ridMatch?.[1]) {
          await response.body?.cancel();
          return ridMatch[1];
        }
      }
      await response.body?.cancel();
      throw new JudgeInfrastructureError('auth_expired', `Unexpected Hydro submit redirect: ${location}`, {
        platform: 'hydro',
        status: response.status,
      });
    }

    if (!response.ok) throw classifyHttpError(response.status, 'submit');
    mergeSetCookies(session, response.headers);

    const parsed = hydroSubmitResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new JudgeInfrastructureError('submission_unconfirmed', 'Hydro submit returned invalid JSON payload', {
        platform: 'hydro',
      });
    }
    if (parsed.data.error) {
      const msg = parsed.data.error.message ?? parsed.data.error.name ?? 'unknown error';
      if (/login|permission|privilege|unauthorized/i.test(msg)) {
        throw new JudgeInfrastructureError('auth_expired', `Hydro submit auth error: ${msg}`, { platform: 'hydro' });
      }
      throw new JudgeInfrastructureError('submission_unconfirmed', `Hydro submit error: ${msg}`, { platform: 'hydro' });
    }
    const rid = parsed.data.rid ?? parsed.data.id;
    if (rid !== undefined) return String(rid);
    if (parsed.data.url) {
      const ridMatch = parsed.data.url.match(/\/record\/([A-Za-z0-9_-]+)\/?$/);
      if (ridMatch?.[1]) return ridMatch[1];
    }
    throw new JudgeInfrastructureError('submission_unconfirmed', 'Hydro submit response missing record id', {
      platform: 'hydro',
    });
  }

  return {
    kind: 'hydro',
    settlementMs,

    async submit(problem, language, source, signal) {
      const remoteLang = config.languages[language];
      if (!remoteLang) {
        throw new Error(`Unsupported Hydro language key: ${language}`);
      }
      const remoteProblemId = targetFor(problem);
      const transport = await resolveTransport();

      const execute = async () => {
        if (transport.mode === 'submitter') {
          return runExternalSubmitter({
            platform: 'hydro',
            executable: transport.executable,
            args: [
              origin,
              config.domain ?? 'system',
              config.contest_id ?? 'none',
              remoteProblemId,
              remoteLang,
              '__SOURCE_FILE__',
              transport.handle,
            ],
            source,
            env: {
              CR_OJ_PLATFORM: 'hydro',
              CR_HYDRO_BASE_URL: origin,
              CR_HYDRO_DOMAIN: config.domain ?? 'system',
              CR_HYDRO_CONTEST_ID: config.contest_id ?? '',
              CR_HYDRO_PROBLEM: remoteProblemId,
              CR_HYDRO_LANGUAGE: remoteLang,
              CR_HYDRO_HANDLE: transport.handle,
            },
            signal,
            execImpl: deps.execImpl,
          });
        }
        return submitViaCookie(remoteProblemId, remoteLang, source, transport.cookie, signal);
      };

      const serializationKey = transport.accountId ?? `hydro:${origin}:${transport.handle.toLowerCase()}`;
      if (deps.pool) {
        return deps.pool.enqueueSubmission(serializationKey, execute, signal);
      }
      return execute();
    },

    async verdicts(ids, problems, signal) {
      if (!ids.length) return new Map();
      const transport = await resolveTransport().catch(() => undefined);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (transport?.mode === 'cookie') {
        headers.cookie = serializeCookieHeader(parseCookieHeader(transport.cookie, 'hydro'));
      }
      const handle = transport?.handle ?? config.handle;
      const result = new Map<string, JudgeVerdict>();

      for (const id of ids) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const url = `${origin}${prefix}/record/${encodeURIComponent(id)}`;
        let resp: Response;
        try {
          resp = await fetchImpl(url, { headers, redirect: 'manual', signal: requestSignal });
        } catch (cause) {
          if (signal.aborted) throw cause;
          throw new JudgeInfrastructureError('upstream_unavailable', `Hydro record fetch failed for ${id}`, {
            platform: 'hydro',
            cause,
          });
        }
        if (resp.status >= 300 && resp.status < 400) {
          throw new JudgeInfrastructureError('auth_expired', `Hydro redirected record fetch for ${id}`, {
            platform: 'hydro',
            status: resp.status,
          });
        }
        if (!resp.ok) throw classifyHttpError(resp.status, `record ${id}`);

        const rawJson = await resp.json();
        const envelope = hydroRecordEnvelopeSchema.safeParse(rawJson);
        const directRecord = envelope.success && (envelope.data.rdoc || envelope.data.record)
          ? (envelope.data.rdoc ?? envelope.data.record)!
          : hydroRecordSchema.safeParse(rawJson).data;

        if (envelope.success && envelope.data.error) {
          const msg = envelope.data.error.message ?? envelope.data.error.name ?? 'unknown error';
          throw new JudgeInfrastructureError('upstream_unavailable', `Hydro record error for ${id}: ${msg}`, {
            platform: 'hydro',
          });
        }
        if (!directRecord) {
          throw new JudgeInfrastructureError('upstream_unavailable', `Invalid Hydro record payload for ${id}`, {
            platform: 'hydro',
          });
        }

        const remoteUser = directRecord.uname ?? (envelope.success ? envelope.data.udoc?.uname : undefined);
        if (remoteUser && remoteUser.toLowerCase() !== handle.toLowerCase()) {
          throw new JudgeInfrastructureError('identity_mismatch', `Hydro record ${id} submitter mismatch`, {
            platform: 'hydro',
          });
        }

        const localProblem = problems.get(id);
        const remotePid =
          directRecord.pid !== undefined
            ? String(directRecord.pid)
            : envelope.success && envelope.data.pdoc?.pid !== undefined
              ? String(envelope.data.pdoc.pid)
              : undefined;
        if (localProblem && remotePid && remotePid !== targetFor(localProblem)) {
          throw new JudgeInfrastructureError('identity_mismatch', `Hydro record ${id} problem mismatch`, {
            platform: 'hydro',
          });
        }

        const score = directRecord.score;
        const maxScore = directRecord.maxScore ?? (envelope.success ? envelope.data.pdoc?.maxScore : undefined) ?? 100;
        const mapped = mapHydroStatus(directRecord.status, score, maxScore);

        if (mapped.infraError) {
          throw new JudgeInfrastructureError(
            'upstream_unavailable',
            `Hydro reported ${mapped.raw} for record ${id}`,
            { platform: 'hydro' },
          );
        }

        if (isFinalVerdict(mapped.verdict)) {
          result.set(id, {
            remote_submission_id: id,
            verdict: mapped.verdict,
            raw_verdict: mapped.raw,
            ...(score !== undefined ? { score } : {}),
            ...(score !== undefined ? { max_score: maxScore } : {}),
            ...(directRecord.time !== undefined ? { time_ms: Math.round(directRecord.time) } : {}),
            ...(directRecord.memory !== undefined ? { memory_kb: Math.round(directRecord.memory) } : {}),
            final: true,
          });
        }
      }

      return result;
    },
  };
}
