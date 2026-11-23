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

    // --referer pointing to codeforces.com MUST NOT disguise a request sent to evil.example.com
    const refererSpoof = `curl --referer 'https://codeforces.com/' 'https://evil.example.com/steal' -H 'Cookie: JSESSIONID=stolen'`;
    const spoofRes = parseOjCookieInput(refererSpoof, 'codeforces', undefined, fixedNow)!;
    expect(spoofRes.originStatus).toBe('mismatched');
    expect(spoofRes.normalizedHeader).toBe('');

    // Multiple distinct request URLs are rejected as ambiguous
    const multiUrl = `curl 'https://codeforces.com/' 'https://evil.example.com/' -H 'Cookie: JSESSIONID=abc'`;
    const multiRes = parseOjCookieInput(multiUrl, 'codeforces', undefined, fixedNow)!;
    expect(multiRes.originStatus).toBe('mismatched');
    expect(multiRes.normalizedHeader).toBe('');

    // Scheme-less second positional host MUST NOT be ignored
    const schemelessSecond = `curl 'https://qoj.ac/' 'evil.example.com/steal' -H 'Cookie: UOJSESSID=abc'`;
    const schemelessRes = parseOjCookieInput(schemelessSecond, 'qoj', undefined, fixedNow)!;
    expect(schemelessRes.originStatus).toBe('mismatched');
    expect(schemelessRes.normalizedHeader).toBe('');

    // Known value-taking option such as --doh-url pointing elsewhere does NOT poison request origin
    const dohCurl = `curl --doh-url 'https://dns.google/dns-query' 'https://qoj.ac/contest/1' -H 'Cookie: UOJSESSID=qoj_ok'`;
    const dohRes = parseOjCookieInput(dohCurl, 'qoj', undefined, fixedNow)!;
    expect(dohRes.originStatus).toBe('matched');
    expect(dohRes.normalizedHeader).toBe('UOJSESSID=qoj_ok');

    // Unknown flag arity fails closed rather than returning matched
    const unknownFlagCurl = `curl --unknown-flag 'https://evil.example.com' 'https://qoj.ac/' -H 'Cookie: UOJSESSID=qoj_ok'`;
    const unknownFlagRes = parseOjCookieInput(unknownFlagCurl, 'qoj', undefined, fixedNow)!;
    expect(unknownFlagRes.originStatus).toBe('mismatched');
    expect(unknownFlagRes.normalizedHeader).toBe('');

    // Unknown inline --flag=value (e.g. --expand-url=...) MUST fail closed too
    const expandUrlCurl = `curl --expand-url='https://evil.example.com' 'https://qoj.ac/' -H 'Cookie: UOJSESSID=qoj_ok'`;
    const expandUrlRes = parseOjCookieInput(expandUrlCurl, 'qoj', undefined, fixedNow)!;
    expect(expandUrlRes.originStatus).toBe('mismatched');
    expect(expandUrlRes.normalizedHeader).toBe('');

    // Unquoted cURL -b ending with NBSP MUST reject the malformed NBSP value instead of stripping it
    const curlTrailingNbsp = `curl 'https://qoj.ac/' -b X=\u00A0`;
    const curlNbspRes = parseOjCookieInput(curlTrailingNbsp, 'qoj', undefined, fixedNow)!;
    expect(curlNbspRes.normalizedHeader).toBe('');
    expect(curlNbspRes.rejectedCount).toBe(1);
  });

  it('marks bare Cookie header as unknown origin, preserves Netscape empty values, and rejects NBSP / invalid RFC 6265 values', () => {
    const res = parseOjCookieInput('Cookie: JSESSIONID="vj_99"; foo=bar', 'vjudge', undefined, fixedNow)!;
    expect(res.format).toBe('header');
    expect(res.originStatus).toBe('unknown');
    expect(res.normalizedHeader).toBe('JSESSIONID="vj_99"; foo=bar');

    // Non-breaking space (\u00A0) immediately after '=' MUST be rejected, not silently trimmed
    const nbsp = parseOjCookieInput('JSESSIONID=\u00A0abc', 'codeforces', undefined, fixedNow)!;
    expect(nbsp.normalizedHeader).toBe('');
    expect(nbsp.rejectedCount).toBe(1);

    // Netscape row with a valid empty cookie value on the last line MUST be preserved (trailing tab intact)
    const emptyNetscape = '# Netscape HTTP Cookie File\ncodeforces.com\tFALSE\t/\tTRUE\t1900000000\tEMPTY\t';
    const emptyRes = parseOjCookieInput(emptyNetscape, 'codeforces', undefined, fixedNow)!;
    expect(emptyRes.format).toBe('netscape');
    expect(emptyRes.keys).toEqual(['EMPTY']);
    expect(emptyRes.normalizedHeader).toBe('EMPTY=');

    // Multiline raw header must be rejected rather than converting newlines into `;`
    const multiline = parseOjCookieInput('JSESSIONID=a\nfoo=b', 'codeforces', undefined, fixedNow)!;
    expect(multiline.normalizedHeader).toBe('');
    expect(multiline.rejectedCount).toBe(1);

    // RFC 6265 rejects spaces, commas, semicolons, backslashes, and non-ASCII bytes in cookie values
    const injectedJson = JSON.stringify([
      { name: 'bad name', value: 'ok', domain: '.codeforces.com', hostOnly: false },
      { name: 'JSESSIONID', value: 'val; injected=1', domain: '.codeforces.com', hostOnly: false },
      { name: 'SPACE', value: 'has space', domain: '.codeforces.com', hostOnly: false },
      { name: 'COMMA', value: 'a,b', domain: '.codeforces.com', hostOnly: false },
      { name: 'NONASCII', value: '中文值', domain: '.codeforces.com', hostOnly: false },
      { name: '39ce7', value: 'clean', domain: '.codeforces.com', hostOnly: false },
    ]);
    const jsonRes = parseOjCookieInput(injectedJson, 'codeforces', undefined, fixedNow)!;
    expect(jsonRes.keys).toEqual(['39ce7']);
    expect(jsonRes.rejectedCount).toBe(5);
  });
});
