import { parseOjCookieInput } from './cookie-parser';

describe('parseOjCookieInput', () => {
  it('parses Netscape cookies.txt including #HttpOnly_ entries and filters by platform domain', () => {
    const raw = [
      '# Netscape HTTP Cookie File',
      '# https://curl.haxx.se/rfc/cookie_spec.html',
      '#HttpOnly_.codeforces.com\tTRUE\t/\tTRUE\t2147483647\tJSESSIONID\tABC123',
      '.codeforces.com\tTRUE\t/\tFALSE\t2147483647\t39ce7\tXYZ999',
      '.github.com\tTRUE\t/\tTRUE\t2147483647\tlogged_in\tyes',
      '.codeforces.com\tTRUE\t/\tTRUE\t1000\told_expired\tstale',
    ].join('\n');

    const result = parseOjCookieInput(raw, 'codeforces');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('netscape');
    expect(result!.keys).toEqual(['JSESSIONID', '39ce7']);
    expect(result!.normalizedHeader).toBe('JSESSIONID=ABC123; 39ce7=XYZ999');
    expect(result!.filteredOutCount).toBe(1);
    expect(result!.missingRecommendedKeys).toEqual([]);
    expect(result!.warnings.some(w => w.includes('已过期'))).toBe(true);
  });

  it('extracts Cookie headers from multiline cURL commands', () => {
    const raw = `curl 'https://qoj.ac/problems' \\\n  -H 'accept: text/html' \\\n  -H 'Cookie: UOJSESSID=sess-val-1; theme=dark'`;
    const result = parseOjCookieInput(raw, 'qoj');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('curl');
    expect(result!.keys).toEqual(['UOJSESSID', 'theme']);
    expect(result!.normalizedHeader).toBe('UOJSESSID=sess-val-1; theme=dark');
    expect(result!.missingRecommendedKeys).toEqual([]);
  });

  it('parses Cookie-Editor JSON arrays and Playwright storageState objects with custom Hydro host filtering', () => {
    const json = JSON.stringify({
      cookies: [
        { name: 'sid', value: 'hydro-sid-1', domain: 'oj.school.edu' },
        { name: 'other', value: 'skip-me', domain: 'unrelated.org' },
      ],
    });
    const result = parseOjCookieInput(json, 'hydro', 'https://oj.school.edu');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('json');
    expect(result!.keys).toEqual(['sid']);
    expect(result!.filteredOutCount).toBe(1);
    expect(result!.normalizedHeader).toBe('sid=hydro-sid-1');
    expect(result!.missingRecommendedKeys).toEqual([]);
  });

  it('strips optional Cookie: prefix and accidental newlines from raw headers and reports missing keys', () => {
    const result = parseOjCookieInput('Cookie: RCPC=val1;\nfoo=bar', 'codeforces');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('header');
    expect(result!.normalizedHeader).toBe('RCPC=val1; foo=bar');
    expect(result!.missingRecommendedKeys).toEqual(['JSESSIONID']);
  });
});
