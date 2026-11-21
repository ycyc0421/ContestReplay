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
  resolveAdapterTransport,
  resolveBaseUrl,
  runExternalSubmitter,
  safeParseJson,
  serializeAccountSubmission,
  serializeCookieHeader,
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

function stripQojPrefix(raw: number | string): string {
  return String(raw).replace(/^qoj:/i, '').trim();
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
  const nodes = parseHtmlNodes(markup);
  const hasSubmitForm = nodes.some(
    n => n.tagName === 'form' && walkHtml(n).some(c => htmlAttr(c, 'name') === 'answer_answer_editor'),
  );
  if (hasSubmitForm) return null;
  const hasLoginForm = nodes.some(n => n.tagName === 'form' && /\/login\b/i.test(htmlAttr(n, 'action') ?? ''));
  return hasLoginForm ? 'login' : null;
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

function parseScoreText(text: string): { score?: number; max_score?: number; explicitRatio: boolean } {
  const ratio = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (ratio?.[1] && ratio[2]) {
    return { score: Number(ratio[1]), max_score: Number(ratio[2]), explicitRatio: true };
  }
  const bare = text.trim().match(/^(\d+(?:\.\d+)?)$/);
  if (bare?.[1]) {
    // Do NOT fabricate max_score = 100 for bare numeric scores (IOI tasks can have != 100 max points).
    return { score: Number(bare[1]), explicitRatio: false };
  }
  return { explicitRatio: false };
}

function collectAnchors(node: HtmlNode): HtmlNode[] {
  return walkHtml(node).filter(cur => cur.tagName === 'a');
}

function extractExactSubmissionIdFromCell(td: HtmlNode): string | undefined {
  for (const a of collectAnchors(td)) {
    const href = htmlAttr(a, 'href') ?? '';
    const m = href.match(/\/submission\/(\d+)(?:$|[/?#])/);
    if (m?.[1]) return m[1];
  }
  const txt = htmlText(td).trim();
  const bare = txt.match(/^#?(\d+)$/);
  return bare?.[1];
}

/**
 * Parse a QOJ/UOJ submission detail HTML page (`/submission/<id>`) or JSON response.
 * Strictly reads ONLY the summary table row whose submission ID matches `expectedId`
 * (never scans test case detail rows or user `<pre><code>` source blocks).
 */
export function parseQojSubmissionPage(expectedId: string, body: string): QojSubmissionRow | undefined {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const parsed = safeParseJson(trimmed, 'qoj', 'submission status') as Record<string, unknown>;
    const rawId = parsed.id ?? parsed.submission_id;
    if (rawId === undefined || rawId === null || String(rawId).trim() === '') return undefined;
    const rawVerdict = String(parsed.verdict ?? parsed.status ?? parsed.result ?? 'Waiting');
    const score = typeof parsed.score === 'number' ? parsed.score : undefined;
    const maxScore = typeof parsed.max_score === 'number' ? parsed.max_score : undefined;
    const timeMs =
      typeof parsed.time_ms === 'number'
        ? parsed.time_ms
        : typeof parsed.used_time === 'number'
          ? parsed.used_time
          : undefined;
    const memoryKb =
      typeof parsed.memory_kb === 'number'
        ? parsed.memory_kb
        : typeof parsed.used_memory === 'number'
          ? parsed.used_memory
          : undefined;
    return {
      id: String(rawId),
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
  const trNodes = nodes.filter(n => n.tagName === 'tr');

  for (const tr of trNodes) {
    const tds = (tr.childNodes ?? []).filter(c => c.tagName === 'td');
    if (tds.length < 4) continue;
    const rowId = extractExactSubmissionIdFromCell(tds[0]!);
    if (!rowId) continue;
    if (rowId !== expectedId) {
      // If the page returned a summary row for a different submission ID, surface that ID so
      // verdicts() fails closed with identity_mismatch instead of silently treating it as expectedId.
      return {
        id: rowId,
        raw_verdict: 'IdentityMismatch',
      };
    }

    const cells = tds.map(td => htmlText(td).replace(/\s+/g, ' ').trim());
    let problemId: string | undefined;
    let submitter: string | undefined;

    for (const td of tds) {
      for (const link of collectAnchors(td)) {
        const href = htmlAttr(link, 'href') ?? '';
        const probMatch = href.match(/\/problem\/(\d+)(?:$|[/?#])/);
        if (probMatch?.[1] && !problemId) problemId = probMatch[1];
        const userMatch = href.match(/\/user\/profile\/([^/?#]+)/);
        if (userMatch?.[1] && !submitter) submitter = decodeURIComponent(userMatch[1]);
      }
    }

    // Standard UOJ/QOJ summary row: ID | Problem | Submitter | Result/Score | Time | Memory | ...
    const resultTd = tds[3]!;
    const resultCell = cells[3] ?? '';
    const scoreNode = walkHtml(resultTd).find(n => (htmlAttr(n, 'class') ?? '').includes('uoj-score'));
    const scoreSource = scoreNode ? htmlText(scoreNode).trim() : resultCell;
    const parsedScore = parseScoreText(scoreSource);

    let score: number | undefined;
    let maxScore: number | undefined;
    let rawVerdict = 'Waiting';

    // Check explicit text verdict ONLY inside the summary result cell (never full HTML / source code!)
    const cellVerdictMatch = resultCell.match(
      /\b(Judgement Failed|Judgment Failed|Compile Error|Compilation Error|Accepted|Wrong Answer|Time Limit Exceeded|Memory Limit Exceeded|Runtime Error|Dangerous Syscalls|Output Limit Exceeded|Waiting|Judging|Pending|Compiling)\b/i,
    );

    if (parsedScore.score !== undefined) {
      score = parsedScore.score;
      maxScore = parsedScore.max_score;
      if (cellVerdictMatch?.[1]) {
        rawVerdict = cellVerdictMatch[1];
      } else if (maxScore !== undefined && score >= maxScore) {
        rawVerdict = 'Accepted';
      } else if (score > 0) {
        rawVerdict = 'Partial';
      } else {
        rawVerdict = 'Wrong Answer';
      }
    } else if (cellVerdictMatch?.[1]) {
      rawVerdict = cellVerdictMatch[1];
    } else if (resultCell) {
      rawVerdict = resultCell;
    }

    let timeMs: number | undefined;
    let memoryKb: number | undefined;
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

    return {
      id: rowId,
      ...(problemId ? { problem_id: problemId } : {}),
      ...(submitter ? { submitter } : {}),
      raw_verdict: rawVerdict,
      ...(score !== undefined ? { score } : {}),
      ...(maxScore !== undefined ? { max_score: maxScore } : {}),
      ...(timeMs !== undefined ? { time_ms: timeMs } : {}),
      ...(memoryKb !== undefined ? { memory_kb: memoryKb } : {}),
    };
  }

  return undefined;
}

export interface QojSubmissionListResult {
  recognized: boolean;
  rows: Array<{ id: string; problem_id?: string; submitter?: string }>;
}

/**
 * Parse a QOJ/UOJ `/submissions` HTML page and verify that it actually contains
 * a recognizable submissions table structure (prevents misinterpreting HTTP 200
 * maintenance/error pages as an empty submission list with baseline 0).
 */
export function parseQojSubmissionListPage(markup: string): QojSubmissionListResult {
  const nodes = parseHtmlNodes(markup);
  const rows: Array<{ id: string; problem_id?: string; submitter?: string }> = [];
  const seen = new Set<string>();
  let recognizedTable = false;

  for (const table of nodes) {
    if (table.tagName !== 'table') continue;
    const tableNodes = walkHtml(table);
    const headerText = tableNodes
      .filter(n => n.tagName === 'th')
      .map(n => htmlText(n).trim().toLowerCase())
      .join(' ');
    const tableClass = (htmlAttr(table, 'class') ?? '').toLowerCase();
    const hasSubmissionHeaders =
      (headerText.includes('id') || headerText.includes('#')) &&
      (headerText.includes('problem') ||
        headerText.includes('submitter') ||
        headerText.includes('result') ||
        headerText.includes('score') ||
        headerText.includes('题目') ||
        headerText.includes('提交'));
    if (hasSubmissionHeaders || tableClass.includes('submissions')) {
      recognizedTable = true;
    }

    for (const tr of tableNodes) {
      if (tr.tagName !== 'tr') continue;
      const anchors = collectAnchors(tr);
      let subId: string | undefined;
      let problemId: string | undefined;
      let submitter: string | undefined;
      for (const a of anchors) {
        const href = htmlAttr(a, 'href') ?? '';
        const s = href.match(/\/submission\/(\d+)(?:$|[/?#])/);
        if (s?.[1] && !subId) subId = s[1];
        const p = href.match(/\/problem\/(\d+)(?:$|[/?#])/);
        if (p?.[1] && !problemId) problemId = p[1];
        const u = href.match(/\/user\/profile\/([^/?#]+)/);
        if (u?.[1] && !submitter) submitter = decodeURIComponent(u[1]);
      }
      if (subId && !seen.has(subId)) {
        seen.add(subId);
        recognizedTable = true;
        rows.push({ id: subId, ...(problemId ? { problem_id: problemId } : {}), ...(submitter ? { submitter } : {}) });
      }
    }
  }

  return { recognized: recognizedTable, rows };
}

export function parseQojSubmissionList(markup: string): Array<{ id: string; problem_id?: string; submitter?: string }> {
  return parseQojSubmissionListPage(markup).rows;
}

async function fetchSameOriginManual(
  url: string,
  origin: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<Response> {
  let current = url;
  for (let hops = 0; hops < 3; hops++) {
    let response: Response;
    try {
      response = await fetchImpl(current, { headers, redirect: 'manual', signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JudgeInfrastructureError('upstream_unavailable', 'QOJ HTTP request failed', { platform: 'qoj' });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new JudgeInfrastructureError('upstream_unavailable', 'QOJ redirect missing location header', {
          platform: 'qoj',
          status: response.status,
        });
      }
      const next = new URL(location, current);
      if (next.origin !== origin) {
        throw new JudgeInfrastructureError('upstream_unavailable', 'QOJ redirected across origins', {
          platform: 'qoj',
          status: response.status,
        });
      }
      if (/\/login\b/i.test(next.pathname)) {
        throw new JudgeInfrastructureError('auth_expired', 'QOJ redirected to login page', {
          platform: 'qoj',
          status: response.status,
        });
      }
      current = next.href;
      continue;
    }
    return response;
  }
  throw new JudgeInfrastructureError('upstream_unavailable', 'QOJ exceeded redirect limit', { platform: 'qoj' });
}

export async function previewQojContest(
  contestId: number | string,
  opts?: { baseUrl?: string; fetchImpl?: FetchLike; signal?: AbortSignal },
): Promise<ContestPreview> {
  const cleanId = stripQojPrefix(contestId);
  if (!/^\d+$/.test(cleanId)) {
    throw new JudgeInfrastructureError('upstream_unavailable', 'Invalid QOJ contest ID', {
      platform: 'qoj',
    });
  }
  const { baseUrl, origin } = resolveBaseUrl(opts?.baseUrl ?? QOJ_DEFAULT_ORIGIN, 'qoj');
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(opts?.signal ? [opts.signal] : [])]);

  const contestUrl = `${baseUrl}/contest/${encodeURIComponent(cleanId)}`;
  const response = await fetchSameOriginManual(contestUrl, origin, fetchImpl, signal);
  if (!response.ok) throw classifyHttpError(response.status, 'contest preview');
  const html = await response.text();
  const nodes = parseHtmlNodes(html);

  const h1 = nodes.find(n => n.tagName === 'h1');
  const titleNode = nodes.find(n => n.tagName === 'title');
  const title = (h1 ? htmlText(h1) : titleNode ? htmlText(titleNode) : `QOJ Contest ${cleanId}`)
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*QOJ.*$/i, '')
    .trim();

  const contestScopedProblems: ContestPreviewProblem[] = [];
  const seenScoped = new Set<string>();
  let statementPdfUrl: string | undefined;

  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contestProblemRegex = new RegExp(`^${escapedBase}/contest/${cleanId}/problem/(\\d+)/?$`);

  for (const node of nodes) {
    if (node.tagName !== 'a') continue;
    const href = htmlAttr(node, 'href') ?? '';
    if (!href) continue;
    const linkText = htmlText(node).replace(/\s+/g, ' ').trim();

    let resolved: URL;
    try {
      resolved = new URL(href, contestUrl);
    } catch {
      continue;
    }
    if (resolved.origin !== origin) continue;

    if (!statementPdfUrl && (/\.pdf($|\?)/i.test(resolved.pathname) || /download.*statement|statements?\.pdf/i.test(resolved.pathname))) {
      if (resolved.protocol === 'https:' || resolved.protocol === 'http:') {
        statementPdfUrl = resolved.href;
      }
    }

    // Strictly match same-origin problems scoped to this contest (`<basePath>/contest/<id>/problem/<pid>`)
    const scopedMatch = resolved.pathname.match(contestProblemRegex);
    const pid = scopedMatch?.[1];
    if (pid && !seenScoped.has(pid)) {
      seenScoped.add(pid);
      const cleanTitle = linkText.replace(/^#?\d+\.\s*/, '').trim();
      contestScopedProblems.push({
        remote_id: pid,
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
    problems: contestScopedProblems,
    suggested_languages: QOJ_LANGUAGE_PRESETS,
    ...(statementPdfUrl ? { statement_pdf_url: statementPdfUrl } : {}),
  };
}

export interface QojJudgeConfig {
  contest_id?: number | string;
  handle?: string;
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
  const { baseUrl, origin } = resolveBaseUrl(config.base_url ?? QOJ_DEFAULT_ORIGIN, 'qoj');
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delayImpl = deps.delayImpl ?? ((ms, sig) => delay(ms, undefined, { signal: sig }));
  const settlementMs = config.settlement_ms ?? QOJ_DEFAULT_SETTLEMENT_MS;
  const normalizedContestId = config.contest_id !== undefined ? stripQojPrefix(config.contest_id) : undefined;

  const targetFor = (problem: string) =>
    stripQojPrefix(Object.hasOwn(config.problem_map ?? {}, problem) ? config.problem_map![problem]! : problem);

  const problemUrlFor = (remoteProblemId: string) =>
    normalizedContestId
      ? `${baseUrl}/contest/${encodeURIComponent(normalizedContestId)}/problem/${encodeURIComponent(remoteProblemId)}`
      : `${baseUrl}/problem/${encodeURIComponent(remoteProblemId)}`;

  function resolveTransport() {
    return resolveAdapterTransport({
      platform: 'qoj',
      baseUrl,
      origin,
      configHandle: config.handle,
      configAccountId: config.account_id,
      deps,
    });
  }

  async function fetchRecentSubmissions(
    handle: string,
    remoteProblemId: string,
    session: Map<string, string>,
    signal: AbortSignal,
  ): Promise<QojSubmissionListResult> {
    const url = new URL(`${baseUrl}/submissions`);
    url.searchParams.set('submitter', handle);
    url.searchParams.set('problem_id', remoteProblemId);
    const resp = await fetchImpl(url, {
      headers: { cookie: serializeCookieHeader(session) },
      redirect: 'manual',
      signal,
    });
    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel();
      throw new JudgeInfrastructureError('auth_expired', 'QOJ redirected submissions list request', {
        platform: 'qoj',
        status: resp.status,
      });
    }
    if (!resp.ok) {
      await resp.body?.cancel();
      throw classifyHttpError(resp.status, 'submissions list');
    }
    const listHtml = await resp.text();
    const challenge = detectCaptchaOrLogin(listHtml);
    if (challenge === 'captcha') {
      throw new JudgeInfrastructureError('captcha_required', 'QOJ submissions list returned captcha challenge', {
        platform: 'qoj',
      });
    }
    if (challenge === 'login') {
      throw new JudgeInfrastructureError('auth_expired', 'QOJ submissions list returned login page', {
        platform: 'qoj',
      });
    }
    return parseQojSubmissionListPage(listHtml);
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
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JudgeInfrastructureError('upstream_unavailable', 'QOJ submit page fetch failed', {
        platform: 'qoj',
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

    // Record baseline submission ID before posting.
    // ONLY mark baselineKnown=true if the response actually rendered a recognized QOJ submissions table!
    let baselineKnown = false;
    let baseline = 0;
    try {
      const before = await fetchRecentSubmissions(handle, remoteProblemId, session, requestSignal);
      if (before.recognized) {
        baseline = Math.max(0, ...before.rows.map(r => Number(r.id)).filter(Number.isFinite));
        baselineKnown = true;
      }
    } catch {
      baselineKnown = false;
    }

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
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JudgeInfrastructureError('submission_unconfirmed', 'QOJ submit POST failed; will not retry', {
        platform: 'qoj',
      });
    }

    // 1. Check redirect receipt
    const location = postResp.headers.get('location');
    if (location && postResp.status >= 300 && postResp.status < 400) {
      let targetUrl: URL;
      try {
        targetUrl = new URL(location, submitPageUrl);
      } catch {
        await postResp.body?.cancel();
        throw new JudgeInfrastructureError('submission_unconfirmed', 'QOJ returned invalid redirect after submit POST', {
          platform: 'qoj',
          status: postResp.status,
        });
      }
      const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (targetUrl.origin === origin) {
        const directMatch = targetUrl.pathname.match(new RegExp(`^${escapedBase}/submission/(\\d+)/?$`));
        if (directMatch?.[1]) {
          await postResp.body?.cancel();
          return directMatch[1];
        }
        if (
          new RegExp(`^${escapedBase}/submissions/?$`).test(targetUrl.pathname) ||
          new RegExp(`^${escapedBase}/contest/\\d+/submissions/?$`).test(targetUrl.pathname)
        ) {
          await postResp.body?.cancel();
          if (!baselineKnown) {
            throw new JudgeInfrastructureError(
              'submission_unconfirmed',
              'QOJ redirected to submissions list without a verified pre-submit baseline; will not guess or retry',
              { platform: 'qoj' },
            );
          }
          return correlateQojSubmission(handle, remoteProblemId, baseline, session, requestSignal);
        }
      }
      await postResp.body?.cancel();
      throw new JudgeInfrastructureError('submission_unconfirmed', 'Unexpected QOJ submit redirect; will not retry', {
        platform: 'qoj',
        status: postResp.status,
      });
    }

    if (postResp.status === 401 || postResp.status === 403 || postResp.status === 429) {
      await postResp.body?.cancel();
      throw classifyHttpError(postResp.status, 'submit POST');
    }

    if (!postResp.ok) {
      await postResp.body?.cancel();
      throw new JudgeInfrastructureError(
        'submission_unconfirmed',
        `QOJ submit POST returned HTTP ${postResp.status}; will not retry`,
        { platform: 'qoj', status: postResp.status },
      );
    }

    let bodyText: string;
    try {
      bodyText = await postResp.text();
    } catch {
      throw new JudgeInfrastructureError('submission_unconfirmed', 'QOJ response stream interrupted after submit POST', {
        platform: 'qoj',
        status: postResp.status,
      });
    }
    const contentType = postResp.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') || bodyText.trim().startsWith('{')) {
      const json = safeParseJson(bodyText, 'qoj', 'submit response', 'submission_unconfirmed') as {
        submission_id?: string | number;
        id?: string | number;
        error?: string;
      };
      const idVal = json.submission_id ?? json.id;
      if (idVal !== undefined && String(idVal).trim()) return String(idVal);
      if (json.error) {
        throw new JudgeInfrastructureError('submission_unconfirmed', 'QOJ rejected submission', {
          platform: 'qoj',
        });
      }
    }

    // Do NOT scrape arbitrary /submission/\d+ links from HTML body; require verified baseline correlation.
    if (baselineKnown) {
      return correlateQojSubmission(handle, remoteProblemId, baseline, session, requestSignal);
    }

    throw new JudgeInfrastructureError(
      'submission_unconfirmed',
      'QOJ did not return an explicit submission receipt and baseline was unavailable; will not retry',
      { platform: 'qoj' },
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
      let list: QojSubmissionListResult;
      try {
        list = await fetchRecentSubmissions(handle, remoteProblemId, session, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        throw new JudgeInfrastructureError(
          'submission_unconfirmed',
          'Failed to query QOJ submissions list after POST; will not retry',
          { platform: 'qoj' },
        );
      }
      if (!list.recognized) continue;
      const newer = list.rows.filter(r => Number(r.id) > baseline);
      const exact = newer.filter(
        r =>
          r.problem_id === remoteProblemId &&
          r.submitter !== undefined &&
          r.submitter.toLowerCase() === handle.toLowerCase(),
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
            executable: transport.executable!,
            args: [
              normalizedContestId ?? 'none',
              remoteProblemId,
              remoteLang,
              '__SOURCE_FILE__',
              transport.handle,
            ],
            source,
            env: {
              CR_OJ_PLATFORM: 'qoj',
              CR_QOJ_BASE_URL: baseUrl,
              CR_QOJ_CONTEST_ID: normalizedContestId ?? '',
              CR_QOJ_PROBLEM: remoteProblemId,
              CR_QOJ_LANGUAGE: remoteLang,
              CR_QOJ_HANDLE: transport.handle,
            },
            signal,
            execImpl: deps.execImpl,
          });
        }
        return submitViaCookie(remoteProblemId, remoteLang, source, transport.handle, transport.cookie!, signal);
      };

      return serializeAccountSubmission(transport.queueKey, execute, signal, deps.pool);
    },

    async verdicts(ids, problems, signal) {
      if (!ids.length) return new Map();
      for (const id of ids) {
        if (!problems.has(id)) {
          throw new JudgeInfrastructureError('identity_mismatch', `Missing expected problem mapping for QOJ submission #${id}`, {
            platform: 'qoj',
          });
        }
      }
      const transport = await resolveTransport();
      const headers: Record<string, string> = {};
      if (transport.mode === 'cookie') {
        headers.cookie = serializeCookieHeader(parseCookieHeader(transport.cookie!, 'qoj'));
      }
      const handle = transport.handle;
      const result = new Map<string, JudgeVerdict>();

      for (const id of ids) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        let resp: Response;
        try {
          resp = await fetchImpl(`${baseUrl}/submission/${encodeURIComponent(id)}`, {
            headers,
            redirect: 'manual',
            signal: requestSignal,
          });
        } catch (err) {
          if (signal.aborted) throw err;
          throw new JudgeInfrastructureError('upstream_unavailable', `QOJ verdict fetch failed for #${id}`, {
            platform: 'qoj',
          });
        }
        if (resp.status >= 300 && resp.status < 400) {
          await resp.body?.cancel();
          throw new JudgeInfrastructureError('auth_expired', `QOJ redirected while polling submission #${id}`, {
            platform: 'qoj',
            status: resp.status,
          });
        }
        if (!resp.ok) {
          await resp.body?.cancel();
          throw classifyHttpError(resp.status, `submission #${id}`);
        }

        const body = await resp.text();
        // Check login / captcha challenge BEFORE parsing summary row so auth/captcha pages are classified accurately.
        const challenge = detectCaptchaOrLogin(body);
        if (challenge === 'captcha') {
          throw new JudgeInfrastructureError('captcha_required', `QOJ returned captcha while polling #${id}`, {
            platform: 'qoj',
          });
        }
        if (challenge === 'login') {
          throw new JudgeInfrastructureError('auth_expired', `QOJ session expired while polling #${id}`, {
            platform: 'qoj',
          });
        }

        const row = parseQojSubmissionPage(id, body);
        if (!row) {
          throw new JudgeInfrastructureError(
            'identity_mismatch',
            `QOJ submission #${id} page missing matching summary row`,
            { platform: 'qoj' },
          );
        }
        // Fail closed on submission ID, submitter handle, and target problem!
        if (row.id !== id) {
          throw new JudgeInfrastructureError('identity_mismatch', `QOJ submission ID mismatch for #${id}`, {
            platform: 'qoj',
          });
        }
        if (!row.submitter || row.submitter.toLowerCase() !== handle.toLowerCase()) {
          throw new JudgeInfrastructureError('identity_mismatch', `QOJ submission #${id} missing or mismatched submitter`, {
            platform: 'qoj',
          });
        }
        const localProblem = problems.get(id)!;
        const expectedProblem = targetFor(localProblem);
        if (!row.problem_id || row.problem_id !== expectedProblem) {
          throw new JudgeInfrastructureError('identity_mismatch', `QOJ submission #${id} missing or mismatched problem`, {
            platform: 'qoj',
          });
        }

        const normalized = normalizeVerdict(row.raw_verdict, row.score, row.max_score);
        if (normalized === 'judge_error') {
          throw new JudgeInfrastructureError(
            'upstream_unavailable',
            `QOJ reported Judgement Failed for submission #${id}`,
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
