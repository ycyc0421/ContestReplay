import { setTimeout as delay } from 'node:timers/promises';
import type { OjAccount, OjAccountPool, OjAccounts } from '../oj-accounts.js';
import {
  type ContestPreview,
  type ContestPreviewProblem,
  type ExecFileLike,
  type FetchLike,
  type HtmlNode,
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
  walkHtml,
} from './types.js';

export const QOJ_DEFAULT_ORIGIN = 'https://qoj.ac';
export const QOJ_DEFAULT_SETTLEMENT_MS = 180_000;

export const QOJ_LANGUAGE_PRESETS: LanguagePreset[] = [
  { id: 'cpp20', label: 'C++20', remote_id: 'C++20', family: 'cpp' },
  { id: 'cpp17', label: 'C++17', remote_id: 'C++17', family: 'cpp' },
  { id: 'cpp14', label: 'C++14', remote_id: 'C++14', family: 'cpp' },
  { id: 'python3', label: 'Python3', remote_id: 'Python3', family: 'python' },
  { id: 'pypy3', label: 'PyPy3', remote_id: 'PyPy3', family: 'python' },
  { id: 'rust', label: 'Rust', remote_id: 'Rust', family: 'rust' },
  { id: 'java', label: 'Java', remote_id: 'Java', family: 'java' },
];

export interface QojSubmissionRow {
  id: string;
  problem_id?: string;
  submitter?: string;
  raw_verdict: string;
  score?: number;
  max_score?: number;
  time_ms?: number;
  memory_kb?: number;
}

function classifyHttpError(status: number, context: string): JudgeInfrastructureError {
  if (status === 401 || status === 403) {
    return new JudgeInfrastructureError('auth_expired', `QOJ ${context}: HTTP ${status}`, {
      platform: 'qoj',
      status,
    });
  }
  if (status === 429) {
    return new JudgeInfrastructureError('rate_limited', `QOJ ${context}: HTTP 429 rate limited`, {
      platform: 'qoj',
      status,
    });
  }
  return new JudgeInfrastructureError('upstream_unavailable', `QOJ ${context}: HTTP ${status}`, {
    platform: 'qoj',
    status,
  });
}

function detectCaptchaOrLogin(markup: string): 'captcha' | 'login' | null {
  if (/cf-turnstile|g-recaptcha|h-captcha|verify you are human/i.test(markup)) return 'captcha';
  if (/<form[^>]+action=["'][^"']*\/login/i.test(markup) && !/name=["']_token["'][\s\S]*name=["']answer_answer_code["']/i.test(markup)) {
    return 'login';
  }
  return null;
}

