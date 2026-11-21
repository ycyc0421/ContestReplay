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

test('normalizeVerdict handles standard, partial, pending, and infrastructure verdicts', () => {
  assert.equal(normalizeVerdict('OK'), 'accepted');
  assert.equal(normalizeVerdict('Accepted'), 'accepted');
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
  assert.equal(normalizeVerdict('Judgement Failed'), 'judge_error');
  assert.equal(normalizeVerdict('Remote OJ Unavailable'), 'judge_error');
});

test('inferProblemMap covers exact, prefixed/normalized, numeric-to-alpha, alpha-to-numeric, positional, and unmapped cases', () => {
  // 1. Exact + normalized
  const exact = inferProblemMap(
    ['Problem A', 'B', 'Task C1'],
    [{ remote_id: 'A' }, { remote_id: 'B' }, { remote_id: 'C1' }],
  );
  assert.deepEqual(exact.problem_map, { 'Problem A': 'A', B: 'B', 'Task C1': 'C1' });
  assert.equal(exact.matches.find(m => m.local_id === 'B').confidence, 'exact');
  assert.equal(exact.matches.find(m => m.local_id === 'Problem A').confidence, 'high');
  assert.deepEqual(exact.unmapped_local, []);
  assert.deepEqual(exact.unmapped_remote, []);

  // 2. Numeric-to-alpha (1,2,3 -> A,B,C)
  const num2alpha = inferProblemMap(
    ['1', '2', '3'],
    [{ remote_id: 'A' }, { remote_id: 'B' }, { remote_id: 'C' }],
  );
  assert.deepEqual(num2alpha.problem_map, { '1': 'A', '2': 'B', '3': 'C' });
  assert.ok(num2alpha.matches.every(m => m.strategy === 'numeric_to_alpha' && m.confidence === 'high'));

  // 3. Prefixed P1, P2 -> A, B
  const p2alpha = inferProblemMap(['P1', 'P2'], [{ remote_id: 'A' }, { remote_id: 'B' }]);
  assert.deepEqual(p2alpha.problem_map, { P1: 'A', P2: 'B' });

  // 4. Alpha-to-numeric (A,B -> 1,2)
  const alpha2num = inferProblemMap(['A', 'B'], [{ remote_id: '1' }, { remote_id: '2' }]);
  assert.deepEqual(alpha2num.problem_map, { A: '1', B: '2' });
  assert.ok(alpha2num.matches.every(m => m.strategy === 'alpha_to_numeric'));

  // 5. Positional fallback when counts equal and remote IDs are QOJ numeric IDs
  const positional = inferProblemMap(
    ['A', 'B', 'C'],
    [{ remote_id: '7810' }, { remote_id: '7811' }, { remote_id: '7812' }],
  );
  assert.deepEqual(positional.problem_map, { A: '7810', B: '7811', C: '7812' });
  assert.ok(positional.matches.every(m => m.strategy === 'positional' && m.confidence === 'low'));

  // 6. Mismatched lengths leave unmapped entries
  const mismatch = inferProblemMap(
    ['A', 'B', 'C'],
    [{ remote_id: '7810' }, { remote_id: '7811' }],
  );
  assert.deepEqual(mismatch.problem_map, {});
  assert.deepEqual(mismatch.unmapped_local, ['A', 'B', 'C']);
  assert.deepEqual(mismatch.unmapped_remote, ['7810', '7811']);
});

test('extractProblemLabelsFromText detects PDF headings accurately', () => {
  const sampleText = `
    ICPC Regional Contest 2025
    Problem A. Two Sum
    Time limit: 2 seconds
    Problem B1: Matrix Chains
    Task C - Graph Walk
    D. Final Boss
    P5. Bonus Task
  `;
  assert.deepEqual(extractProblemLabelsFromText(sampleText), ['A', 'B1', 'C', 'D', 'P5']);
});

