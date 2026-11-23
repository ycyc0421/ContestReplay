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

// RFC 6265 §4.1.1 cookie-name token (tchar)
const VALID_COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 6265 §4.1.1 cookie-octet = %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
// (excludes CTLs, whitespace, DQUOTE, comma ',', semicolon ';', backslash '\', and non-ASCII)
const COOKIE_OCTETS_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

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

function isValidCookieValue(value: string): boolean {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return COOKIE_OCTETS_RE.test(value.slice(1, -1));
  }
  return COOKIE_OCTETS_RE.test(value);
}

function isValidPair(name: string, value: string): boolean {
  return VALID_COOKIE_NAME_RE.test(name) && isValidCookieValue(value);
}

function parseNetscape(text: string): RawCookieEntry[] | null {
  const lines = text.split('\n');
  const entries: RawCookieEntry[] = [];
  let matchedNetscapeLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isHttpOnlyPrefixed = /^#HttpOnly_/i.test(line);
    if (trimmed.startsWith('#') && !isHttpOnlyPrefixed) continue;

    const cleanLine = isHttpOnlyPrefixed ? line.replace(/^#HttpOnly_/i, '') : line;
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
      name,
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

/**
 * POSIX-style shell tokenizer for Copy-as-cURL commands.
 * Supports single quotes, double quotes (with escapes), unquoted backslash escapes,
 * and `\` line continuations.
 */
function tokenizeShellCommand(text: string): string[] {
  const flat = text.replace(/\\\r?\n/g, ' ');
  const tokens: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < flat.length) {
        const next = flat[i + 1]!;
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          cur += next;
          i += 1;
          continue;
        }
      }
      if (ch === '"') inDouble = false;
      else cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < flat.length) {
      cur += flat[i + 1]!;
      i += 1;
      hasToken = true;
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

// Common cURL flags that consume a following argument token (must NOT be misread as request URLs)
const CURL_VALUE_FLAGS = new Set([
  '-H', '--header',
  '-b', '--cookie',
  '-c', '--cookie-jar',
  '-e', '--referer',
  '-A', '--user-agent',
  '-X', '--request',
  '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json',
  '-F', '--form', '--form-string',
  '-x', '--proxy', '--preproxy', '--noproxy',
  '-u', '--user', '--proxy-user',
  '-o', '--output', '-w', '--write-out', '-D', '--dump-header',
  '-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time',
  '-K', '--config', '--resolve', '--connect-to', '--interface',
  '--cacert', '--capath', '--cert', '--key', '--proxy-cacert', '--proxy-cert', '--proxy-key',
  '--proxy-header', '--oauth2-bearer', '--pinnedpubkey',
  '--doh-url', '--dns-servers', '--dns-interface', '--unix-socket', '--abstract-unix-socket',
  '--etag-save', '--etag-compare', '--speed-limit', '--speed-time', '--limit-rate',
  '-r', '--range', '-T', '--upload-file',
]);

// Known boolean cURL flags (take no following argument token)
const CURL_BOOLEAN_FLAGS = new Set([
  '-s', '--silent',
  '-S', '--show-error',
  '-i', '--include',
  '-I', '--head',
  '-L', '--location', '--location-trusted',
  '-k', '--insecure',
  '-v', '--verbose',
  '-g', '--globoff',
  '-f', '--fail', '--fail-with-body',
  '-N', '--no-buffer',
  '-G', '--get',
  '-4', '--ipv4',
  '-6', '--ipv6',
  '-q', '--disable',
  '-#', '--progress-bar',
  '--compressed', '--http1.0', '--http1.1', '--http2', '--http2-prior-knowledge', '--http3',
  '--raw', '--tr-encoding', '--tlsv1.2', '--tlsv1.3', '--ssl', '--ssl-reqd',
  '--post301', '--post302', '--post303', '--keepalive', '--no-keepalive',
  '--tcp-nodelay', '--path-as-is', '--anyauth', '--basic', '--digest', '--ntlm', '--negotiate',
  '--no-progress-meter', '--doh-insecure',
]);
const CURL_SHORT_BOOLEAN_CHARS = new Set(['s', 'S', 'i', 'I', 'L', 'k', 'v', 'g', 'f', 'N', 'G', '4', '6', 'q']);

function isKnownBooleanCurlFlag(tok: string): boolean {
  if (CURL_BOOLEAN_FLAGS.has(tok)) return true;
  // Support bundled short boolean flags such as `-sSLk`
  if (/^-[A-Za-z0-9]{2,}$/.test(tok)) {
    return [...tok.slice(1)].every(ch => CURL_SHORT_BOOLEAN_CHARS.has(ch));
  }
  return false;
}

// Strip ONLY RFC 6265 ASCII OWS (SP / HTAB), never Unicode whitespace such as NBSP (\u00A0).
function stripAsciiOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

function parseHeaderPairs(raw: string): { entries: RawCookieEntry[]; rejectedCount: number } {
  const entries: RawCookieEntry[] = [];
  let rejectedCount = 0;

  if (/[\r\n\0]/.test(raw)) {
    return { entries: [], rejectedCount: 1 };
  }
  const stripped = stripAsciiOws(raw).replace(/^cookie[ \t]*:[ \t]*/i, '');

  for (const part of stripped.split(';')) {
    const seg = stripAsciiOws(part);
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) {
      rejectedCount += 1;
      continue;
    }
    const name = seg.slice(0, eq);
    const value = seg.slice(eq + 1);
    if (!isValidPair(name, value)) {
      rejectedCount += 1;
      continue;
    }
    entries.push({ name, value });
  }
  return { entries, rejectedCount };
}

