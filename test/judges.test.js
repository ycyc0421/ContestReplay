import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEFORCES_LANGUAGE_PRESETS,
  HYDRO_STATUS,
  JudgeInfrastructureError,
  OjAccountPool,
  OjAccounts,
  cfFormForContest,
  cfReceiptForContest,
  createCodeforcesJudge,
  createHydroJudge,
  createProgramJudge,
  createQojJudge,
  createVjudgeJudge,
  extractProblemLabelsFromText,
  inferProblemMap,
  languagePresetsFor,
  listJudgeBackends,
  mapHydroStatus,
  normalizeVerdict,
  parseQojSubmissionPage,
  parseUpstreamProblemRef,
  previewCodeforcesContest,
  previewContest,
  previewHydroContest,
  previewQojContest,
  previewVjudgeContest,
} from '../dist/judges/index.js';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

test('normalizeVerdict handles standard, partial, pending, and infrastructure verdicts safely', () => {
  assert.equal(normalizeVerdict('OK'), 'accepted');
  assert.equal(normalizeVerdict('Accepted'), 'accepted');
  // Partial score strictly less than maxScore MUST NOT be classified as accepted
  assert.equal(normalizeVerdict('Accepted', 50, 100), 'partial');
  assert.equal(normalizeVerdict('Accepted', 0, 100), 'wrong_answer');
  assert.equal(normalizeVerdict('TESTING'), 'pending');
  assert.equal(normalizeVerdict('Running on test 7'), 'pending');
  assert.equal(normalizeVerdict('WRONG_ANSWER'), 'wrong_answer');
  assert.equal(normalizeVerdict('Wrong Answer', 45, 100), 'partial');
  assert.equal(normalizeVerdict('Time Limit Exceeded', 60, 100), 'partial');
  assert.equal(normalizeVerdict('Time Limit Exceeded', 0, 100), 'time_limit_exceeded');
  assert.equal(normalizeVerdict('MEMORY_LIMIT_EXCEEDED'), 'memory_limit_exceeded');
  assert.equal(normalizeVerdict('RUNTIME_ERROR'), 'runtime_error');
  assert.equal(normalizeVerdict('COMPILATION_ERROR'), 'compilation_error');
  assert.equal(normalizeVerdict('PRESENTATION_ERROR'), 'presentation_error');
  assert.equal(normalizeVerdict('IDLENESS_LIMIT_EXCEEDED'), 'idleness_limit_exceeded');
  // Infrastructure failures MUST map to judge_error (even with positive score)
  assert.equal(normalizeVerdict('FAILED'), 'judge_error');
  assert.equal(normalizeVerdict('FAILED', 50, 100), 'judge_error');
  assert.equal(normalizeVerdict('INPUT_PREPARATION_CRASHED'), 'judge_error');
  assert.equal(normalizeVerdict('CRASHED'), 'judge_error');
  assert.equal(normalizeVerdict('Judgement Failed'), 'judge_error');
  assert.equal(normalizeVerdict('Judgment Failed'), 'judge_error');
  assert.equal(normalizeVerdict('Remote OJ Unavailable'), 'judge_error');
});

test('inferProblemMap preserves bare Q, avoids non-ordinal mis-pairing, and separates confirmed vs suggested maps', () => {
  // 1. Exact + normalized including bare "Q" and "P"
  const alphaThroughQ = Array.from({ length: 17 }, (_, i) => String.fromCharCode(65 + i)); // A..Q
  const qResult = inferProblemMap(
    alphaThroughQ.map(ch => `Problem ${ch}`),
    alphaThroughQ.map(ch => ({ remote_id: ch })),
  );
  assert.equal(qResult.problem_map['Problem Q'], 'Q');
  assert.equal(qResult.confirmed_map['Problem Q'], 'Q');
  assert.deepEqual(qResult.unmapped_local, []);

  const bareQ = inferProblemMap(['P', 'Q'], [{ remote_id: 'P' }, { remote_id: 'Q' }]);
  assert.deepEqual(bareQ.problem_map, { P: 'P', Q: 'Q' });

  // 2. Trailing punctuation before P prefix ("P1.", "P2.")
  const pDot = inferProblemMap(['P1.', 'P2.'], [{ remote_id: 'A' }, { remote_id: 'B' }]);
  assert.deepEqual(pDot.problem_map, { 'P1.': 'A', 'P2.': 'B' });

  // 3. Guard against non-ordinal numeric IDs like ['3', '100', '101'] mis-pairing C -> 3
  const nonOrdinal = inferProblemMap(
    ['A', 'B', 'C'],
    [{ remote_id: '3' }, { remote_id: '100' }, { remote_id: '101' }],
  );
  // Must NOT match C -> 3 via alpha_to_numeric; instead falls back cleanly to ordered positional low-confidence suggestion
  assert.deepEqual(nonOrdinal.confirmed_map, {});
  assert.deepEqual(nonOrdinal.suggested_map, { A: '3', B: '100', C: '101' });
  assert.ok(nonOrdinal.matches.every(m => m.strategy === 'positional' && m.confidence === 'low'));

  // 4. Normalized collision stays unmapped (strict 1-to-1)
  const collision = inferProblemMap(['Problem A', 'Task A'], [{ remote_id: 'A' }]);
  assert.deepEqual(collision.confirmed_map, {});
  assert.deepEqual(collision.unmapped_local, ['Problem A', 'Task A']);

  // 5. Mismatched lengths leave unmapped entries
  const mismatch = inferProblemMap(['A', 'B', 'C'], [{ remote_id: '7810' }, { remote_id: '7811' }]);
  assert.deepEqual(mismatch.problem_map, {});
  assert.deepEqual(mismatch.unmapped_local, ['A', 'B', 'C']);
  assert.deepEqual(mismatch.unmapped_remote, ['7810', '7811']);
});