export function extractQojCsrfToken(markup: string): string | undefined {
  const nodes = parseHtmlNodes(markup);
  for (const node of nodes) {
    if (node.tagName === 'input' && htmlAttr(node, 'name') === '_token') {
      const value = htmlAttr(node, 'value')?.trim();
      if (value) return value;
    }
    if (node.tagName === 'meta' && htmlAttr(node, 'name') === 'csrf-token') {
      const value = htmlAttr(node, 'content')?.trim();
      if (value) return value;
    }
  }
  const inlineMatch = markup.match(/_token\s*[:=]\s*["']([A-Za-z0-9+/=_-]{8,})["']/);
  return inlineMatch?.[1];
}

function parseNumberUnit(text: string): number | undefined {
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function parseScoreText(text: string): { score?: number; max_score?: number } {
  const ratio = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (ratio?.[1] && ratio[2]) {
    return { score: Number(ratio[1]), max_score: Number(ratio[2]) };
  }
  const bare = text.trim().match(/^(\d+(?:\.\d+)?)$/);
  if (bare?.[1]) {
    return { score: Number(bare[1]), max_score: 100 };
  }
  return {};
}

/**
 * Parse a QOJ/UOJ submission detail HTML page (`/submission/<id>`) or JSON response.
 */
export function parseQojSubmissionPage(id: string, body: string): QojSubmissionRow {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const rawVerdict = String(parsed.verdict ?? parsed.status ?? parsed.result ?? 'Waiting');
    const score = typeof parsed.score === 'number' ? parsed.score : undefined;
    const maxScore = typeof parsed.max_score === 'number' ? parsed.max_score : undefined;
    const timeMs = typeof parsed.time_ms === 'number' ? parsed.time_ms : typeof parsed.used_time === 'number' ? parsed.used_time : undefined;
    const memoryKb = typeof parsed.memory_kb === 'number' ? parsed.memory_kb : typeof parsed.used_memory === 'number' ? parsed.used_memory : undefined;
    return {
      id: String(parsed.id ?? id),
      ...(parsed.problem_id !== undefined ? { problem_id: String(parsed.problem_id) } : {}),
      ...(typeof parsed.submitter === 'string' ? { submitter: parsed.submitter } : {}),
      raw_verdict: rawVerdict,
      ...(score !== undefined ? { score } : {}),
      ...(maxScore !== undefined ? { max_score: maxScore } : {}),
      ...(timeMs !== undefined ? { time_ms: timeMs } : {}),
      ...(memoryKb !== undefined ? { memory_kb: memoryKb } : {}),
    };
  }

  const nodes = parseHtmlNodes(body);
  // Look for the first data row in a UOJ/QOJ submission table (<tr> with <td>s)
  const trNodes = nodes.filter(n => n.tagName === 'tr');
  let rawVerdict = 'Waiting';
  let score: number | undefined;
  let maxScore: number | undefined;
  let timeMs: number | undefined;
  let memoryKb: number | undefined;
  let problemId: string | undefined;
  let submitter: string | undefined;

  for (const tr of trNodes) {
    const tds = (tr.childNodes ?? []).filter(c => c.tagName === 'td');
    if (tds.length < 4) continue;
    const cells = tds.map(td => htmlText(td).replace(/\s+/g, ' ').trim());
    const idCell = cells[0] ?? '';
    if (!idCell.includes(id) && !idCell.startsWith('#')) continue;

    for (const td of tds) {
      const links = collectAnchors(td);
      for (const link of links) {
        const href = htmlAttr(link, 'href') ?? '';
        const probMatch = href.match(/\/problem\/(\d+)/);
        if (probMatch?.[1] && !problemId) problemId = probMatch[1];
        const userMatch = href.match(/\/user\/profile\/([^/?#]+)/);
        if (userMatch?.[1] && !submitter) submitter = decodeURIComponent(userMatch[1]);
      }
    }

    // Standard UOJ/QOJ table columns: ID | Problem | Submitter | Result/Score | Time | Memory | Language | File Size | Submit Time
    const resultCell = cells[3] ?? '';
    const parsedScore = parseScoreText(resultCell);
    if (parsedScore.score !== undefined) {
      score = parsedScore.score;
      maxScore = parsedScore.max_score;
      // UOJ often renders score number ("65" or "100") as the main text and verdict inside badge/title or test details
      const extraVerdict = body.match(
        /\b(Judgement Failed|Compile Error|Compilation Error|Accepted|Wrong Answer|Time Limit Exceeded|Memory Limit Exceeded|Runtime Error|Dangerous Syscalls|Output Limit Exceeded|Waiting|Judging)\b/i,
      );
      if (extraVerdict?.[1]) {
        rawVerdict = extraVerdict[1];
      } else if (maxScore !== undefined && score >= maxScore) {
        rawVerdict = 'Accepted';
      } else if (score > 0) {
        rawVerdict = 'Partial';
      } else {
        rawVerdict = 'Wrong Answer';
      }
    } else if (resultCell) {
      rawVerdict = resultCell;
    }

    if (cells[4]) {
      const t = parseNumberUnit(cells[4]);
      if (t !== undefined) timeMs = Math.round(t);
    }
    if (cells[5]) {
      const m = parseNumberUnit(cells[5]);
      if (m !== undefined) {
        memoryKb = /mb/i.test(cells[5]) ? Math.round(m * 1024) : Math.round(m);
      }
    }
    break;
  }

  // Fallback: inspect data attributes or status badges if table layout differs
  if (rawVerdict === 'Waiting' && score === undefined) {
    const scoreNode = nodes.find(n => (htmlAttr(n, 'class') ?? '').includes('uoj-score'));
    if (scoreNode) {
      const parsedScore = parseScoreText(htmlText(scoreNode));
      score = parsedScore.score;
      maxScore = parsedScore.max_score;
    }
    const statusMatch = body.match(
      /\b(Judgement Failed|Compile Error|Compilation Error|Accepted|Wrong Answer|Time Limit Exceeded|Memory Limit Exceeded|Runtime Error|Waiting|Judging)\b/i,
    );
    if (statusMatch?.[1]) rawVerdict = statusMatch[1];
  }

  return {
    id,
    ...(problemId ? { problem_id: problemId } : {}),
    ...(submitter ? { submitter } : {}),
    raw_verdict: rawVerdict,
    ...(score !== undefined ? { score } : {}),
    ...(maxScore !== undefined ? { max_score: maxScore } : {}),
    ...(timeMs !== undefined ? { time_ms: timeMs } : {}),
    ...(memoryKb !== undefined ? { memory_kb: memoryKb } : {}),
  };
}

function collectAnchors(node: HtmlNode): HtmlNode[] {
  return walkHtml(node).filter(cur => cur.tagName === 'a');
}

export function parseQojSubmissionList(markup: string): Array<{ id: string; problem_id?: string; submitter?: string }> {
  const nodes = parseHtmlNodes(markup);
  const rows: Array<{ id: string; problem_id?: string; submitter?: string }> = [];
  const seen = new Set<string>();
  for (const tr of nodes) {
    if (tr.tagName !== 'tr') continue;
    const anchors = collectAnchors(tr);
    let subId: string | undefined;
    let problemId: string | undefined;
    let submitter: string | undefined;
    for (const a of anchors) {
      const href = htmlAttr(a, 'href') ?? '';
      const s = href.match(/\/submission\/(\d+)/);
      if (s?.[1] && !subId) subId = s[1];
      const p = href.match(/\/problem\/(\d+)/);
      if (p?.[1] && !problemId) problemId = p[1];
      const u = href.match(/\/user\/profile\/([^/?#]+)/);
      if (u?.[1] && !submitter) submitter = decodeURIComponent(u[1]);
    }
    if (subId && !seen.has(subId)) {
      seen.add(subId);
      rows.push({ id: subId, ...(problemId ? { problem_id: problemId } : {}), ...(submitter ? { submitter } : {}) });
    }
  }
  return rows;
}

export async function previewQojContest(
  contestId: number | string,
  opts?: { baseUrl?: string; fetchImpl?: FetchLike; signal?: AbortSignal },
): Promise<ContestPreview> {
  const cleanId = String(contestId).replace(/^qoj:/i, '').trim();
  if (!/^\d+$/.test(cleanId)) {
    throw new JudgeInfrastructureError('upstream_unavailable', `Invalid QOJ contest ID: ${contestId}`, {
      platform: 'qoj',
    });
  }
  const origin = validateOriginUrl(opts?.baseUrl ?? QOJ_DEFAULT_ORIGIN, 'qoj');
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(opts?.signal ? [opts.signal] : [])]);

  let response: Response;
  try {
    response = await fetchImpl(`${origin}/contest/${cleanId}`, { redirect: 'follow', signal });
  } catch (cause) {
    if (opts?.signal?.aborted) throw cause;
    throw new JudgeInfrastructureError('upstream_unavailable', 'QOJ contest preview request failed', {
      platform: 'qoj',
      cause,
    });
  }
  if (!response.ok) throw classifyHttpError(response.status, 'contest preview');
  const html = await response.text();
  const nodes = parseHtmlNodes(html);

  // Title from <h1> or <title>
  const h1 = nodes.find(n => n.tagName === 'h1');
  const titleNode = nodes.find(n => n.tagName === 'title');
  const title = (h1 ? htmlText(h1) : titleNode ? htmlText(titleNode) : `QOJ Contest ${cleanId}`)
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*QOJ.*$/i, '')
    .trim();

  // Extract problems from links matching /contest/<id>/problem/<pid> or /problem/<pid>
  const problems: ContestPreviewProblem[] = [];
  const seen = new Set<string>();
  let statementPdfUrl: string | undefined;

  for (const node of nodes) {
    if (node.tagName !== 'a') continue;
    const href = htmlAttr(node, 'href') ?? '';
    const linkText = htmlText(node).replace(/\s+/g, ' ').trim();

    if (!statementPdfUrl && (/\.pdf($|\?)/i.test(href) || /download.*statement|statements?\.pdf/i.test(href))) {
      try {
        statementPdfUrl = new URL(href, origin).href;
      } catch {
        // ignore malformed href
      }
    }

    const probMatch = href.match(new RegExp(`(?:/contest/${cleanId})?/problem/(\\d+)(?:$|[/?#])`));
    if (probMatch?.[1] && !seen.has(probMatch[1])) {
      seen.add(probMatch[1]);
      // Try to clean leading "#1234." or "A." from problem title
      const cleanTitle = linkText.replace(/^#?\d+\.\s*/, '').trim();
      problems.push({
        remote_id: probMatch[1],
        ...(cleanTitle ? { title: cleanTitle } : {}),
      });
    }
  }

  const status: ContestPreview['status'] = /ended|finished|已结束/i.test(html)
    ? 'finished'
    : /running|in progress|进行中/i.test(html)
      ? 'active'
      : 'unknown';

  return {
    platform: 'qoj',
    contest_ref: `qoj:${cleanId}`,
    title: title || `QOJ Contest ${cleanId}`,
    status,
    problems,
    suggested_languages: QOJ_LANGUAGE_PRESETS,
    ...(statementPdfUrl ? { statement_pdf_url: statementPdfUrl } : {}),
  };
}

export interface QojJudgeConfig {
  contest_id?: number | string;
  handle: string;
  languages: Record<string, string>;
  problem_map?: Record<string, string>;
  account_id?: string;
  base_url?: string;
  settlement_ms?: number;
}

export interface QojJudgeDeps {
  accounts?: OjAccounts;
  pool?: OjAccountPool;
  account?: OjAccount;
  cookie?: string;
  executable?: string;
  fetchImpl?: FetchLike;
  execImpl?: ExecFileLike;
  delayImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function createQojJudge(config: QojJudgeConfig, deps: QojJudgeDeps = {}): ProgramJudge {
  const origin = validateOriginUrl(config.base_url ?? QOJ_DEFAULT_ORIGIN, 'qoj');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delayImpl = deps.delayImpl ?? ((ms, sig) => delay(ms, undefined, { signal: sig }));
  const settlementMs = config.settlement_ms ?? QOJ_DEFAULT_SETTLEMENT_MS;

  const targetFor = (problem: string) =>
    Object.hasOwn(config.problem_map ?? {}, problem) ? config.problem_map![problem]! : problem;

  const problemUrlFor = (remoteProblemId: string) =>
    config.contest_id !== undefined
      ? `${origin}/contest/${config.contest_id}/problem/${remoteProblemId}`
      : `${origin}/problem/${remoteProblemId}`;

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
      if (account.platform !== 'qoj') {
        throw new JudgeInfrastructureError('auth_expired', `OJ account ${account.id} is not a QOJ account`, {
          platform: 'qoj',
        });
      }
      if (account.transport === 'submitter') {
        if (!account.executable_path) {
          throw new JudgeInfrastructureError('submitter_failed', 'QOJ submitter account has no executable_path', {
            platform: 'qoj',
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
    const envExec = process.env.CR_QOJ_SUBMITTER?.trim();
    if (envExec) {
      return { mode: 'submitter', executable: envExec, handle: config.handle, accountId: config.account_id };
    }
    const envCookie = process.env.CR_QOJ_COOKIE?.trim();
    if (envCookie) {
      return { mode: 'cookie', cookie: envCookie, handle: config.handle, accountId: config.account_id };
    }
    throw new JudgeInfrastructureError('auth_expired', 'No QOJ OJ account, cookie, or submitter configured', {
      platform: 'qoj',
    });
  }

  async function fetchRecentSubmissions(
    handle: string,
    remoteProblemId: string,
    session: Map<string, string>,
    signal: AbortSignal,
  ) {
    const url = new URL(`${origin}/submissions`);
    url.searchParams.set('submitter', handle);
    url.searchParams.set('problem_id', remoteProblemId);
    const resp = await fetchImpl(url, {
      headers: { cookie: serializeCookieHeader(session) },
      redirect: 'manual',
      signal,
    });
    if (!resp.ok) throw classifyHttpError(resp.status, 'submissions list');
    return parseQojSubmissionList(await resp.text());
  }

  async function submitViaCookie(
    remoteProblemId: string,
    remoteLang: string,
    source: string,
    handle: string,
    cookie: string,
    signal: AbortSignal,
  ): Promise<string> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const session = parseCookieHeader(cookie, 'qoj');
    const cookieHeader = () => ({ cookie: serializeCookieHeader(session) });
    const submitPageUrl = problemUrlFor(remoteProblemId);

    let pageResp: Response;
    try {
      pageResp = await fetchImpl(submitPageUrl, { headers: cookieHeader(), redirect: 'manual', signal: requestSignal });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new JudgeInfrastructureError('upstream_unavailable', 'QOJ submit page fetch failed', {
        platform: 'qoj',
        cause,
      });
    }
    if (pageResp.status >= 300 && pageResp.status < 400) {
      throw new JudgeInfrastructureError('auth_expired', 'QOJ redirected away from problem page (login required)', {
        platform: 'qoj',
        status: pageResp.status,
      });
    }
    if (!pageResp.ok) throw classifyHttpError(pageResp.status, 'problem page');
    mergeSetCookies(session, pageResp.headers);

    const pageHtml = await pageResp.text();
    const challenge = detectCaptchaOrLogin(pageHtml);
    if (challenge === 'captcha') {
      throw new JudgeInfrastructureError('captcha_required', 'QOJ returned a captcha challenge', { platform: 'qoj' });
    }
    if (challenge === 'login') {
      throw new JudgeInfrastructureError('auth_expired', 'QOJ session expired (login form shown)', { platform: 'qoj' });
    }

    const token = extractQojCsrfToken(pageHtml);
    if (!token) {
      throw new JudgeInfrastructureError('auth_expired', 'QOJ submit page missing _token CSRF field', {
        platform: 'qoj',
      });
    }

    // Record baseline submission ID before posting so correlation is exact.
    const before = await fetchRecentSubmissions(handle, remoteProblemId, session, requestSignal).catch(() => []);
    const baseline = Math.max(0, ...before.map(r => Number(r.id)).filter(Number.isFinite));

    const form = new URLSearchParams();
    form.set('_token', token);
    form.set('answer_answer_language', remoteLang);
    form.set('answer_answer_upload_type', 'editor');
    form.set('answer_answer_editor', source);
    form.set('submit-answer', 'answer');

    let postResp: Response;
    try {
      postResp = await fetchImpl(submitPageUrl, {
        method: 'POST',
        headers: {
          ...cookieHeader(),
          origin,
          referer: submitPageUrl,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
        redirect: 'manual',
        signal: requestSignal,
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new JudgeInfrastructureError('submission_unconfirmed', 'QOJ submit POST failed; will not retry', {
        platform: 'qoj',
        cause,
      });
    }

    // 1. Check redirect to /submission/<id>
    const location = postResp.headers.get('location');
    if (location && postResp.status >= 300 && postResp.status < 400) {
      const targetUrl = new URL(location, origin);
      if (targetUrl.origin === origin) {
        const directMatch = targetUrl.pathname.match(/^\/submission\/(\d+)\/?$/);
        if (directMatch?.[1]) {
          await postResp.body?.cancel();
          return directMatch[1];
        }
        if (/^\/submissions\/?$/.test(targetUrl.pathname) || /^\/contest\/\d+\/submissions\/?$/.test(targetUrl.pathname)) {
          await postResp.body?.cancel();
          return correlateQojSubmission(handle, remoteProblemId, baseline, session, requestSignal);
        }
      }
      await postResp.body?.cancel();
      throw new JudgeInfrastructureError('auth_expired', `Unexpected QOJ submit redirect: ${location}`, {
        platform: 'qoj',
        status: postResp.status,
      });
    }

    if (postResp.status === 401 || postResp.status === 403 || postResp.status === 429) {
      await postResp.body?.cancel();
      throw classifyHttpError(postResp.status, 'submit POST');
    }

    const bodyText = await postResp.text();
    const contentType = postResp.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') || bodyText.trim().startsWith('{')) {
      try {
        const json = JSON.parse(bodyText) as { submission_id?: string | number; id?: string | number; error?: string };
        const idVal = json.submission_id ?? json.id;
        if (idVal !== undefined && String(idVal).trim()) return String(idVal);
        if (json.error) {
          throw new JudgeInfrastructureError('submission_unconfirmed', `QOJ rejected submission: ${json.error}`, {
            platform: 'qoj',
          });
        }
      } catch (err) {
        if (err instanceof JudgeInfrastructureError) throw err;
      }
    }

    const bodySubMatch = bodyText.match(/\/submission\/(\d+)/);
    if (postResp.ok && bodySubMatch?.[1]) {
      return bodySubMatch[1];
    }

    if (postResp.ok) {
      return correlateQojSubmission(handle, remoteProblemId, baseline, session, requestSignal);
    }

    throw new JudgeInfrastructureError(
      'submission_unconfirmed',
      `QOJ did not confirm submission (HTTP ${postResp.status}); will not retry`,
      { platform: 'qoj', status: postResp.status },
    );
  }

  async function correlateQojSubmission(
    handle: string,
    remoteProblemId: string,
    baseline: number,
    session: Map<string, string>,
    signal: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await delayImpl(1500, signal);
      const rows = await fetchRecentSubmissions(handle, remoteProblemId, session, signal);
      const newer = rows.filter(r => Number(r.id) > baseline);
      const exact = newer.filter(
        r =>
          (!r.problem_id || r.problem_id === remoteProblemId) &&
          (!r.submitter || r.submitter.toLowerCase() === handle.toLowerCase()),
      );
      if (exact.length === 1 && newer.length === 1) return exact[0]!.id;
      if (newer.length > 0) {
        throw new JudgeInfrastructureError(
          'identity_mismatch',
          'Ambiguous QOJ submission correlation: the account must be dedicated to this run',
          { platform: 'qoj' },
        );
      }
    }
    throw new JudgeInfrastructureError('submission_unconfirmed', 'Could not confirm QOJ submission ID', {
      platform: 'qoj',
    });
  }

  return {
    kind: 'qoj',
    settlementMs,

    async submit(problem, language, source, signal) {
      const remoteLang = config.languages[language];
      if (!remoteLang) {
        throw new Error(`Unsupported QOJ language key: ${language}`);
      }
      const remoteProblemId = targetFor(problem);
      const transport = await resolveTransport();
      const execute = async () => {
        if (transport.mode === 'submitter') {
          return runExternalSubmitter({
            platform: 'qoj',
            executable: transport.executable,
            args: [
              ...(config.contest_id !== undefined ? [String(config.contest_id)] : ['none']),
              remoteProblemId,
              remoteLang,
              '__SOURCE_FILE__',
              transport.handle,
            ],
            source,
            env: {
              CR_OJ_PLATFORM: 'qoj',
              CR_QOJ_BASE_URL: origin,
              CR_QOJ_CONTEST_ID: config.contest_id !== undefined ? String(config.contest_id) : '',
              CR_QOJ_PROBLEM: remoteProblemId,
              CR_QOJ_LANGUAGE: remoteLang,
              CR_QOJ_HANDLE: transport.handle,
            },
            signal,
            execImpl: deps.execImpl,
          });
        }
        return submitViaCookie(remoteProblemId, remoteLang, source, transport.handle, transport.cookie, signal);
      };

      const serializationKey = transport.accountId ?? `qoj:${transport.handle.toLowerCase()}`;
      if (deps.pool) {
        return deps.pool.enqueueSubmission(serializationKey, execute, signal);
      }
      return execute();
    },

    async verdicts(ids, problems, signal) {
      if (!ids.length) return new Map();
      const transport = await resolveTransport().catch(() => undefined);
      const headers: Record<string, string> = {};
      if (transport?.mode === 'cookie') {
        headers.cookie = serializeCookieHeader(parseCookieHeader(transport.cookie, 'qoj'));
      }
      const handle = transport?.handle ?? config.handle;
      const result = new Map<string, JudgeVerdict>();

      for (const id of ids) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        let resp: Response;
        try {
          resp = await fetchImpl(`${origin}/submission/${encodeURIComponent(id)}`, {
            headers,
            redirect: 'manual',
            signal: requestSignal,
          });
        } catch (cause) {
          if (signal.aborted) throw cause;
          throw new JudgeInfrastructureError('upstream_unavailable', `QOJ verdict fetch failed for #${id}`, {
            platform: 'qoj',
            cause,
          });
        }
        if (resp.status >= 300 && resp.status < 400) {
          throw new JudgeInfrastructureError('auth_expired', `QOJ redirected while polling submission #${id}`, {
            platform: 'qoj',
            status: resp.status,
          });
        }
        if (!resp.ok) throw classifyHttpError(resp.status, `submission #${id}`);

        const body = await resp.text();
        const row = parseQojSubmissionPage(id, body);
        const expectedProblem = problems.get(id) ? targetFor(problems.get(id)!) : undefined;
        if (expectedProblem && row.problem_id && row.problem_id !== expectedProblem) {
          throw new JudgeInfrastructureError('identity_mismatch', `QOJ submission #${id} problem mismatch`, {
            platform: 'qoj',
          });
        }
        if (row.submitter && row.submitter.toLowerCase() !== handle.toLowerCase()) {
          throw new JudgeInfrastructureError('identity_mismatch', `QOJ submission #${id} submitter mismatch`, {
            platform: 'qoj',
          });
        }

        const normalized = normalizeVerdict(row.raw_verdict, row.score, row.max_score);
        if (normalized === 'judge_error') {
          throw new JudgeInfrastructureError(
            'upstream_unavailable',
            `QOJ reported Judgement Failed (${row.raw_verdict}) for submission #${id}`,
            { platform: 'qoj' },
          );
        }

        if (isFinalVerdict(normalized)) {
          result.set(id, {
            remote_submission_id: id,
            verdict: normalized,
            raw_verdict: row.raw_verdict,
            ...(row.score !== undefined ? { score: row.score } : {}),
            ...(row.max_score !== undefined ? { max_score: row.max_score } : {}),
            ...(row.time_ms !== undefined ? { time_ms: row.time_ms } : {}),
            ...(row.memory_kb !== undefined ? { memory_kb: row.memory_kb } : {}),
            final: true,
          });
        }
      }

      return result;
    },
  };
}
