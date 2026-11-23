export type OjPlatformKind = 'codeforces' | 'qoj' | 'vjudge' | 'hydro';
export type DetectedCookieFormat = 'netscape' | 'curl' | 'json' | 'header';

export interface OjPlatformMeta {
  kind: OjPlatformKind;
  label: string;
  defaultDomain: string;
  userLabel: string;
  userPlaceholder: string;
  recommendedKeys: readonly string[];
  requiresBaseUrl?: boolean;
}

export const OJ_PLATFORM_META: Record<OjPlatformKind, OjPlatformMeta> = {
  codeforces: {
    kind: 'codeforces',
    label: 'Codeforces',
    defaultDomain: 'codeforces.com',
    userLabel: 'Codeforces 用户名（Handle）',
    userPlaceholder: '例如 tourist',
    recommendedKeys: ['JSESSIONID'],
  },
  qoj: {
    kind: 'qoj',
    label: 'QOJ',
    defaultDomain: 'qoj.ac',
    userLabel: 'QOJ 用户名',
    userPlaceholder: '输入 QOJ 登录用户名',
    recommendedKeys: ['UOJSESSID'],
  },
  vjudge: {
    kind: 'vjudge',
    label: 'VJudge',
    defaultDomain: 'vjudge.net',
    userLabel: 'VJudge 用户名',
    userPlaceholder: '输入 VJudge 登录用户名',
    recommendedKeys: ['JSESSIONID'],
  },
  hydro: {
    kind: 'hydro',
    label: 'Hydro',
    defaultDomain: '自托管站点',
    userLabel: 'Hydro 用户名',
    userPlaceholder: '输入 Hydro 用户名',
    recommendedKeys: ['sid'],
    requiresBaseUrl: true,
  },
};

export const COOKIE_FORMAT_LABELS: Record<DetectedCookieFormat, string> = {
  netscape: 'Netscape cookies.txt',
  curl: 'cURL 命令',
  json: 'JSON Cookie 导出',
  header: 'HTTP Cookie 请求头',
};

export interface ParsedCookieImport {
  format: DetectedCookieFormat;
  formatLabel: string;
  targetDomain: string;
  normalizedHeader: string;
  keys: string[];
  filteredOutCount: number;
  missingRecommendedKeys: string[];
  warnings: string[];
}

function resolveTargetHost(platform: OjPlatformKind, baseUrl?: string): string | undefined {
  if (baseUrl?.trim()) {
    try {
      return new URL(baseUrl.trim()).hostname.toLowerCase();
    } catch {
      // Fall back to platform default below
    }
  }
  if (platform === 'hydro') return undefined;
  return OJ_PLATFORM_META[platform].defaultDomain;
}

function domainMatches(cookieDomain: string | undefined, targetHost: string | undefined): boolean {
  if (!targetHost || !cookieDomain) return true;
  const clean = cookieDomain.replace(/^#HttpOnly_/i, '').replace(/^\./, '').trim().toLowerCase();
  if (!clean) return true;
  return targetHost === clean || targetHost.endsWith(`.${clean}`) || clean.endsWith(`.${targetHost}`);
}

function sanitizeCookieToken(value: string): string {
  return value.replace(/[\r\n\0]/g, '').trim();
}

function parseHeaderPairs(raw: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const singleLine = raw.replace(/\r?\n/g, '; ').replace(/^\s*cookie\s*:\s*/i, '');
  for (const part of singleLine.split(';')) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = sanitizeCookieToken(trimmed.slice(0, idx));
    const val = sanitizeCookieToken(trimmed.slice(idx + 1));
    if (key && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) && val.length > 0) {
      pairs.set(key, val);
    }
  }
  return pairs;
}

function extractCurlCookieBody(text: string): string | undefined {
  const joined = text.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const patterns = [
    /(?:-H|--header)\s+['"]\s*cookie\s*:\s*([^'"]+)['"]/gi,
    /(?:-b|--cookie)\s+['"]([^'"]+)['"]/gi,
  ];
  const chunks: string[] = [];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(joined)) !== null) {
      if (match[1]) chunks.push(match[1]);
    }
  }
  return chunks.length ? chunks.join('; ') : undefined;
}