test('extractProblemLabelsFromText detects headings while ignoring prose and generic section headers', () => {
  const sampleText = `
    ICPC Regional Contest 2025
    Problem A. Two Sum
    Notice that problem a can be solved in O(n) time.
    I. Notes
    A. Constraints
    Problem B1: Matrix Chains
    Task C - Graph Walk
    D. Final Boss
    P5. Bonus Task
  `;
  assert.deepEqual(extractProblemLabelsFromText(sampleText), ['A', 'B1', 'C', 'D', 'P5']);
});

test('Cross-origin binding and env-cookie guard block unauthorized origins with ZERO authenticated requests', async t => {
  const prevStorage = process.env.CR_CREDENTIAL_STORAGE;
  const prevCfCookie = process.env.CR_CODEFORCES_COOKIE;
  const prevCfBase = process.env.CR_CODEFORCES_BASE_URL;
  const prevHydroCookie = process.env.CR_HYDRO_COOKIE;
  const prevHydroBase = process.env.CR_HYDRO_BASE_URL;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  process.env.CR_CODEFORCES_COOKIE = 'JSESSIONID=secret-env-cf-cookie';
  delete process.env.CR_CODEFORCES_BASE_URL;
  process.env.CR_HYDRO_COOKIE = 'sid=secret-env-hydro-cookie';
  delete process.env.CR_HYDRO_BASE_URL;

  const dir = await mkdtemp(join(tmpdir(), 'cr-origin-guard-'));
  t.after(async () => {
    if (prevStorage === undefined) delete process.env.CR_CREDENTIAL_STORAGE;
    else process.env.CR_CREDENTIAL_STORAGE = prevStorage;
    if (prevCfCookie === undefined) delete process.env.CR_CODEFORCES_COOKIE;
    else process.env.CR_CODEFORCES_COOKIE = prevCfCookie;
    if (prevCfBase === undefined) delete process.env.CR_CODEFORCES_BASE_URL;
    else process.env.CR_CODEFORCES_BASE_URL = prevCfBase;
    if (prevHydroCookie === undefined) delete process.env.CR_HYDRO_COOKIE;
    else process.env.CR_HYDRO_COOKIE = prevHydroCookie;
    if (prevHydroBase === undefined) delete process.env.CR_HYDRO_BASE_URL;
    else process.env.CR_HYDRO_BASE_URL = prevHydroBase;
    await rm(dir, { recursive: true, force: true });
  });

  const store = new OjAccounts(join(dir, 'oj'));
  await store.create({
    id: 'cf-official',
    label: 'CF Official',
    platform: 'codeforces',
    handle: 'cf_user',
    transport: 'cookie',
    secret: 'JSESSIONID=bound-only-to-official-cf',
  });

  let fetchCalls = 0;
  const countingFetch = async () => {
    fetchCalls++;
    throw new Error('fetch should never be called for unapproved origins');
  };

  // 1. Account bound to https://codeforces.com used against mirror origin -> 0 requests!
  const badAccountJudge = createCodeforcesJudge(
    {
      contest_id: 1,
      account_id: 'cf-official',
      base_url: 'https://evil-mirror.example.test',
      languages: { cpp20: 89 },
    },
    { accounts: store, fetchImpl: countingFetch },
  );
  await assert.rejects(
    badAccountJudge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'auth_expired',
  );
  assert.equal(fetchCalls, 0);

  // 2. Env CR_CODEFORCES_COOKIE against non-default origin without CR_CODEFORCES_BASE_URL -> 0 requests!
  const badEnvCf = createCodeforcesJudge(
    {
      contest_id: 1,
      handle: 'cf_user',
      base_url: 'https://evil-mirror.example.test',
      languages: { cpp20: 89 },
    },
    { fetchImpl: countingFetch },
  );
  await assert.rejects(
    badEnvCf.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'auth_expired',
  );
  assert.equal(fetchCalls, 0);

  // 3. Env CR_HYDRO_COOKIE without CR_HYDRO_BASE_URL -> 0 requests!
  const badEnvHydro = createHydroJudge(
    {
      base_url: 'http://127.0.0.1:8888',
      handle: 'hydro_user',
      languages: { cpp20: 'cc.cc20o2' },
    },
    { fetchImpl: countingFetch },
  );
  await assert.rejects(
    badEnvHydro.submit('P1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'auth_expired',
  );
  assert.equal(fetchCalls, 0);
});

test('Pool-leased deps.account (cookie mode) works across all 4 adapters without config.handle or env fallback', async t => {
  const prevStorage = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  const dir = await mkdtemp(join(tmpdir(), 'cr-pool-lease-all4-'));
  t.after(async () => {
    if (prevStorage === undefined) delete process.env.CR_CREDENTIAL_STORAGE;
    else process.env.CR_CREDENTIAL_STORAGE = prevStorage;
    await rm(dir, { recursive: true, force: true });
  });

  const store = new OjAccounts(join(dir, 'oj'));
  const cfAcc = await store.create({
    id: 'lease-cf',
    label: 'CF Lease',
    platform: 'codeforces',
    handle: 'lease_cf_handle',
    transport: 'cookie',
    secret: 'JSESSIONID=cf-lease-secret',
  });
  const qojAcc = await store.create({
    id: 'lease-qoj',
    label: 'QOJ Lease',
    platform: 'qoj',
    handle: 'lease_qoj_handle',
    transport: 'cookie',
    secret: 'UOJSESSID=qoj-lease-secret',
  });
  const vjAcc = await store.create({
    id: 'lease-vj',
    label: 'VJ Lease',
    platform: 'vjudge',
    handle: 'lease_vj_handle',
    transport: 'cookie',
    secret: 'JSESSIONID=vj-lease-secret',
  });
  const hydroAcc = await store.create({
    id: 'lease-hydro',
    label: 'Hydro Lease',
    platform: 'hydro',
    handle: 'lease_hydro_handle',
    base_url: 'http://127.0.0.1:8888',
    transport: 'cookie',
    secret: 'sid=hydro-lease-secret; sid.sig=sig',
  });

  // Codeforces via deps.account (cookie)
  const cfJudge = createCodeforcesJudge(
    { contest_id: 4, languages: { cpp20: 89 } },
    {
      accounts: store,
      account: cfAcc,
      skipContestCheck: true,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/contest/4/submit' && (!init?.method || init.method === 'GET')) {
          assert.match(String(init?.headers?.cookie), /cf-lease-secret/);
          return htmlResponse(
            '<a href="/profile/lease_cf_handle">lease_cf_handle</a><form action="?csrf_token=tok"><input type="hidden" name="csrf_token" value="tok"><select name="submittedProblemIndex"></select><textarea name="source"></textarea></form>',
          );
        }
        if (url.pathname === '/api/user.status') return jsonResponse({ status: 'OK', result: [] });
        if (url.pathname === '/contest/4/submit' && init?.method === 'POST') {
          return redirectResponse('/contest/4/submission/101');
        }
        throw new Error(url.href);
      },
    },
  );
  assert.equal(await cfJudge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), '101');

  // QOJ via deps.account (cookie)
  const qojJudge = createQojJudge(
    { languages: { cpp20: 'C++20' } },
    {
      accounts: store,
      account: qojAcc,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/problem/100' && (!init?.method || init.method === 'GET')) {
          assert.match(String(init?.headers?.cookie), /qoj-lease-secret/);
          return htmlResponse('<form><input type="hidden" name="_token" value="qt"><textarea name="answer_answer_editor"></textarea></form>');
        }
        if (url.pathname === '/submissions') return htmlResponse('<table></table>');
        if (url.pathname === '/problem/100' && init?.method === 'POST') return redirectResponse('/submission/202');
        throw new Error(url.href);
      },
    },
  );
  assert.equal(await qojJudge.submit('100', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), '202');

  // VJudge via deps.account (cookie)
  const vjJudge = createVjudgeJudge(
    { languages: { cpp20: 'C++20' }, problem_map: { A: 'QOJ-100' } },
    {
      accounts: store,
      account: vjAcc,
      fetchImpl: async (_input, init) => {
        assert.match(String(init?.headers?.cookie), /vj-lease-secret/);
        return jsonResponse({ runId: 303 });
      },
    },
  );
  assert.equal(await vjJudge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), '303');

  // Hydro via deps.account (cookie)
  const hydroJudge = createHydroJudge(
    { base_url: 'http://127.0.0.1:8888', languages: { cpp20: 'cc.cc20o2' } },
    {
      accounts: store,
      account: hydroAcc,
      fetchImpl: async (_input, init) => {
        assert.match(String(init?.headers?.cookie), /hydro-lease-secret/);
        return jsonResponse({ rid: '404' });
      },
    },
  );
  assert.equal(await hydroJudge.submit('P1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), '404');
});

