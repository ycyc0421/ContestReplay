import { parse as parseHtml } from 'parse5';
import type { OjPlatform } from '../oj-accounts.js';
import { defaultOriginFor } from '../oj-accounts.js';
import {
  htmlAttr,
  htmlText,
  parseCookieHeader,
  resolveBaseUrl,
  serializeCookieHeader,
  walkHtml,
  type FetchLike,
  type HtmlNode,
} from './types.js';

export interface OjAccountProbeResult {
  ok: boolean;
  authenticated: boolean;
  origin: string;
  detected_handle?: string;
  message: string;
}

const SAFE_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/;
const MAX_PROBE_BODY_BYTES = 512 * 1024;

function cleanHandle(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  return SAFE_HANDLE_RE.test(trimmed) ? trimmed : undefined;
}

async function cancelBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // ignore stream cancel errors
  }
}

async function readCappedText(
  resp: Response,
  maxBytes = MAX_PROBE_BODY_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  if (!resp.body) {
    const raw = await resp.text();
    const buf = Buffer.from(raw, 'utf8');
    if (buf.byteLength > maxBytes) {
      return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
    }
    return { text: raw, truncated: false };
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function buildParentMap(root: HtmlNode): Map<HtmlNode, HtmlNode> {
  const parents = new Map<HtmlNode, HtmlNode>();
  const stack: HtmlNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const child of node.childNodes ?? []) {
      parents.set(child, node);
      stack.push(child);
    }
  }
  return parents;
}

const CF_ACCOUNT_CONTAINER_RE = /(?:^|[\s_-])(?:lang-chooser|user-box|account|header-account|user-menu)(?:$|[\s_-])/i;
const QOJ_ACCOUNT_CONTAINER_RE = /(?:^|[\s_-])(?:nav|navbar|dropdown|account|user-menu|user-nav)(?:$|[\s_-])/i;

/**
 * Finds ONLY recognized account containers around the authenticated `/logout` link
 * (never climbing into generic page wrappers that could include public author links).
 */
function findAccountContainers(
  root: HtmlNode,
  isLogoutLink: (el: HtmlNode) => boolean,
  isRecognizedAncestor: (el: HtmlNode) => boolean,
): { hasLogout: boolean; containers: HtmlNode[] } {
  const parents = buildParentMap(root);
  const allNodes = walkHtml(root);
  const logoutNodes = allNodes.filter(node => node.tagName === 'a' && isLogoutLink(node));
  if (!logoutNodes.length) return { hasLogout: false, containers: [] };

  const containers: HtmlNode[] = [];
  for (const logoutLink of logoutNodes) {
    const directParent = parents.get(logoutLink);
    if (!directParent || !directParent.tagName || ['html', 'body', 'main'].includes(directParent.tagName)) continue;
    const grandParent = parents.get(directParent);
    const directRecognized = isRecognizedAncestor(directParent);
    const grandRecognized = Boolean(
      grandParent &&
      grandParent.tagName &&
      !['html', 'body', 'main'].includes(grandParent.tagName) &&
      isRecognizedAncestor(grandParent),
    );
    if (directRecognized || grandRecognized) {
      containers.push(directParent);
    }
    if (grandRecognized && grandParent) {
      containers.push(grandParent);
    }
  }
  return { hasLogout: true, containers };
}

function matchesContainerMarker(el: HtmlNode, re: RegExp): boolean {
  const cls = htmlAttr(el, 'class') ?? '';
  const id = htmlAttr(el, 'id') ?? '';
  return re.test(cls) || re.test(id);
}

function detectCodeforcesHandle(html: string, baseUrl: string): { authenticated: boolean; handle?: string } {
  const doc = parseHtml(html) as HtmlNode;
  const parsedBase = new URL(baseUrl);
  const basePath = parsedBase.pathname.replace(/\/+$/, '');
  const profilePrefix = `${basePath}/profile/`;
  const logoutSuffix = `${basePath}/logout`;

  const resolveLink = (el: HtmlNode): URL | undefined => {
    const href = htmlAttr(el, 'href');
    if (!href) return undefined;
    try {
      const resolved = new URL(href, `${parsedBase.origin}${basePath}/`);
      return resolved.origin === parsedBase.origin ? resolved : undefined;
    } catch {
      return undefined;
    }
  };

  const { hasLogout, containers } = findAccountContainers(
    doc,
    el => {
      const resolved = resolveLink(el);
      return Boolean(resolved && resolved.pathname.includes(logoutSuffix));
    },
    el => matchesContainerMarker(el, CF_ACCOUNT_CONTAINER_RE),
  );
  if (!hasLogout) return { authenticated: false };

  // Inspect narrowest recognized account container first; accept handle only when unambiguously unique.
  for (const container of containers) {
    const handles = new Set<string>();
    for (const el of walkHtml(container)) {
      if (el.tagName !== 'a') continue;
      const resolved = resolveLink(el);
      if (!resolved || !resolved.pathname.startsWith(profilePrefix)) continue;
      const seg = resolved.pathname.slice(profilePrefix.length).replace(/\/+$/, '');
      if (!seg || seg.includes('/')) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        continue;
      }
      const text = htmlText(el).trim();
      if (text.toLowerCase() === decoded.toLowerCase()) {
        const cleaned = cleanHandle(decoded);
        if (cleaned) handles.add(cleaned);
      }
    }
    if (handles.size === 1) {
      return { authenticated: true, handle: [...handles][0] };
    }
    if (handles.size > 1) {
      return { authenticated: true };
    }
  }

  return { authenticated: true };
}