export function parseOjCookieInput(
  raw: string,
  platform: OjPlatformKind,
  baseUrl?: string,
): ParsedCookieImport | null {
  const text = raw.trim();
  if (!text) return null;

  const targetHost = resolveTargetHost(platform, baseUrl);
  const targetDomain = targetHost ?? OJ_PLATFORM_META[platform].defaultDomain;
  const pairs = new Map<string, string>();
  const warnings: string[] = [];
  let filteredOutCount = 0;
  let format: DetectedCookieFormat = 'header';

  // 1. Netscape cookies.txt (including #HttpOnly_ lines!)
  const lines = text.split(/\r?\n/);
  const looksNetscape =
    /^#\s*Netscape\s+HTTP\s+Cookie\s+File/im.test(text) ||
    lines.some(line => /^#HttpOnly_/i.test(line.trim()) || line.split('\t').length >= 7);

  if (looksNetscape) {
    format = 'netscape';
    const nowSec = Math.floor(Date.now() / 1000);
    let expiredCount = 0;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const isHttpOnly = /^#HttpOnly_/i.test(trimmed);
      if (trimmed.startsWith('#') && !isHttpOnly) continue;
      const normalizedLine = isHttpOnly ? trimmed.replace(/^#HttpOnly_/i, '') : trimmed;
      const cols = normalizedLine.split('\t');
      if (cols.length < 7) continue;
      const [domain, , , , expiresRaw, nameRaw, ...rest] = cols;
      const name = sanitizeCookieToken(nameRaw ?? '');
      const value = sanitizeCookieToken(rest.join('\t'));
      if (!name || !value) continue;
      if (!domainMatches(domain, targetHost)) {
        filteredOutCount += 1;
        continue;
      }
      const expires = Number(expiresRaw);
      if (Number.isFinite(expires) && expires > 0 && expires < nowSec) {
        expiredCount += 1;
        continue;
      }
      pairs.set(name, value);
    }
    if (expiredCount > 0) {
      warnings.push(`已跳过 ${expiredCount} 个已过期的 Cookie`);
    }
  } else if (/^\s*curl\b/i.test(text)) {
    format = 'curl';
    const extracted = extractCurlCookieBody(text);
    if (!extracted) {
      warnings.push('未在 cURL 命令中找到 -H "Cookie: ..." 或 -b 参数');
    } else {
      for (const [k, v] of parseHeaderPairs(extracted)) pairs.set(k, v);
    }
  } else if (text.startsWith('[') || text.startsWith('{')) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      parsedJson = undefined;
    }
    const items = Array.isArray(parsedJson)
      ? parsedJson
      : parsedJson && typeof parsedJson === 'object' && Array.isArray((parsedJson as { cookies?: unknown }).cookies)
        ? (parsedJson as { cookies: unknown[] }).cookies
        : undefined;
    if (items) {
      format = 'json';
      const nowSec = Math.floor(Date.now() / 1000);
      let expiredCount = 0;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as { name?: unknown; value?: unknown; domain?: unknown; expirationDate?: unknown; expires?: unknown };
        if (typeof record.name !== 'string' || typeof record.value !== 'string') continue;
        const name = sanitizeCookieToken(record.name);
        const value = sanitizeCookieToken(record.value);
        if (!name || !value) continue;
        if (typeof record.domain === 'string' && !domainMatches(record.domain, targetHost)) {
          filteredOutCount += 1;
          continue;
        }
        const exp = typeof record.expirationDate === 'number' ? record.expirationDate : typeof record.expires === 'number' ? record.expires : undefined;
        if (exp !== undefined && exp > 0 && exp < nowSec) {
          expiredCount += 1;
          continue;
        }
        pairs.set(name, value);
      }
      if (expiredCount > 0) {
        warnings.push(`已跳过 ${expiredCount} 个已过期的 Cookie`);
      }
    } else {
      for (const [k, v] of parseHeaderPairs(text)) pairs.set(k, v);
    }
  } else {
    for (const [k, v] of parseHeaderPairs(text)) pairs.set(k, v);
  }

  const keys = [...pairs.keys()];
  const lowerKeys = new Set(keys.map(k => k.toLowerCase()));
  const missingRecommendedKeys = OJ_PLATFORM_META[platform].recommendedKeys.filter(
    req => !lowerKeys.has(req.toLowerCase()),
  );
  if (keys.length === 0) {
    warnings.push(
      filteredOutCount > 0
        ? `文件中包含 ${filteredOutCount} 个其他域名的 Cookie，但未匹配到 ${targetDomain}`
        : '未能解析出有效的 key=value Cookie 项，请检查粘贴内容',
    );
  }

  const normalizedHeader = [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');

  return {
    format,
    formatLabel: COOKIE_FORMAT_LABELS[format],
    targetDomain,
    normalizedHeader,
    keys,
    filteredOutCount,
    missingRecommendedKeys,
    warnings,
  };
}