test('Codeforces handles relative action, captcha-in-title false positive, Gym contest.status + /gym/my fallback, non-partial points, and minimal submitter env', async t => {
  // 1. Relative action="?csrf_token=..." AND problem title containing "captcha" must succeed
  const relativeActionHtml = `
    <title>Problem A: Captcha Solver</title>
    <a href="/profile/cf_tester">cf_tester</a>
    <form action="?csrf_token=reltok">
      <input type="hidden" name="csrf_token" value="reltok">
      <select name="submittedProblemIndex"></select>
      <textarea name="source"></textarea>
    </form>
  `;
  const parsedForm = cfFormForContest(relativeActionHtml, 1234, 'cf_tester');
  assert.equal(parsedForm.action.pathname, '/contest/1234/submit');
  assert.equal(parsedForm.action.search, '?csrf_token=reltok');
  assert.equal(cfReceiptForContest('/gym/104567/submission/555111', 104567, { gym: true }), '555111');

  // 2. Gym mode uses /api/contest.status (NOT user.status!), retries failed contest precheck, and ignores decaying OK points
  let submitted = false;
  let standingsAttempts = 0;
  let sawContestStatus = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const gymHtml =
    '<a href="/profile/cf_tester">cf_tester</a><form action="?csrf_token=gymtok"><input type="hidden" name="csrf_token" value="gymtok"><select name="submittedProblemIndex"></select><textarea name="source"></textarea></form>';

  const mockFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/contest.standings') {
      standingsAttempts++;
      if (standingsAttempts === 1) return jsonResponse({ status: 'FAILED' }, 503);
      return jsonResponse({
        status: 'OK',
        result: {
          contest: { id: 104567, name: '2024 ICPC Regional Gym', phase: 'FINISHED' },
          problems: [{ index: 'A', name: 'Alpha', points: 500 }],
        },
      });
    }
    if (url.pathname === '/gym/104567/submit' && (!init?.method || init.method === 'GET')) {
      return htmlResponse(gymHtml);
    }
    if (url.pathname === '/gym/104567/submit' && init?.method === 'POST') {
      submitted = true;
      return redirectResponse('/gym/104567/my');
    }
    if (url.pathname === '/api/user.status') {
      throw new Error('Gym mode must use /api/contest.status, not /api/user.status');
    }
    if (url.pathname === '/api/contest.status') {
      sawContestStatus = true;
      assert.equal(url.searchParams.get('contestId'), '104567');
      const rows = submitted
        ? [
            {
              id: 888002,
              contestId: 104567,
              problem: { index: 'A', contestId: 104567, points: 500 },
              author: { participantType: 'PRACTICE', members: [{ handle: 'cf_tester' }] },
              creationTimeSeconds: nowSec,
              verdict: 'OK',
              points: 450, // CF time-decayed points on OK must NOT produce partial score
              timeConsumedMillis: 46,
              memoryConsumedBytes: 1024 * 256,
            },
          ]
        : [];
      return jsonResponse({ status: 'OK', result: rows });
    }
    throw new Error(`Unexpected URL: ${url.href}`);
  };

  const judge = createCodeforcesJudge(
    { contest_id: 104567, gym: true, handle: 'cf_tester', languages: { cpp20: 89 }, problem_map: { '1': 'A' } },
    { cookie: 'JSESSIONID=test-gym-cookie', fetchImpl: mockFetch, delayImpl: async () => {} },
  );

  // First submit fails on transient 503 standings; second submit MUST retry precheck (not cached failure!)
  await assert.rejects(
    judge.submit('1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'upstream_unavailable',
  );
  const subId = await judge.submit('1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000));
  assert.equal(subId, '888002');
  assert.equal(sawContestStatus, true);

  const verdicts = await judge.verdicts(['888002'], new Map([['888002', '1']]), AbortSignal.timeout(5000));
  const v = verdicts.get('888002');
  assert.ok(v);
  assert.equal(v.verdict, 'accepted');
  assert.equal(v.score, undefined);
  assert.equal(v.max_score, undefined);

  // 3. External submitter receives minimal allowlisted env (no OPENAI_API_KEY leak) and stderr never leaks into error
  const prevOpenAi = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-super-secret-must-not-pass-to-submitter';
  const dir = await mkdtemp(join(tmpdir(), 'cr-cf-exec-'));
  t.after(async () => {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    await rm(dir, { recursive: true, force: true });
  });

  const envCheckExec = join(dir, 'check-env.mjs');
  await writeFile(
    envCheckExec,
    `#!/usr/bin/env node
if (process.env.OPENAI_API_KEY) {
  process.stderr.write('LEAKED_OPENAI=' + process.env.OPENAI_API_KEY);
  process.exit(2);
}
process.stdout.write(JSON.stringify({ submission_id: '999001' }));
`,
    { mode: 0o755 },
  );
  await chmod(envCheckExec, 0o755);

  const okExecJudge = createCodeforcesJudge(
    { contest_id: 104567, gym: true, handle: 'cf_tester', languages: { cpp20: 89 } },
    { executable: envCheckExec, skipContestCheck: true },
  );
  assert.equal(await okExecJudge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), '999001');

  const failingExec = join(dir, 'fail-stderr.mjs');
  await writeFile(
    failingExec,
    `#!/usr/bin/env node
process.stderr.write('SECRET_MARKER_COOKIE_99999');
process.exit(7);
`,
    { mode: 0o755 },
  );
  await chmod(failingExec, 0o755);

  const failExecJudge = createCodeforcesJudge(
    { contest_id: 104567, gym: true, handle: 'cf_tester', languages: { cpp20: 89 } },
    { executable: failingExec, skipContestCheck: true },
  );
  await assert.rejects(
    failExecJudge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)),
    err => {
      assert.ok(err instanceof JudgeInfrastructureError);
      assert.equal(err.code, 'submitter_failed');
      assert.equal(err.details?.exitCode, 7);
      assert.ok(!err.message.includes('SECRET_MARKER_COOKIE_99999'));
      assert.ok(!JSON.stringify(err.details).includes('SECRET_MARKER_COOKIE_99999'));
      return true;
    },
  );
});