test('Codeforces adapter supports both regular and Gym contests, cookie correlation, preview, and external submitter', async t => {
  // Regular + Gym form and receipt parsing
  const regularHtml =
    '<a href="/profile/cf_tester">cf_tester</a><form action="/contest/1234/submit"><input type="hidden" name="csrf_token" value="tok1"><select name="submittedProblemIndex"></select><textarea name="source"></textarea></form>';
  assert.equal(cfFormForContest(regularHtml, 1234, 'cf_tester').fields.get('csrf_token'), 'tok1');
  assert.equal(cfReceiptForContest('/contest/1234/submission/987654', 1234), '987654');

  const gymHtml =
    '<a href="/profile/cf_tester">cf_tester</a><form action="/gym/104567/submit"><input type="hidden" name="csrf_token" value="gymtok"><select name="submittedProblemIndex"></select><textarea name="source"></textarea></form>';
  assert.equal(cfFormForContest(gymHtml, 104567, 'cf_tester', { gym: true }).fields.get('csrf_token'), 'gymtok');
  assert.equal(cfReceiptForContest('/gym/104567/submission/555111', 104567, { gym: true }), '555111');
  assert.equal(cfReceiptForContest('/contest/104567/submission/555111', 104567, { gym: true }), undefined);

  // Mock fetch for Gym preview + cookie submission via /gym/<id>/my correlation + verdict polling
  let submitted = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const mockFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/contest.standings') {
      return jsonResponse({
        status: 'OK',
        result: {
          contest: { id: 104567, name: '2024 ICPC Regional Gym', phase: 'FINISHED' },
          problems: [
            { index: 'A', name: 'Alpha', points: 500 },
            { index: 'B', name: 'Beta', points: 1000 },
          ],
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
      const rows = submitted
        ? [
            {
              id: 888002,
              contestId: 104567,
              problem: { index: 'A', contestId: 104567, points: 500 },
              author: { participantType: 'PRACTICE', members: [{ handle: 'cf_tester' }] },
              creationTimeSeconds: nowSec,
              verdict: 'OK',
              timeConsumedMillis: 46,
              memoryConsumedBytes: 1024 * 256,
            },
            {
              id: 888001,
              contestId: 104567,
              problem: { index: 'B', contestId: 104567 },
              author: { participantType: 'PRACTICE', members: [{ handle: 'cf_tester' }] },
              creationTimeSeconds: nowSec - 100,
              verdict: 'WRONG_ANSWER',
            },
          ]
        : [
            {
              id: 888001,
              contestId: 104567,
              problem: { index: 'B', contestId: 104567 },
              author: { participantType: 'PRACTICE', members: [{ handle: 'cf_tester' }] },
              creationTimeSeconds: nowSec - 100,
              verdict: 'WRONG_ANSWER',
            },
          ];
      return jsonResponse({ status: 'OK', result: rows });
    }
    throw new Error(`Unexpected URL: ${url.href}`);
  };

  const preview = await previewCodeforcesContest(104567, { gym: true, fetchImpl: mockFetch });
  assert.equal(preview.platform, 'codeforces');
  assert.equal(preview.contest_ref, 'gym:104567');
  assert.equal(preview.status, 'finished');
  assert.equal(preview.problems.length, 2);
  assert.equal(preview.problems[0].max_points, 500);
  assert.ok(preview.suggested_languages.length >= CODEFORCES_LANGUAGE_PRESETS.length);

  const judge = createCodeforcesJudge(
    {
      contest_id: 104567,
      gym: true,
      handle: 'cf_tester',
      languages: { cpp20: 89 },
      problem_map: { '1': 'A' },
    },
    {
      cookie: 'JSESSIONID=test-gym-cookie',
      fetchImpl: mockFetch,
      delayImpl: async () => {},
    },
  );
  assert.equal(judge.kind, 'codeforces');
  const subId = await judge.submit('1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000));
  assert.equal(subId, '888002');

  const verdicts = await judge.verdicts(['888002'], new Map([['888002', '1']]), AbortSignal.timeout(5000));
  const v = verdicts.get('888002');
  assert.ok(v);
  assert.equal(v.verdict, 'accepted');
  assert.equal(v.final, true);
  assert.equal(v.time_ms, 46);
  assert.equal(v.memory_kb, 256);

  // External submitter script test
  const dir = await mkdtemp(join(tmpdir(), 'cr-cf-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execPath = join(dir, 'submitter.mjs');
  await writeFile(
    execPath,
    `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const [contestId, problem, langId, srcFile, handle, gymFlag] = process.argv.slice(2);
const src = readFileSync(srcFile, 'utf8');
if (contestId === '104567' && problem === 'A' && langId === '89' && handle === 'cf_tester' && gymFlag === '--gym' && src.includes('main')) {
  process.stdout.write(JSON.stringify({ submission_id: '999001' }));
} else {
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  await chmod(execPath, 0o755);

  const execJudge = createCodeforcesJudge(
    { contest_id: 104567, gym: true, handle: 'cf_tester', languages: { cpp20: 89 }, problem_map: { '1': 'A' } },
    { executable: execPath, fetchImpl: mockFetch, skipContestCheck: true },
  );
  assert.equal(await execJudge.submit('1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), '999001');
});

test('QOJ adapter handles contest preview, CSRF cookie submission, IOI partial score, and Judgement Failed', async t => {
  const contestHtml = `
    <html><head><title>ICPC World Finals - QOJ</title></head><body>
      <h1>ICPC World Finals 2025</h1>
      <p>Contest Ended</p>
      <a href="/contest/1420/statements.pdf">Download Statements</a>
      <a href="/contest/1420/problem/7801">1. Ancient Tree</a>
      <a href="/contest/1420/problem/7802">2. Binary Bridges</a>
    </body></html>
  `;
  const submitPageHtml = `
    <html><body>
      <form method="post">
        <input type="hidden" name="_token" value="qoj-csrf-token-123" />
        <textarea name="answer_answer_editor"></textarea>
      </form>
    </body></html>
  `;
  const partialHtml = `
    <html><body><table><tr>
      <td><a href="/submission/5001">#5001</a></td>
      <td><a href="/problem/7801">Ancient Tree</a></td>
      <td><a href="/user/profile/qoj_tester">qoj_tester</a></td>
      <td><a class="uoj-score">65/100</a></td>
      <td>320ms</td>
      <td>64MB</td>
    </tr></table><div>Wrong Answer on test 12</div></body></html>
  `;
  const judgeFailHtml = `
    <html><body><table><tr>
      <td><a href="/submission/5002">#5002</a></td>
      <td><a href="/problem/7801">Ancient Tree</a></td>
      <td><a href="/user/profile/qoj_tester">qoj_tester</a></td>
      <td>Judgement Failed</td>
      <td>0ms</td>
      <td>0KB</td>
    </tr></table></body></html>
  `;

  let postedToken = '';
  const mockFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/contest/1420') return htmlResponse(contestHtml);
    if (url.pathname === '/contest/1420/problem/7801' && (!init?.method || init.method === 'GET')) {
      return htmlResponse(submitPageHtml);
    }
    if (url.pathname === '/submissions') {
      return htmlResponse('<table></table>');
    }
    if (url.pathname === '/contest/1420/problem/7801' && init?.method === 'POST') {
      const params = new URLSearchParams(String(init.body));
      postedToken = params.get('_token') ?? '';
      return redirectResponse('/submission/5001');
    }
    if (url.pathname === '/submission/5001') return htmlResponse(partialHtml);
    if (url.pathname === '/submission/5002') return htmlResponse(judgeFailHtml);
    throw new Error(`Unexpected QOJ URL: ${url.href}`);
  };

  const preview = await previewQojContest(1420, { fetchImpl: mockFetch });
  assert.equal(preview.platform, 'qoj');
  assert.equal(preview.contest_ref, 'qoj:1420');
  assert.equal(preview.title, 'ICPC World Finals 2025');
  assert.equal(preview.status, 'finished');
  assert.equal(preview.statement_pdf_url, 'https://qoj.ac/contest/1420/statements.pdf');
  assert.deepEqual(
    preview.problems.map(p => p.remote_id),
    ['7801', '7802'],
  );

  // Test through OjAccounts store + OjAccountPool
  const prevStorage = process.env.CR_CREDENTIAL_STORAGE;
  process.env.CR_CREDENTIAL_STORAGE = 'file';
  const dir = await mkdtemp(join(tmpdir(), 'cr-qoj-acc-'));
  t.after(async () => {
    if (prevStorage === undefined) delete process.env.CR_CREDENTIAL_STORAGE;
    else process.env.CR_CREDENTIAL_STORAGE = prevStorage;
    await rm(dir, { recursive: true, force: true });
  });
  const store = new OjAccounts(join(dir, 'oj'));
  await store.create({
    id: 'qoj-acc-1',
    label: 'QOJ Bot',
    platform: 'qoj',
    handle: 'qoj_tester',
    transport: 'cookie',
    secret: 'UOJSESSID=qoj-cookie-xyz',
  });
  const pool = new OjAccountPool(store);

  const judge = createQojJudge(
    {
      contest_id: 1420,
      handle: 'qoj_tester',
      account_id: 'qoj-acc-1',
      languages: { cpp20: 'C++20' },
      problem_map: { A: '7801' },
    },
    { accounts: store, pool, fetchImpl: mockFetch },
  );

  const subId = await judge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000));
  assert.equal(subId, '5001');
  assert.equal(postedToken, 'qoj-csrf-token-123');

  const verdicts = await judge.verdicts(['5001'], new Map([['5001', 'A']]), AbortSignal.timeout(5000));
  const v = verdicts.get('5001');
  assert.ok(v);
  assert.equal(v.verdict, 'partial');
  assert.equal(v.score, 65);
  assert.equal(v.max_score, 100);
  assert.equal(v.time_ms, 320);
  assert.equal(v.memory_kb, 65536);

  // Judgement Failed must throw JudgeInfrastructureError (never wrong_answer)
  await assert.rejects(
    judge.verdicts(['5002'], new Map([['5002', 'A']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'upstream_unavailable',
  );

  // Direct JSON submission parse test
  const parsedJsonRow = parseQojSubmissionPage('5003', JSON.stringify({ id: 5003, status: 'Accepted', score: 100, max_score: 100 }));
  assert.equal(parsedJsonRow.score, 100);
});

test('VJudge adapter supports contest & mixed-OJ modes, partial score, and classifies infra faults as JudgeInfrastructureError', async () => {
  assert.deepEqual(parseUpstreamProblemRef('AtCoder-abc300_a'), { oj: 'AtCoder', probNum: 'abc300_a' });
  assert.throws(() => parseUpstreamProblemRef('InvalidFormat'));

  const contestPageHtml = `
    <html><body>
      <textarea name="dataJson">${JSON.stringify({
        id: 567890,
        title: 'Mixed Regional Training',
        begin: 1_700_000_000_000,
        end: 1_700_018_000_000,
        problems: [
          { num: 'A', title: 'CF Problem', oj: 'CodeForces', probNum: '1234A', weight: 1 },
          { num: 'B', title: 'QOJ Problem', oj: 'QOJ', probNum: '1420', weight: 100 },
        ],
      })}</textarea>
    </body></html>
  `;

  let lastEndpoint = '';
  let lastBody = '';
  const mockFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/contest/567890') return htmlResponse(contestPageHtml);
    if (url.pathname === '/problem/submit' || url.pathname === '/contest/submit') {
      lastEndpoint = url.pathname;
      lastBody = String(init?.body ?? '');
      const params = new URLSearchParams(lastBody);
      const decodedSource = Buffer.from(params.get('source') ?? '', 'base64').toString('utf8');
      if (decodedSource.includes('TRIGGER_CAPTCHA')) {
        return jsonResponse({ captcha: true, error: 'Captcha required' });
      }
      if (decodedSource.includes('TRIGGER_429')) {
        return jsonResponse({ error: 'Too frequent' }, 429);
      }
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
        runtime: 125,
        memory: 8192,
        author: 'vj_bot',
        oj: 'QOJ',
        probNum: '1420',
      });
    }
    if (url.pathname === '/solution/data/445567') {
      return jsonResponse({
        runId: 445567,
        status: 'Remote OJ Unavailable',
        processing: false,
        author: 'vj_bot',
      });
    }
    if (url.pathname === '/solution/data/445568') {
      return jsonResponse({
        runId: 445568,
        status: 'Submit Failed',
        processing: false,
        author: 'vj_bot',
      });
    }
    throw new Error(`Unexpected VJudge URL: ${url.href}`);
  };

  const preview = await previewVjudgeContest(567890, { fetchImpl: mockFetch });
  assert.equal(preview.platform, 'vjudge');
  assert.equal(preview.contest_ref, 'vjudge:567890');
  assert.equal(preview.status, 'finished');
  assert.equal(preview.problems[0].upstream_oj, 'CodeForces');
  assert.equal(preview.problems[1].upstream_problem, '1420');

  // Direct/mixed upstream problem mode
  const directJudge = createVjudgeJudge(
    {
      handle: 'vj_bot',
      languages: { cpp20: 'C++20' },
      problem_map: { P1: 'QOJ-1420' },
    },
    { cookie: 'JSESSIONID=vj-session-token', fetchImpl: mockFetch },
  );
  assert.equal(directJudge.settlementMs, 300_000);

  const runId = await directJudge.submit('P1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000));
  assert.equal(runId, '445566');
  assert.equal(lastEndpoint, '/problem/submit');
  assert.match(lastBody, /oj=QOJ/);
  assert.match(lastBody, /probNum=1420/);

  const verdicts = await directJudge.verdicts(['445566'], new Map([['445566', 'P1']]), AbortSignal.timeout(5000));
  const v = verdicts.get('445566');
  assert.ok(v);
  assert.equal(v.verdict, 'partial');
  assert.equal(v.score, 70);
  assert.equal(v.max_score, 100);

  // Infrastructure faults must throw JudgeInfrastructureError (never wrong_answer)
  await assert.rejects(
    directJudge.submit('P1', 'cpp20', 'TRIGGER_CAPTCHA', AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'captcha_required',
  );
  await assert.rejects(
    directJudge.submit('P1', 'cpp20', 'TRIGGER_429', AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'rate_limited',
  );
  await assert.rejects(
    directJudge.verdicts(['445567'], new Map([['445567', 'P1']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'upstream_unavailable',
  );
  await assert.rejects(
    directJudge.verdicts(['445568'], new Map([['445568', 'P1']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'upstream_unavailable',
  );

  // Contest mode submission hits /contest/submit
  const contestJudge = createVjudgeJudge(
    {
      contest_id: 567890,
      handle: 'vj_bot',
      languages: { cpp20: 'C++20' },
      problem_map: { '1': 'A' },
    },
    { cookie: 'JSESSIONID=vj-session-token', fetchImpl: mockFetch },
  );
  assert.equal(await contestJudge.submit('1', 'cpp20', 'int main(){}', AbortSignal.timeout(5000)), '445566');
  assert.equal(lastEndpoint, '/contest/submit');
  assert.match(lastBody, /contestId=567890/);
  assert.match(lastBody, /num=A/);
});

test('Hydro adapter supports self-hosted domain, JSON API submission, numeric status codes, partial score and system error', async () => {
  assert.equal(mapHydroStatus(HYDRO_STATUS.ACCEPTED, 100, 100).verdict, 'accepted');
  assert.equal(mapHydroStatus(HYDRO_STATUS.WRONG_ANSWER, 40, 100).verdict, 'partial');
  assert.equal(mapHydroStatus(HYDRO_STATUS.WRONG_ANSWER, 0, 100).verdict, 'wrong_answer');
  assert.equal(mapHydroStatus(HYDRO_STATUS.TIME_LIMIT_EXCEEDED, 0, 100).verdict, 'time_limit_exceeded');
  assert.equal(mapHydroStatus(HYDRO_STATUS.MEMORY_LIMIT_EXCEEDED, 0, 100).verdict, 'memory_limit_exceeded');
  assert.equal(mapHydroStatus(HYDRO_STATUS.RUNTIME_ERROR, 0, 100).verdict, 'runtime_error');
  assert.equal(mapHydroStatus(HYDRO_STATUS.COMPILE_ERROR, 0, 100).verdict, 'compilation_error');
  assert.equal(mapHydroStatus(HYDRO_STATUS.WAITING).verdict, 'pending');
  assert.equal(mapHydroStatus(HYDRO_STATUS.JUDGING).verdict, 'pending');
  assert.equal(mapHydroStatus(HYDRO_STATUS.COMPILING).verdict, 'pending');
  assert.equal(mapHydroStatus(HYDRO_STATUS.FETCHED).verdict, 'pending');
  assert.equal(mapHydroStatus(HYDRO_STATUS.SYSTEM_ERROR).infraError, true);

  const mockFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/d/oi/contest/c100') {
      return jsonResponse({
        tdoc: {
          docId: 'c100',
          title: 'NOI Mock Round',
          beginAt: '2024-01-01T00:00:00.000Z',
          endAt: '2024-01-01T05:00:00.000Z',
          pids: ['P1001', 'P1002'],
        },
        pdict: {
          P1001: { pid: 'P1001', title: 'Tree Query', maxScore: 100 },
          P1002: { pid: 'P1002', title: 'Graph Flow', maxScore: 100 },
        },
      });
    }
    if (url.pathname === '/d/oi/contest/c100/p/P1001/submit' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.lang, 'cc.cc20o2');
      return jsonResponse({ rid: '65f0a1b2c3d4e5f60718293a' });
    }
    if (url.pathname === '/d/oi/record/65f0a1b2c3d4e5f60718293a') {
      return jsonResponse({
        rdoc: {
          _id: '65f0a1b2c3d4e5f60718293a',
          status: HYDRO_STATUS.TIME_LIMIT_EXCEEDED,
          score: 55,
          time: 1005,
          memory: 16384,
          pid: 'P1001',
        },
        pdoc: { pid: 'P1001', maxScore: 100 },
        udoc: { uname: 'hydro_bot' },
      });
    }
    if (url.pathname === '/d/oi/record/rec-sys-err') {
      return jsonResponse({
        rdoc: { _id: 'rec-sys-err', status: HYDRO_STATUS.SYSTEM_ERROR, score: 0, pid: 'P1001' },
        udoc: { uname: 'hydro_bot' },
      });
    }
    throw new Error(`Unexpected Hydro URL: ${url.href}`);
  };

  const preview = await previewHydroContest('c100', {
    baseUrl: 'http://127.0.0.1:8888',
    domain: 'oi',
    fetchImpl: mockFetch,
  });
  assert.equal(preview.platform, 'hydro');
  assert.equal(preview.contest_ref, 'hydro:oi:c100');
  assert.equal(preview.status, 'finished');
  assert.equal(preview.problems.length, 2);

  const judge = createHydroJudge(
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

  const rid = await judge.submit('A', 'cpp20', 'int main(){}', AbortSignal.timeout(5000));
  assert.equal(rid, '65f0a1b2c3d4e5f60718293a');

  const verdicts = await judge.verdicts([rid], new Map([[rid, 'A']]), AbortSignal.timeout(5000));
  const v = verdicts.get(rid);
  assert.ok(v);
  assert.equal(v.verdict, 'partial');
  assert.equal(v.score, 55);
  assert.equal(v.max_score, 100);
  assert.equal(v.time_ms, 1005);
  assert.equal(v.memory_kb, 16384);

  await assert.rejects(
    judge.verdicts(['rec-sys-err'], new Map([['rec-sys-err', 'A']]), AbortSignal.timeout(5000)),
    err => err instanceof JudgeInfrastructureError && err.code === 'upstream_unavailable',
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

  const cf = createProgramJudge(
    { kind: 'codeforces', contest_id: 1, handle: 'h', languages: { cpp20: 89 } },
    { cookie: 'a=b', skipContestCheck: true },
  );
  assert.equal(cf.kind, 'codeforces');

  const qoj = createProgramJudge(
    { kind: 'qoj', handle: 'h', languages: { cpp20: 'C++20' } },
    { cookie: 'a=b' },
  );
  assert.equal(qoj.kind, 'qoj');

  const vj = createProgramJudge(
    { kind: 'vjudge', handle: 'h', languages: { cpp20: 'C++20' } },
    { cookie: 'a=b' },
  );
  assert.equal(vj.kind, 'vjudge');

  const hydro = createProgramJudge(
    { kind: 'hydro', base_url: 'http://127.0.0.1:8888', handle: 'h', languages: { cpp20: 'cc.cc20o2' } },
    { cookie: 'sid=1; sid.sig=2' },
  );
  assert.equal(hydro.kind, 'hydro');

  await assert.rejects(previewContest('hydro', 'c1'), /requires opts\.baseUrl/);
});
