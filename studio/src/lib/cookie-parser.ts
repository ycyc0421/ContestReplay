export type OjPlatformKind = 'codeforces' | 'qoj' | 'vjudge' | 'hydro';

export type CookieInputFormat = 'netscape' | 'curl' | 'json' | 'header';
export type CookieOriginStatus = 'matched' | 'unknown' | 'mismatched';

export interface ParsedCookieImport {
  format: CookieInputFormat;
  formatLabel: string;
  normalizedHeader: string;
  keys: string[];
  targetDomain: string;
  targetOrigin: string;
  originStatus: CookieOriginStatus;
  sourceOrigin?: string;
  filteredOutCount: number;
  expiredCount: number;
  secureFilteredCount: number;
  rejectedCount: number;
  missingRecommendedKeys: string[];
  warnings: string[];
}

export interface OjPlatformMeta {
  id: OjPlatformKind;
  label: string;
  defaultDomain: string;
  defaultOrigin?: string;
  userLabel: string;
  userPlaceholder: string;
  recommendedCookieKeys: string[];
  requiresBaseUrl: boolean;
}

export const OJ_PLATFORM_META: Record<OjPlatformKind, OjPlatformMeta> = {
  codeforces: {
    id: 'codeforces',
    label: 'Codeforces',
    defaultDomain: 'codeforces.com',
    defaultOrigin: 'https://codeforces.com',
    userLabel: 'Codeforces 用户名（Handle）',
    userPlaceholder: '例如 tourist（必须与当前登录 Cookie 一致）',
    recommendedCookieKeys: ['JSESSIONID'],
    requiresBaseUrl: false,
  },
  qoj: {
    id: 'qoj',
    label: 'QOJ',
    defaultDomain: 'qoj.ac',
    defaultOrigin: 'https://qoj.ac',
    userLabel: 'QOJ 用户名',
    userPlaceholder: '例如 your_qoj_username',
    recommendedCookieKeys: ['UOJSESSID'],
    requiresBaseUrl: false,
  },
  vjudge: {
    id: 'vjudge',
    label: 'VJudge',
    defaultDomain: 'vjudge.net',
    defaultOrigin: 'https://vjudge.net',
    userLabel: 'VJudge 用户名',
    userPlaceholder: '例如 your_vjudge_username',
    recommendedCookieKeys: ['JSESSIONID'],
    requiresBaseUrl: false,
  },
  hydro: {
    id: 'hydro',
    label: 'Hydro',
    defaultDomain: 'hydro.ac',
    userLabel: 'Hydro 用户名',
    userPlaceholder: '例如 your_hydro_username',
    recommendedCookieKeys: ['sid'],
    requiresBaseUrl: true,
  },
};

const FORMAT_LABELS: Record<CookieInputFormat, string> = {
  netscape: 'Netscape cookies.txt',
  curl: 'cURL 命令',
  json: 'Cookie JSON 导出',
  header: 'Cookie 请求头',
};

// RFC 6265 cookie-name token (tchar)
const VALID_COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Disallow control characters (including CR/LF/NUL/TAB) and ';' in serialized cookie values
const VALID_COOKIE_VALUE_RE = /^[^\x00-\x1F\x7F;]*$/;

interface RawCookieEntry {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  secure?: boolean;
  expiresSec?: number;
}

export function resolveTargetEndpoint(
  platform: OjPlatformKind,
  baseUrl?: string,
): { host: string; protocol: 'https:' | 'http:'; origin: string } {
  const fallbackHost = OJ_PLATFORM_META[platform].defaultDomain;
  const fallbackOrigin = OJ_PLATFORM_META[platform].defaultOrigin ?? `https://${fallbackHost}`;
  const raw = baseUrl?.trim();
  if (!raw) {
    return { host: fallbackHost, protocol: 'https:', origin: fallbackOrigin };
  }
  try {
    const parsed = new URL(raw);
    const protocol = parsed.protocol === 'http:' ? 'http:' : 'https:';
    return {
      host: parsed.hostname.toLowerCase(),
      protocol,
      origin: parsed.origin,
    };
  } catch {
    return { host: fallbackHost, protocol: 'https:', origin: fallbackOrigin };
  }
}