test('QOJ parses summary row strictly (ignoring test cases and source code), fails closed on wrong ID/missing identity, and guards baseline failure', async () => {
  // Partial 65/100 page where test case #1 has "Accepted" and source code contains "Accepted" & "Judgement Failed"!
  const trickyPartialHtml = `
    <html><body>
      <table>
        <tr>
          <td><a href="/submission/5001">#5001</a></td>
          <td><a href="/problem/7801">Ancient Tree</a></td>
          <td><a href="/user/profile/qoj_tester">qoj_tester</a></td>
          <td><a class="uoj-score">65/100</a></td>
          <td>320ms</td>
          <td>64MB</td>
        </tr>
      </table>
      <table>
        <tr><td>Test #1</td><td>Accepted</td><td>10ms</td></tr>
      </table>
      <pre><code>// Accepted Judgement Failed Time Limit Exceeded</code></pre>
    </body></html>
  `;
  const parsedPartial = parseQojSubmissionPage('5001', trickyPartialHtml);
  assert.ok(parsedPartial);
  assert.equal(parsedPartial.id, '5001');
  assert.equal(parsedPartial.score, 65);
  assert.equal(parsedPartial.max_score, 100);
  assert.equal(normalizeVerdict(parsedPartial.raw_verdict, parsedPartial.score, parsedPartial.max_score), 'partial');

  // Wrong submission ID returned (#999 instead of #7) & missing submitter must BOTH fail closed
  const wrongIdHtml = `
    <html><body><table><tr>
      <td><a href="/submission/999">#999</a></td>
      <td><a href="/problem/7801">Ancient Tree</a></td>
      <td><a href="/user/profile/qoj_tester">qoj_tester</a></td>
      <td><a class="uoj-score">100/100</a></td>
    </tr></table></body></html>
  `;
  const missingSubmitterHtml = `
    <html><body><table><tr>
      <td><a href="/submission/7">#7</a></td>
      <td><a href="/problem/7801">Ancient Tree</a></td>
      <td>anonymous</td>
      <td><a class="uoj-score">100/100</a></td>
    </tr></table></body></html>
  `;

  let postCount = 0;
  const mockFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/contest/1420') {
      // Cross-origin redirect on preview must be rejected
      if (url.searchParams.has('evil')) return redirectResponse('https://evil.example.test/steal');
      return htmlResponse(`
        <html><body>
          <h1>QOJ Regional</h1>
          <a href="https://evil.example.test/fake.pdf">Bad PDF</a>
          <a href="/contest/1420/statements.pdf">Good PDF</a>
          <a href="/contest/1420/problem/7801">1. Alpha</a>
          <a href="/problem/9999">Navbar Unrelated Problem</a>
        </body></html>
      `);
    }
    if (url.pathname === '/submission/7') return htmlResponse(wrongIdHtml);
    if (url.pathname === '/submission/8') return htmlResponse(missingSubmitterHtml);
    if (url.pathname === '/submission/5001') return htmlResponse(trickyPartialHtml);
    if (url.pathname === '/contest/1420/problem/7801' && (!init?.method || init.method === 'GET')) {
      return htmlResponse('<form><input type="hidden" name="_token" value="tok"><textarea name="answer_answer_editor"></textarea></form>');
    }
    if (url.pathname === '/submissions') {
      // Simulate baseline fetch failure!
      return htmlResponse('Internal Server Error', 500);
    }
    if (url.pathname === '/contest/1420/problem/7801' && init?.method === 'POST') {
      postCount++;
      // Redirects to /submissions without direct submission ID
      return redirectResponse('/submissions');
    }
    throw new Error(`Unexpected QOJ URL: ${url.href}`);
  };

  // Preview ignores cross-origin PDF and navbar unrelated problem
  const preview = await previewQojContest('qoj:1420', { fetchImpl: mockFetch });
  assert.equal(preview.statement_pdf_url, 'https://qoj.ac/contest/1420/statements.pdf');
  assert.deepEqual(
    preview.problems.map(p => p.remote_id),
    ['7801'],
  );

  const judge = createQojJudge(
    { contest_id: 'qoj:1420', handle: 'qoj_tester', languages: { cpp20: 'C++20' }, problem_map: { A: '7801' } },
    { cookie: 'UOJSESSID=test-qoj', fetchImpl: mockFetch, delayImpl: async () => {} },
  );

  // Valid partial verdict works cleanly
  const okVerdicts = await judge.verdicts(['5001'], new Map([['5001', 'A']]), AbortSignal.timeout(5000));
  assert.equal(okVerdicts.get('5001')?.verdict, 'partial');
  assert.equal(okVerdicts.get('5001')?.score, 65);

  // Wrong ID (#999 returned when querying #7) fails closed with identity_mismatch
  await assert.rejects(
    judge.verdicts(['7'], new Map([['7', 'A']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'identity_mismatch',
  );

  // Missing submitter profile fails closed with identity_mismatch
  await assert.rejects(
    judge.verdicts(['8'], new Map([['8', 'A']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'identity_mismatch',
  );

  // Failed baseline + redirect to /submissions MUST fail with submission_unconfirmed and NEVER retry POST
  await assert.rejects(
    judge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'submission_unconfirmed',
  );
  assert.equal(postCount, 1);
});

test('VJudge handles hyphenated OJ names, strict identity checks, FAILED/statusType=2 infra faults, and post-POST 5xx uncertainty', async () => {
  assert.deepEqual(parseUpstreamProblemRef('E-Olymp-1234'), { oj: 'E-Olymp', probNum: '1234' });
  assert.deepEqual(parseUpstreamProblemRef('Kattis-two-sum'), { oj: 'Kattis', probNum: 'two-sum' });
  assert.deepEqual(parseUpstreamProblemRef('AtCoder-abc300_a'), { oj: 'AtCoder', probNum: 'abc300_a' });
  assert.throws(() => parseUpstreamProblemRef('InvalidFormat'));

  let postCalls = 0;
  const mockFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/contest/567890') {
      // Timestamps in Unix seconds (< 1e12) should still normalize properly
      return htmlResponse(
        `<textarea name="dataJson">${JSON.stringify({
          id: 567890,
          title: 'Mixed Regional',
          begin: 1_700_000_000,
          end: 1_700_018_000,
          problems: [{ num: 'A', title: 'P1', oj: 'E-Olymp', probNum: '1234', weight: 100 }],
        })}</textarea>`,
      );
    }
    if (url.pathname === '/problem/submit') {
      postCalls++;
      const params = new URLSearchParams(String(init?.body ?? ''));
      const src = Buffer.from(params.get('source') ?? '', 'base64').toString('utf8');
      if (src === 'TRIGGER_502') return htmlResponse('<html>RAW_GATEWAY_HTML_MARKER</html>', 502);
      if (src === 'TRIGGER_TRUNCATED') return htmlResponse('{"runId": 123', 200);
      return jsonResponse({ runId: 445566 });
    }
    if (url.pathname === '/solution/data/445566') {
      return jsonResponse({
        runId: 445566,
        status: 'Partially Accepted',
        statusCanonical: 'PARTIAL',
        processing: false,
        score: 70,
        maxScore: 100,
        author: 'vj_bot',
        oj: 'E-Olymp',
        probNum: '1234',
      });
    }
    if (url.pathname === '/solution/data/445570') {
      return jsonResponse({
        runId: 445570,
        status: 'Submit Failed',
        statusCanonical: 'FAILED',
        statusType: 2,
        processing: false,
        author: 'vj_bot',
        oj: 'E-Olymp',
        probNum: '1234',
      });
    }
    if (url.pathname === '/solution/data/445571') {
      // Wrong runId returned!
      return jsonResponse({
        runId: 999999,
        status: 'Accepted',
        processing: false,
        author: 'vj_bot',
        oj: 'E-Olymp',
        probNum: '1234',
      });
    }
    if (url.pathname === '/solution/data/445572') {
      // Missing author!
      return jsonResponse({
        runId: 445572,
        status: 'Accepted',
        processing: false,
        oj: 'E-Olymp',
        probNum: '1234',
      });
    }
    throw new Error(`Unexpected VJudge URL: ${url.href}`);
  };

  const preview = await previewVjudgeContest(567890, { fetchImpl: mockFetch });
  assert.equal(preview.status, 'finished');
  assert.equal(preview.problems[0].upstream_oj, 'E-Olymp');

  const judge = createVjudgeJudge(
    { handle: 'vj_bot', languages: { cpp20: 'C++20' }, problem_map: { P1: 'E-Olymp-1234' } },
    { cookie: 'JSESSIONID=vj-session', fetchImpl: mockFetch },
  );

  // Post-POST 502 and truncated JSON must throw submission_unconfirmed, make only 1 POST, and leak zero HTML
  postCalls = 0;
  await assert.rejects(
    judge.submit('P1', 'cpp20', 'TRIGGER_502', AbortSignal.timeout(5000)),
    err => {
      assert.ok(err instanceof JudgeInfrastructureError);
      assert.equal(err.code, 'submission_unconfirmed');
      assert.ok(!err.message.includes('RAW_GATEWAY_HTML_MARKER'));
      return true;
    },
  );
  assert.equal(postCalls, 1);

  postCalls = 0;
  await assert.rejects(
    judge.submit('P1', 'cpp20', 'TRIGGER_TRUNCATED', AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'submission_unconfirmed',
  );
  assert.equal(postCalls, 1);

  // Valid submission + partial score
  assert.equal(await judge.submit('P1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), '445566');
  const vMap = await judge.verdicts(['445566'], new Map([['445566', 'P1']]), AbortSignal.timeout(5000));
  assert.equal(vMap.get('445566')?.verdict, 'partial');
  assert.equal(vMap.get('445566')?.score, 70);

  // FAILED / statusType === 2 throws JudgeInfrastructureError (never wrong_answer)
  await assert.rejects(
    judge.verdicts(['445570'], new Map([['445570', 'P1']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'upstream_unavailable',
  );

  // Wrong runId or missing author fails closed with identity_mismatch
  await assert.rejects(
    judge.verdicts(['445571'], new Map([['445571', 'P1']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'identity_mismatch',
  );
  await assert.rejects(
    judge.verdicts(['445572'], new Map([['445572', 'P1']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'identity_mismatch',
  );
});

test('Hydro uses real /p/<pid>/submit route, handles >100 partial scores, status 10, docId/pid matching, identity fail-closed, and post-POST 5xx', async () => {
  assert.equal(mapHydroStatus(HYDRO_STATUS.ETC, 50).infraError, true);
  assert.equal(mapHydroStatus(HYDRO_STATUS.ETC, 50).verdict, 'judge_error');
  assert.equal(mapHydroStatus(HYDRO_STATUS.WRONG_ANSWER, 150).verdict, 'partial');
  assert.equal(mapHydroStatus(HYDRO_STATUS.ACCEPTED, 100, 300).verdict, 'partial');

  const seenSubmitUrls = [];
  let postCount = 0;
  const mockFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/d/oi/contest/c100') {
      return jsonResponse({
        tdoc: { docId: 'c100', title: 'NOI Mock', beginAt: '2024-01-01T00:00:00.000Z', endAt: '2024-01-01T05:00:00.000Z', pids: ['42'] },
        pdict: { '42': { docId: 42, pid: 'P1001', title: 'Tree Query', maxScore: 300 } },
      });
    }
    if (url.pathname === '/d/oi/p/P1001/submit' && init?.method === 'POST') {
      postCount++;
      seenSubmitUrls.push(url.pathname + url.search);
      const body = JSON.parse(String(init.body));
      if (body.code === 'TRIGGER_500') return htmlResponse('<html>HYDRO_500_SECRET</html>', 500);
      return jsonResponse({ rid: 'rec-ioi-300' });
    }
    if (url.pathname === '/d/oi/record/rec-ioi-300') {
      // Note: rdoc.pid is numeric docId (42), while pdoc.pid is public 'P1001', and maxScore is omitted (>100 score!)
      return jsonResponse({
        rdoc: { _id: 'rec-ioi-300', status: HYDRO_STATUS.WRONG_ANSWER, score: 150, time: 900, memory: 8192, pid: 42 },
        pdoc: { docId: 42, pid: 'P1001' },
        udoc: { uname: 'hydro_bot' },
      });
    }
    if (url.pathname === '/d/oi/record/rec-status-10') {
      return jsonResponse({
        rdoc: { _id: 'rec-status-10', status: HYDRO_STATUS.ETC, score: 0, pid: 42 },
        pdoc: { docId: 42, pid: 'P1001' },
        udoc: { uname: 'hydro_bot' },
      });
    }
    if (url.pathname === '/d/oi/record/rec-wrong-id') {
      return jsonResponse({
        rdoc: { _id: 'rec-OTHER', status: HYDRO_STATUS.ACCEPTED, score: 100, pid: 42 },
        pdoc: { docId: 42, pid: 'P1001' },
        udoc: { uname: 'hydro_bot' },
      });
    }
    if (url.pathname === '/d/oi/record/rec-no-user') {
      return jsonResponse({
        rdoc: { _id: 'rec-no-user', status: HYDRO_STATUS.ACCEPTED, score: 100, pid: 42 },
        pdoc: { docId: 42, pid: 'P1001' },
      });
    }
    throw new Error(`Unexpected Hydro URL: ${url.href}`);
  };

  const preview = await previewHydroContest('c100', { baseUrl: 'http://127.0.0.1:8888', domain: 'oi', fetchImpl: mockFetch });
  assert.equal(preview.problems[0].remote_id, 'P1001');
  assert.equal(preview.problems[0].max_points, 300);

  // Default replay uses practice route /d/oi/p/P1001/submit (no ?tid)
  const practiceJudge = createHydroJudge(
    {
      base_url: 'http://127.0.0.1:8888',
      domain: 'oi',
      contest_id: 'c100',
      handle: 'hydro_bot',
      languages: { cpp20: 'cc.cc20o2' },
      problem_map: { A: 'P1001' },
    },
    { cookie: 'sid=abc; sid.sig=xyz', fetchImpl: mockFetch },
  );

  assert.equal(await practiceJudge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), 'rec-ioi-300');
  assert.equal(seenSubmitUrls[0], '/d/oi/p/P1001/submit');

  // Explicit live_contest: true attaches ?tid=c100
  const liveJudge = createHydroJudge(
    {
      base_url: 'http://127.0.0.1:8888',
      domain: 'oi',
      contest_id: 'c100',
      live_contest: true,
      handle: 'hydro_bot',
      languages: { cpp20: 'cc.cc20o2' },
      problem_map: { A: 'P1001' },
    },
    { cookie: 'sid=abc; sid.sig=xyz', fetchImpl: mockFetch },
  );
  assert.equal(await liveJudge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), 'rec-ioi-300');
  assert.equal(seenSubmitUrls[1], '/d/oi/p/P1001/submit?tid=c100');

  // Post-POST 500 throws submission_unconfirmed with only 1 POST and zero HTML leaked
  postCount = 0;
  await assert.rejects(
    practiceJudge.submit('A', 'cpp20', 'TRIGGER_500', AbortSignal.timeout(5000)),
    err => {
      assert.ok(err instanceof JudgeInfrastructureError);
      assert.equal(err.code, 'submission_unconfirmed');
      assert.ok(!err.message.includes('HYDRO_500_SECRET'));
      return true;
    },
  );
  assert.equal(postCount, 1);

  // >100 score partial verdict without fabricated 100 cap
  const verdicts = await practiceJudge.verdicts(['rec-ioi-300'], new Map([['rec-ioi-300', 'A']]), AbortSignal.timeout(5000));
  const v = verdicts.get('rec-ioi-300');
  assert.ok(v);
  assert.equal(v.verdict, 'partial');
  assert.equal(v.score, 150);
  assert.equal(v.max_score, undefined);

  // Hydro status 10 throws JudgeInfrastructureError
  await assert.rejects(
    practiceJudge.verdicts(['rec-status-10'], new Map([['rec-status-10', 'A']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'upstream_unavailable',
  );

  // Wrong record ID or missing submitter fails closed with identity_mismatch
  await assert.rejects(
    practiceJudge.verdicts(['rec-wrong-id'], new Map([['rec-wrong-id', 'A']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'identity_mismatch',
  );
  await assert.rejects(
    practiceJudge.verdicts(['rec-no-user'], new Map([['rec-no-user', 'A']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'identity_mismatch',
  );
});

test('Unified judge registry exposes all four backends, presets, factory, and preview dispatcher', async () => {
  const backends = listJudgeBackends();
  assert.deepEqual(
    backends.map(b => b.kind),
    ['codeforces', 'qoj', 'vjudge', 'hydro'],
  );
  for (const kind of ['codeforces', 'qoj', 'vjudge', 'hydro']) {
    assert.ok(languagePresetsFor(kind).length >= 5);
  }
  assert.ok(CODEFORCES_LANGUAGE_PRESETS.length >= 6);

  const cf = createProgramJudge(
    { kind: 'codeforces', contest_id: 1, handle: 'h', languages: { cpp20: 89 } },
    { cookie: 'a=b', skipContestCheck: true },
  );
  assert.equal(cf.kind, 'codeforces');

  const qoj = createProgramJudge({ kind: 'qoj', handle: 'h', languages: { cpp20: 'C++20' } }, { cookie: 'a=b' });
  assert.equal(qoj.kind, 'qoj');

  const vj = createProgramJudge({ kind: 'vjudge', handle: 'h', languages: { cpp20: 'C++20' } }, { cookie: 'a=b' });
  assert.equal(vj.kind, 'vjudge');

  const hydro = createProgramJudge(
    { kind: 'hydro', base_url: 'http://127.0.0.1:8888', handle: 'h', languages: { cpp20: 'cc.cc20o2' } },
    { cookie: 'sid=1; sid.sig=2' },
  );
  assert.equal(hydro.kind, 'hydro');

  await assert.rejects(previewContest('hydro', 'c1'), /requires opts\.baseUrl/);
});