function parseCurl(text: string): {
  entries: RawCookieEntry[];
  rejectedCount: number;
  sourceOrigins: string[];
  ambiguousUrl: boolean;
  unknownFlag?: string;
} | null {
  const tokens = tokenizeShellCommand(text.trim());
  const curlIdx = tokens.findIndex(tok => /^curl$/i.test(tok));
  if (curlIdx < 0) return null;

  const rawChunks: string[] = [];
  const requestOrigins = new Set<string>();
  let ambiguousUrl = false;
  let unknownFlag: string | undefined;
  let afterDoubleDash = false;

  const recordUrl = (candidate: string) => {
    if (!/^https?:\/\//i.test(candidate)) {
      ambiguousUrl = true;
      return;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        requestOrigins.add(parsed.origin.toLowerCase());
      } else {
        ambiguousUrl = true;
      }
    } catch {
      ambiguousUrl = true;
    }
  };

  for (let i = curlIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!afterDoubleDash && tok === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && (tok === '-H' || tok === '--header')) {
      const val = tokens[i + 1] ?? '';
      i += 1;
      if (/^cookie[ \t]*:/i.test(stripAsciiOws(val))) {
        rawChunks.push(stripAsciiOws(val).replace(/^cookie[ \t]*:[ \t]*/i, ''));
      }
      continue;
    }
    if (!afterDoubleDash && tok.startsWith('--header=')) {
      const val = tok.slice('--header='.length);
      if (/^cookie[ \t]*:/i.test(stripAsciiOws(val))) {
        rawChunks.push(stripAsciiOws(val).replace(/^cookie[ \t]*:[ \t]*/i, ''));
      }
      continue;
    }
    if (!afterDoubleDash && (tok === '-b' || tok === '--cookie')) {
      const val = tokens[i + 1] ?? '';
      i += 1;
      if (stripAsciiOws(val)) rawChunks.push(stripAsciiOws(val));
      continue;
    }
    if (!afterDoubleDash && tok.startsWith('--cookie=')) {
      const val = tok.slice('--cookie='.length);
      if (stripAsciiOws(val)) rawChunks.push(stripAsciiOws(val));
      continue;
    }
    if (!afterDoubleDash && tok === '--url') {
      const val = tokens[i + 1];
      i += 1;
      if (val) recordUrl(val);
      else ambiguousUrl = true;
      continue;
    }
    if (!afterDoubleDash && tok.startsWith('--url=')) {
      recordUrl(tok.slice('--url='.length));
      continue;
    }
    if (!afterDoubleDash && CURL_VALUE_FLAGS.has(tok)) {
      // Skip value of known option flags such as --referer, --doh-url, --proxy, --data, etc.
      i += 1;
      continue;
    }
    if (!afterDoubleDash && tok.startsWith('-')) {
      if (tok.startsWith('--') && tok.includes('=')) {
        // Long flag with inline `=value` has self-contained arity (consumes 0 extra tokens)
        continue;
      }
      if (isKnownBooleanCurlFlag(tok)) {
        continue;
      }
      // Fail closed on unrecognized options whose arity is unknown so their value cannot spoof or hide a URL
      unknownFlag = tok;
      ambiguousUrl = true;
      continue;
    }
    // Every positional argument in cURL is a request URL target (including scheme-less hosts)
    recordUrl(tok);
  }

  if (!rawChunks.length) return null;
  const combined = rawChunks.join('; ');
  const { entries, rejectedCount } = parseHeaderPairs(combined);
  if (requestOrigins.size > 1) ambiguousUrl = true;
  return {
    entries,
    rejectedCount,
    sourceOrigins: [...requestOrigins],
    ambiguousUrl,
    unknownFlag,
  };
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
  let ambiguousCurl = false;

  const netscape = parseNetscape(rawInput);
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
        ambiguousCurl = curl.ambiguousUrl;
        if (curl.ambiguousUrl) {
          originStatus = 'mismatched';
          sourceOrigin = curl.sourceOrigins.join(', ') || '(ambiguous)';
        } else if (curl.sourceOrigins.length === 1) {
          sourceOrigin = curl.sourceOrigins[0];
          originStatus = sourceOrigin === target.origin.toLowerCase() ? 'matched' : 'mismatched';
        } else {
          originStatus = 'unknown';
        }
      } else {
        format = 'header';
        const headerParsed = parseHeaderPairs(rawInput);
        entries = headerParsed.entries;
        initialRejected = headerParsed.rejectedCount;
        originStatus = 'unknown';
      }
    }
  }

  const warnings: string[] = [];

  if (originStatus === 'mismatched') {
    warnings.push(
      ambiguousCurl
        ? 'cURL 命令包含多个或无法识别的目标站点 URL，已阻止导入以防凭据发送到错误站点。'
        : `cURL 请求来源为 ${sourceOrigin}，与当前目标站点 ${target.origin} 不一致，已阻止导入以防凭据发送到错误站点。`,
    );
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
      warnings.push('输入包含不符合 RFC 6265 的 Cookie 键名、值或控制字符，请粘贴单行 Cookie 请求头、cookies.txt、cURL 或 JSON 导出。');
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
