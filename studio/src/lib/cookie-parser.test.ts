import { parseOjCookieInput } from './cookie-parser';

describe('parseOjCookieInput', () => {
  const fixedNow = 1_750_000_000;

  it('parses Netscape cookies.txt with #HttpOnly_, respects hostOnly vs subdomains, and filters other domains', () => {
    const raw = [
      '# Netscape HTTP Cookie File',
      '#HttpOnly_.codeforces.com\tTRUE\t/\tTRUE\t1900000000\tJSESSIONID\tABC123',
      'codeforces.com\tFALSE\t/\tTRUE\t1900000000\t39ce7\tXYZ789',
      'sub.codeforces.com\tFALSE\t/\tTRUE\t1900000000\tSUBONLY\tleak',
      '.evilcodeforces.com\tTRUE\t/\tTRUE\t1900000000\tEVIL\tbad',
      '.codeforces.com\tTRUE\t/\tFALSE\t1700000000\tOLD_TOKEN\texpired',
    ].join('\n');

    const res = parseOjCookieInput(raw, 'codeforces', undefined, fixedNow)!;
    expect(res.format).toBe('netscape');
    expect(res.originStatus).toBe('matched');
    expect(res.keys).toEqual(['JSESSIONID', '39ce7']);
    expect(res.normalizedHeader).toBe('JSESSIONID=ABC123; 39ce7=XYZ789');
    expect(res.filteredOutCount).toBe(2); // sub.codeforces.com + evilcodeforces.com
    expect(res.expiredCount).toBe(1);
    expect(res.missingRecommendedKeys).toEqual([]);
  });

  it('does NOT send parent hostOnly cookie to a subdomain mirror', () => {
    const raw = JSON.stringify([
      { name: 'JSESSIONID', value: 'root_only', domain: 'codeforces.com', hostOnly: true },
      { name: '39ce7', value: 'shared', domain: '.codeforces.com', hostOnly: false },
    ]);
    const res = parseOjCookieInput(raw, 'codeforces', 'https://mirror.codeforces.com', fixedNow)!;
    expect(res.keys).toEqual(['39ce7']);
    expect(res.filteredOutCount).toBe(1);
  });

  it('filters Secure cookies when target is loopback HTTP', () => {
    const raw = JSON.stringify([
      { name: 'sid', value: 'https_only', domain: '127.0.0.1', hostOnly: true, secure: true },
      { name: 'sid_dev', value: 'plain_ok', domain: '127.0.0.1', hostOnly: true, secure: false },
    ]);
    const res = parseOjCookieInput(raw, 'hydro', 'http://127.0.0.1:8888', fixedNow)!;
    expect(res.keys).toEqual(['sid_dev']);
    expect(res.secureFilteredCount).toBe(1);
  });

  it('extracts Cookie header from matching cURL command and rejects mismatched cURL origin', () => {
    const matchingCurl = `curl 'https://qoj.ac/problem/1' \\\n  -H 'Cookie: UOJSESSID=qoj_sess_1; foo=bar'`;
    const okRes = parseOjCookieInput(matchingCurl, 'qoj', undefined, fixedNow)!;
    expect(okRes.format).toBe('curl');
    expect(okRes.originStatus).toBe('matched');
    expect(okRes.normalizedHeader).toBe('UOJSESSID=qoj_sess_1; foo=bar');

    const mismatchedCurl = `curl 'https://evil.example.com/api' -H 'Cookie: JSESSIONID=stolen'`;
    const badRes = parseOjCookieInput(mismatchedCurl, 'codeforces', undefined, fixedNow)!;
    expect(badRes.originStatus).toBe('mismatched');
    expect(badRes.normalizedHeader).toBe('');
    expect(badRes.keys).toEqual([]);
    expect(badRes.warnings[0]).toMatch(/不一致/);
  });

  it('marks bare Cookie header as unknown origin and rejects CRLF / semicolon injection in values', () => {
    const res = parseOjCookieInput('Cookie: JSESSIONID=vj_99; foo=bar', 'vjudge', undefined, fixedNow)!;
    expect(res.format).toBe('header');
    expect(res.originStatus).toBe('unknown');
    expect(res.normalizedHeader).toBe('JSESSIONID=vj_99; foo=bar');

    // Multiline raw header must be rejected rather than converting newlines into `;`
    const multiline = parseOjCookieInput('JSESSIONID=a\nfoo=b', 'codeforces', undefined, fixedNow)!;
    expect(multiline.normalizedHeader).toBe('');
    expect(multiline.rejectedCount).toBe(1);

    // JSON cookie with `;` inside value or invalid name must be rejected as a unit
    const injectedJson = JSON.stringify([
      { name: 'bad name', value: 'ok', domain: '.codeforces.com', hostOnly: false },
      { name: 'JSESSIONID', value: 'val; injected=1', domain: '.codeforces.com', hostOnly: false },
      { name: '39ce7', value: 'clean', domain: '.codeforces.com', hostOnly: false },
    ]);
    const jsonRes = parseOjCookieInput(injectedJson, 'codeforces', undefined, fixedNow)!;
    expect(jsonRes.keys).toEqual(['39ce7']);
    expect(jsonRes.rejectedCount).toBe(2);
  });
});
