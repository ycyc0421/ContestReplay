import type { OjPlatform } from '../oj-accounts.js';
import { defaultOriginFor } from '../oj-accounts.js';
import {
  htmlAttr,
  htmlText,
  parseCookieHeader,
  parseHtmlNodes,
  resolveBaseUrl,
  serializeCookieHeader,
  type FetchLike,
} from './types.js';

export interface OjAccountProbeResult {
  ok: boolean;
  authenticated: boolean;
  origin: string;
  detected_handle?: string;
  message: string;
}

const SAFE_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/;

function cleanHandle(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  return SAFE_HANDLE_RE.test(trimmed) ? trimmed : undefined;
}

function detectCodeforcesHandle(html: string, baseUrl: string): { authenticated: boolean; handle?: string } {
  const parsedBase = new URL(baseUrl);
  const basePath = parsedBase.pathname.replace(/\/+$/, '');
  const profilePrefix = `${basePath}/profile/`;
  const logoutSuffix = `${basePath}/logout`;
  let hasLogout = false;
  let detected: string | undefined;

  for (const el of parseHtmlNodes(html)) {
    if (el.tagName !== 'a') continue;
    const href = htmlAttr(el, 'href');
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, `${parsedBase.origin}${basePath}/`);
    } catch {
      continue;
    }
    if (resolved.origin !== parsedBase.origin) continue;
    if (resolved.pathname.includes(logoutSuffix)) {
      hasLogout = true;
      continue;
    }
    if (!detected && resolved.pathname.startsWith(profilePrefix)) {
      const seg = resolved.pathname.slice(profilePrefix.length).replace(/\/+$/, '');
      if (seg && !seg.includes('/')) {
        const text = htmlText(el).trim();
        if (text.toLowerCase() === seg.toLowerCase()) {
          detected = cleanHandle(seg);
        }
      }
    }
  }

  if (!hasLogout) return { authenticated: false };
  return { authenticated: true, ...(detected ? { handle: detected } : {}) };
}

function detectQojHandle(html: string, baseUrl: string): { authenticated: boolean; handle?: string } {
  const parsedBase = new URL(baseUrl);
  const basePath = parsedBase.pathname.replace(/\/+$/, '');
  const profilePrefix = `${basePath}/user/profile/`;
  let hasLogout = false;
  let detected: string | undefined;

  for (const el of parseHtmlNodes(html)) {
    if (el.tagName !== 'a') continue;
    const href = htmlAttr(el, 'href');
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, `${parsedBase.origin}${basePath}/`);
    } catch {
      continue;
    }
    if (resolved.origin !== parsedBase.origin) continue;
    if (/\/logout(?:\/|$|\?)/.test(resolved.pathname)) {
      hasLogout = true;
      continue;
    }
    if (!detected && resolved.pathname.startsWith(profilePrefix)) {
      const seg = decodeURIComponent(resolved.pathname.slice(profilePrefix.length).replace(/\/+$/, ''));
      if (seg && !seg.includes('/')) {
        detected = cleanHandle(seg);
      }
    }
  }

  if (!hasLogout) return { authenticated: false };
  return { authenticated: true, ...(detected ? { handle: detected } : {}) };
}

function detectHydroHandle(raw: string, contentType: string): { authenticated: boolean; handle?: string } {
  if (contentType.includes('application/json')) {
    try {
      const data = JSON.parse(raw) as { UserContext?: { _id?: number; uname?: string } };
      const uid = data?.UserContext?._id;
      const uname = cleanHandle(data?.UserContext?.uname);
      if (typeof uid === 'number' && uid > 0) {
        return { authenticated: true, ...(uname ? { handle: uname } : {}) };
      }
      return { authenticated: false };
    } catch {
      return { authenticated: false };
    }
  }
  const match = raw.match(/"UserContext"\s*:\s*\{[^}]*"_id"\s*:\s*(\d+)[^}]*"uname"\s*:\s*"([^"]+)"/);
  if (match && Number(match[1]) > 0) {
    const uname = cleanHandle(match[2]);
    return { authenticated: true, ...(uname ? { handle: uname } : {}) };
  }
  return { authenticated: false };
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
        return { ok: false, authenticated: false, origin, message: `VJudge 响应异常（HTTP ${resp.status}）` };
      }
      const text = (await resp.text()).trim().replace(/^"|"$/g, '');
      if (!text || text.toLowerCase() === 'false' || text.toLowerCase() === 'null') {
        return { ok: true, authenticated: false, origin, message: 'VJudge 会话未登录或已过期，请重新复制已登录后的 Cookie。' };
      }
      const handle = cleanHandle(text);
      return {
        ok: true,
        authenticated: Boolean(handle),
        origin,
        ...(handle ? { detected_handle: handle } : {}),
        message: handle ? `VJudge 会话有效，已识别用户名 ${handle}` : '无法从 VJudge 响应确认登录状态。',
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
        return { ok: true, authenticated: false, origin, message: 'Hydro 将请求重定向至登录页，请检查站点地址与 Cookie。' };
      }
      if (!resp.ok) {
        return { ok: false, authenticated: false, origin, message: `Hydro 响应异常（HTTP ${resp.status}）` };
      }
      const result = detectHydroHandle(await resp.text(), resp.headers.get('content-type') ?? '');
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
      return { ok: true, authenticated: false, origin, message: `${input.platform} 将请求重定向，请确认 Cookie 为当前登录会话。` };
    }
    if (!resp.ok) {
      return { ok: false, authenticated: false, origin, message: `上游平台响应异常（HTTP ${resp.status}），可能触发风控或站内维护。` };
    }
    const html = await resp.text();
    const result = input.platform === 'codeforces' ? detectCodeforcesHandle(html, baseUrl) : detectQojHandle(html, baseUrl);
    const label = input.platform === 'codeforces' ? 'Codeforces' : 'QOJ';
    return {
      ok: true,
      authenticated: result.authenticated,
      origin,
      ...(result.handle ? { detected_handle: result.handle } : {}),
      message: result.authenticated
        ? result.handle ? `${label} 会话有效，已识别用户名 ${result.handle}` : `${label} 会话有效（未解析到用户名，请手动填写）`
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