function detectQojHandle(html: string, baseUrl: string): { authenticated: boolean; handle?: string } {
  const doc = parseHtml(html) as HtmlNode;
  const parsedBase = new URL(baseUrl);
  const basePath = parsedBase.pathname.replace(/\/+$/, '');
  const profilePrefix = `${basePath}/user/profile/`;

  const resolveLink = (el: HtmlNode): URL | undefined => {
    const href = htmlAttr(el, 'href');
    if (!href) return undefined;
    try {
      const resolved = new URL(href, `${parsedBase.origin}${basePath}/`);
      return resolved.origin === parsedBase.origin ? resolved : undefined;
    } catch {
      return undefined;
    }
  };

  const { hasLogout, containers } = findAccountContainers(
    doc,
    el => {
      const resolved = resolveLink(el);
      return Boolean(resolved && /\/logout(?:\/|$|\?)/.test(resolved.pathname));
    },
    el => el.tagName === 'nav' || matchesContainerMarker(el, QOJ_ACCOUNT_CONTAINER_RE),
  );
  if (!hasLogout) return { authenticated: false };

  for (const container of containers) {
    const handles = new Set<string>();
    for (const el of walkHtml(container)) {
      if (el.tagName !== 'a') continue;
      const resolved = resolveLink(el);
      if (!resolved || !resolved.pathname.startsWith(profilePrefix)) continue;
      const rawSeg = resolved.pathname.slice(profilePrefix.length).replace(/\/+$/, '');
      if (!rawSeg || rawSeg.includes('/')) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawSeg);
      } catch {
        continue;
      }
      const cleaned = cleanHandle(decoded);
      if (cleaned) handles.add(cleaned);
    }
    if (handles.size === 1) {
      return { authenticated: true, handle: [...handles][0] };
    }
    if (handles.size > 1) {
      return { authenticated: true };
    }
  }

  return { authenticated: true };
}

function extractJsonObjectAfter(raw: string, markerIndex: number): string | undefined {
  const start = raw.indexOf('{', markerIndex);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length && i - start < 65_536; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return undefined;
}

function detectHydroHandle(raw: string, contentType: string): { authenticated: boolean; handle?: string } {
  const fromContext = (ctx?: { _id?: unknown; uname?: unknown }): { authenticated: boolean; handle?: string } => {
    const uid = typeof ctx?._id === 'number' ? ctx._id : Number.NaN;
    if (Number.isFinite(uid) && uid > 0) {
      const uname = typeof ctx?.uname === 'string' ? cleanHandle(ctx.uname) : undefined;
      return { authenticated: true, ...(uname ? { handle: uname } : {}) };
    }
    return { authenticated: false };
  };

  if (contentType.includes('application/json')) {
    try {
      const data = JSON.parse(raw) as { UserContext?: { _id?: unknown; uname?: unknown } };
      return fromContext(data?.UserContext);
    } catch {
      return { authenticated: false };
    }
  }

  const marker = raw.search(/"UserContext"\s*:\s*\{/);
  if (marker >= 0) {
    const objText = extractJsonObjectAfter(raw, marker);
    if (objText) {
      try {
        return fromContext(JSON.parse(objText) as { _id?: unknown; uname?: unknown });
      } catch {
        // fall through
      }
    }
  }
  return { authenticated: false };
}

function parseVjudgeStatus(raw: string): { authenticated: boolean; handle?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { authenticated: false };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === false || parsed === null) return { authenticated: false };
    if (parsed === true) return { authenticated: true };
    if (typeof parsed === 'string') {
      const lower = parsed.trim().toLowerCase();
      if (!lower || lower === 'false' || lower === 'null') return { authenticated: false };
      if (lower === 'true') return { authenticated: true };
      const handle = cleanHandle(parsed);
      return { authenticated: Boolean(handle), ...(handle ? { handle } : {}) };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const candidate = typeof obj.username === 'string' ? obj.username : typeof obj.userName === 'string' ? obj.userName : undefined;
      const handle = cleanHandle(candidate);
      if (handle) return { authenticated: true, handle };
      if (obj.loggedIn === true || obj.status === true) return { authenticated: true };
      return { authenticated: false };
    }
    return { authenticated: false };
  } catch {
    const lower = trimmed.toLowerCase();
    if (lower === 'false' || lower === 'null') return { authenticated: false };
    if (lower === 'true') return { authenticated: true };
    const handle = cleanHandle(trimmed);
    return { authenticated: Boolean(handle), ...(handle ? { handle } : {}) };
  }
}