function normalizeHost(domain: string): string {
  return domain.trim().replace(/^#HttpOnly_/i, '').replace(/^\./, '').toLowerCase();
}

/**
 * RFC 6265 domain matching (strict one-way parent-to-child only):
 * - hostOnly cookies match ONLY exact hostname.
 * - domain cookies match exact hostname OR subdomains of cookieDomain (NEVER reverse!).
 */
function domainMatches(cookieDomain: string | undefined, hostOnly: boolean | undefined, targetHost: string): boolean {
  if (!cookieDomain) return true;
  const cleaned = normalizeHost(cookieDomain);
  if (!cleaned) return false;
  if (hostOnly) return targetHost === cleaned;
  return targetHost === cleaned || targetHost.endsWith(`.${cleaned}`);
}

function isValidPair(name: string, value: string): boolean {
  return VALID_COOKIE_NAME_RE.test(name) && VALID_COOKIE_VALUE_RE.test(value);
}

function parseNetscape(text: string): RawCookieEntry[] | null {
  const lines = text.split(/\r?\n/);
  const entries: RawCookieEntry[] = [];
  let matchedNetscapeLines = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const isHttpOnlyPrefixed = /^#HttpOnly_/i.test(trimmed);
    if (trimmed.startsWith('#') && !isHttpOnlyPrefixed) continue;

    const cleanLine = isHttpOnlyPrefixed ? trimmed.replace(/^#HttpOnly_/i, '') : trimmed;
    const fields = cleanLine.split('\t');
    if (fields.length < 7) continue;

    const [domain, includeSubdomains, _path, secureFlag, expiration, name, ...rest] = fields;
    if (!domain || !name) continue;
    matchedNetscapeLines += 1;
    const expNum = Number(expiration);
    const hostOnly = includeSubdomains!.trim().toUpperCase() !== 'TRUE';
    const secure = secureFlag!.trim().toUpperCase() === 'TRUE';
    entries.push({
      domain,
      hostOnly,
      secure,
      name: name.trim(),
      value: rest.join('\t'),
      expiresSec: Number.isFinite(expNum) && expNum > 0 ? expNum : undefined,
    });
  }

  return matchedNetscapeLines > 0 ? entries : null;
}

function parseJsonCookies(text: string): RawCookieEntry[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? (parsed as { cookies: unknown[] }).cookies
      : null;

  if (!arr) return null;

  const entries: RawCookieEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || typeof rec.value !== 'string') continue;
    const exp = typeof rec.expirationDate === 'number'
      ? rec.expirationDate
      : typeof rec.expires === 'number'
        ? rec.expires
        : undefined;
    const rawDomain = typeof rec.domain === 'string' ? rec.domain : undefined;
    const hostOnly = typeof rec.hostOnly === 'boolean'
      ? rec.hostOnly
      : rawDomain !== undefined
        ? !rawDomain.trim().startsWith('.')
        : undefined;
    entries.push({
      name: rec.name,
      value: rec.value,
      domain: rawDomain,
      hostOnly,
      secure: typeof rec.secure === 'boolean' ? rec.secure : undefined,
      expiresSec: exp && exp > 0 ? exp : undefined,
    });
  }
  return entries.length > 0 ? entries : null;
}

function extractCurlOrigin(text: string): string | undefined {
  // Collapse explicit shell line continuations before scanning URL tokens
  const flat = text.replace(/\\\r?\n/g, ' ');
  // Match first http(s) URL argument (quoted or unquoted), skipping header/cookie values
  const stripped = flat
    .replace(/(?:-H|--header)\s+(?:'[^']*'|"[^"]*")/g, ' ')
    .replace(/(?:-b|--cookie)\s+(?:'[^']*'|"[^"]*")/g, ' ');
  const urlMatch = stripped.match(/(?:^|\s)['"]?(https?:\/\/[^\s'"]+)['"]?/i);
  if (!urlMatch?.[1]) return undefined;
  try {
    return new URL(urlMatch[1]).origin;
  } catch {
    return undefined;
  }
}

function parseHeaderPairs(raw: string): { entries: RawCookieEntry[]; rejectedCount: number } {
  const entries: RawCookieEntry[] = [];
  let rejectedCount = 0;

  // Header input must not use raw line breaks as cookie separators; strip optional leading `Cookie:` prefix only.
  const trimmed = raw.trim().replace(/^cookie\s*:\s*/i, '');
  if (/[\r\n\0]/.test(trimmed)) {
    return { entries: [], rejectedCount: 1 };
  }

  for (const part of trimmed.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) {
      rejectedCount += 1;
      continue;
    }
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (!isValidPair(name, value)) {
      rejectedCount += 1;
      continue;
    }
    entries.push({ name, value });
  }
  return { entries, rejectedCount };
}

function parseCurl(text: string): { entries: RawCookieEntry[]; rejectedCount: number; sourceOrigin?: string } | null {
  if (!/(^|\s)curl(\s|$)/i.test(text.trim())) return null;
  const flat = text.replace(/\\\r?\n/g, ' ');
  const rawChunks: string[] = [];

  const headerRe = /(?:-H|--header)\s+(?:'([^']*)'|"([^"]*)")/g;
  for (const match of flat.matchAll(headerRe)) {
    const content = match[1] ?? match[2] ?? '';
    if (/^cookie\s*:/i.test(content.trim())) {
      rawChunks.push(content.replace(/^cookie\s*:/i, '').trim());
    }
  }

  const cookieFlagRe = /(?:-b|--cookie)\s+(?:'([^']*)'|"([^"]*)")/g;
  for (const match of flat.matchAll(cookieFlagRe)) {
    const content = match[1] ?? match[2] ?? '';
    if (content.trim()) rawChunks.push(content.trim());
  }

  if (!rawChunks.length) return null;
  const combined = rawChunks.join('; ');
  const { entries, rejectedCount } = parseHeaderPairs(combined);
  const sourceOrigin = extractCurlOrigin(text);
  return { entries, rejectedCount, sourceOrigin };
}