export async function probeOjAccountSession(
  input: { platform: OjPlatform; base_url?: string; secret: string },
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<OjAccountProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rawBase = input.base_url?.trim() || defaultOriginFor(input.platform);
  if (!rawBase) {
    return {
      ok: false,
      authenticated: false,
      origin: '',
      message: `${input.platform} 必须提供站点地址（Base URL）`,
    };
  }
  const { baseUrl, origin } = resolveBaseUrl(rawBase, input.platform);
  const parsedCookie = parseCookieHeader(input.secret, input.platform);
  const cookieHeader = serializeCookieHeader(parsedCookie);

  const timeoutSignal = AbortSignal.timeout(10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  try {
    if (input.platform === 'vjudge') {
      const resp = await fetchImpl(`${baseUrl}/user/checkLogInStatus`, {
        method: 'GET',
        headers: { cookie: cookieHeader, accept: 'text/plain, application/json' },
        redirect: 'manual',
        signal,
      });
      if (!resp.ok) {
        await cancelBody(resp);
        return { ok: false, authenticated: false, origin, message: `VJudge 响应异常（HTTP ${resp.status}）` };
      }
      const { text, truncated } = await readCappedText(resp, 32 * 1024);
      if (truncated) {
        return { ok: false, authenticated: false, origin, message: 'VJudge 响应体过大，已中止解析。' };
      }
      const result = parseVjudgeStatus(text);
      if (!result.authenticated) {
        return { ok: true, authenticated: false, origin, message: 'VJudge 会话未登录或已过期，请重新复制已登录后的 Cookie。' };
      }
      return {
        ok: true,
        authenticated: true,
        origin,
        ...(result.handle ? { detected_handle: result.handle } : {}),
        message: result.handle
          ? `VJudge 会话有效，已识别用户名 ${result.handle}`
          : 'VJudge 会话有效（上游仅返回登录态布尔值，请手动填写用户名）',
      };
    }

    if (input.platform === 'hydro') {
      const resp = await fetchImpl(`${baseUrl}/`, {
        method: 'GET',
        headers: { cookie: cookieHeader, accept: 'application/json, text/html' },
        redirect: 'manual',
        signal,
      });
      if (resp.status >= 300 && resp.status < 400) {
        await cancelBody(resp);
        return { ok: true, authenticated: false, origin, message: 'Hydro 将请求重定向至登录页，请检查站点地址与 Cookie。' };
      }
      if (!resp.ok) {
        await cancelBody(resp);
        return { ok: false, authenticated: false, origin, message: `Hydro 响应异常（HTTP ${resp.status}）` };
      }
      const { text, truncated } = await readCappedText(resp);
      if (truncated) {
        return { ok: false, authenticated: false, origin, message: 'Hydro 首页响应超过 512 KiB 安全上限，请确认站点地址是否正确。' };
      }
      const result = detectHydroHandle(text, resp.headers.get('content-type') ?? '');
      return {
        ok: true,
        authenticated: result.authenticated,
        origin,
        ...(result.handle ? { detected_handle: result.handle } : {}),
        message: result.authenticated
          ? result.handle ? `Hydro 会话有效，已识别用户名 ${result.handle}` : 'Hydro 会话有效（未自动解析到用户名，请手动填写）'
          : 'Hydro 会话未登录（Guest）或已过期。',
      };
    }

    const resp = await fetchImpl(`${baseUrl}/`, {
      method: 'GET',
      headers: { cookie: cookieHeader, accept: 'text/html' },
      redirect: 'manual',
      signal,
    });
    if (resp.status >= 300 && resp.status < 400) {
      await cancelBody(resp);
      return { ok: true, authenticated: false, origin, message: `${input.platform} 将请求重定向，请确认 Cookie 为当前登录会话。` };
    }
    if (!resp.ok) {
      await cancelBody(resp);
      return { ok: false, authenticated: false, origin, message: `上游平台响应异常（HTTP ${resp.status}），可能触发风控或站内维护。` };
    }
    const { text: html, truncated } = await readCappedText(resp);
    if (truncated) {
      return { ok: false, authenticated: false, origin, message: '上游页面响应超过 512 KiB 安全上限，已中止解析。' };
    }
    const result = input.platform === 'codeforces' ? detectCodeforcesHandle(html, baseUrl) : detectQojHandle(html, baseUrl);
    const label = input.platform === 'codeforces' ? 'Codeforces' : 'QOJ';
    return {
      ok: true,
      authenticated: result.authenticated,
      origin,
      ...(result.handle ? { detected_handle: result.handle } : {}),
      message: result.authenticated
        ? result.handle ? `${label} 会话有效，已识别用户名 ${result.handle}` : `${label} 会话有效（未解析到唯一用户名，请手动填写）`
        : `${label} 会话未登录或已过期，请确认已在浏览器登录并重新导出 Cookie。`,
    };
  } catch {
    return {
      ok: false,
      authenticated: false,
      origin,
      message: '连接上游平台超时或网络不可达，请检查本机网络与站点地址。',
    };
  }
}