export function parseOjCookieInput(
  rawInput: string,
  platform: OjPlatformKind,
  baseUrl?: string,
  nowSec = Math.floor(Date.now() / 1000),
): ParsedCookieImport | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  const target = resolveTargetEndpoint(platform, baseUrl);
  const meta = OJ_PLATFORM_META[platform];
  let format: CookieInputFormat = 'header';
  let entries: RawCookieEntry[] = [];
  let initialRejected = 0;
  let originStatus: CookieOriginStatus = 'unknown';
  let sourceOrigin: string | undefined;

  const netscape = parseNetscape(trimmed);
  if (netscape) {
    format = 'netscape';
    entries = netscape;
    originStatus = 'matched';
  } else {
    const json = parseJsonCookies(trimmed);
    if (json) {
      format = 'json';
      entries = json;
      originStatus = entries.some(e => Boolean(e.domain)) ? 'matched' : 'unknown';
    } else {
      const curl = parseCurl(trimmed);
      if (curl) {
        format = 'curl';
        entries = curl.entries;
        initialRejected = curl.rejectedCount;
        sourceOrigin = curl.sourceOrigin;
        if (sourceOrigin) {
          originStatus = sourceOrigin.toLowerCase() === target.origin.toLowerCase() ? 'matched' : 'mismatched';
        } else {
          originStatus = 'unknown';
        }
      } else {
        format = 'header';
        const headerParsed = parseHeaderPairs(trimmed);
        entries = headerParsed.entries;
        initialRejected = headerParsed.rejectedCount;
        originStatus = 'unknown';
      }
    }
  }

  const warnings: string[] = [];

  if (originStatus === 'mismatched' && sourceOrigin) {
    warnings.push(`cURL 请求来源为 ${sourceOrigin}，与当前目标站点 ${target.origin} 不一致，已阻止导入以防凭据发送到错误站点。`);
    return {
      format,
      formatLabel: FORMAT_LABELS[format],
      normalizedHeader: '',
      keys: [],
      targetDomain: target.host,
      targetOrigin: target.origin,
      originStatus: 'mismatched',
      sourceOrigin,
      filteredOutCount: entries.length,
      expiredCount: 0,
      secureFilteredCount: 0,
      rejectedCount: initialRejected,
      missingRecommendedKeys: meta.recommendedCookieKeys,
      warnings,
    };
  }

  let filteredOutCount = 0;
  let expiredCount = 0;
  let secureFilteredCount = 0;
  let rejectedCount = initialRejected;
  const deduped = new Map<string, string>();

  for (const entry of entries) {
    if (!isValidPair(entry.name, entry.value)) {
      rejectedCount += 1;
      continue;
    }
    if (entry.domain && !domainMatches(entry.domain, entry.hostOnly, target.host)) {
      filteredOutCount += 1;
      continue;
    }
    if (entry.secure && target.protocol !== 'https:') {
      secureFilteredCount += 1;
      continue;
    }
    if (entry.expiresSec && entry.expiresSec < nowSec) {
      expiredCount += 1;
      continue;
    }
    deduped.set(entry.name, entry.value);
  }

  const keys = [...deduped.keys()];
  const normalizedHeader = [...deduped.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  const keyLowerSet = new Set(keys.map(k => k.toLowerCase()));
  const missingRecommendedKeys = meta.recommendedCookieKeys.filter(
    req => !keyLowerSet.has(req.toLowerCase()),
  );

  if (keys.length === 0) {
    if (filteredOutCount > 0) {
      warnings.push(`未找到匹配 ${target.host} 的 Cookie（已过滤 ${filteredOutCount} 个其他域名或子域专用条目）。`);
    } else if (secureFilteredCount > 0) {
      warnings.push(`有 ${secureFilteredCount} 个 Secure Cookie 无法发送到非 HTTPS 目标 ${target.origin}。`);
    } else if (expiredCount > 0) {
      warnings.push(`解析到的 ${expiredCount} 个 Cookie 均已过期，请重新登录浏览器后导出。`);
    } else if (rejectedCount > 0) {
      warnings.push('输入包含非法 Cookie 键名、换行符或控制字符，请粘贴单行 Cookie 请求头、cookies.txt、cURL 或 JSON 导出。');
    } else {
      warnings.push('未能解析出有效的 Cookie 键值对。');
    }
  } else {
    if (expiredCount > 0) {
      warnings.push(`已跳过 ${expiredCount} 个已过期条目。`);
    }
    if (secureFilteredCount > 0) {
      warnings.push(`已跳过 ${secureFilteredCount} 个仅限 HTTPS 的 Secure Cookie。`);
    }
    if (rejectedCount > 0) {
      warnings.push(`已忽略 ${rejectedCount} 个格式非法的 Cookie 项。`);
    }
  }

  return {
    format,
    formatLabel: FORMAT_LABELS[format],
    normalizedHeader,
    keys,
    targetDomain: target.host,
    targetOrigin: target.origin,
    originStatus,
    sourceOrigin,
    filteredOutCount,
    expiredCount,
    secureFilteredCount,
    rejectedCount,
    missingRecommendedKeys,
    warnings,
  };
}
