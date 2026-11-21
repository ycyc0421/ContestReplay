import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadInputs } from '../dist/config.js';
import { match } from '../dist/match.js';
import { cfForm, cfReceipt } from '../dist/cf-web.js';
import { exactPracticeCandidates } from '../dist/codeforces.js';
import { exportRun, mergeResults, rankResults } from '../dist/results.js';
import { assertCompatible } from '../dist/plan.js';
import { checkModelRequest } from '../dist/codex.js';

test('program judge stays pending without blocking and settles against the received timestamp', async () => {
  const inputs = await loadInputs('examples/demo/contest.json', 'examples/demo/codex.toml');
  inputs.contest.judge = { kind: 'codeforces', contest_id: 4, languages: { cpp17: 54 } };
  let now = 0;
  let ready = false;
  const events = [];
  const fake = { submit: async () => 321, verdicts: async () => ready ? new Map([[321, 'OK']]) : new Map() };
  const m = match(inputs, e => events.push({ elapsed: now, ...e }), fake, () => now, 10);
  assert.throws(() => assertCompatible('builtin-responses', inputs.contest, 'baseline'), /Incompatible cell/);
  try {
    now = 17;
    assert.deepEqual(m.submit({ problem_id: '1', language: 'cpp17', source: 'int main(){}' }), { submission_id: 's1', verdict: 'pending' });
    assert.deepEqual(m.status('s1'), { submission_id: 's1', verdict: 'pending' });
    m.close();
    assert.equal(m.submit({ problem_id: '1', language: 'cpp17', source: 'int main(){}' }).verdict, 'contest_closed');
    now = 40;
    ready = true;
    await m.settle(AbortSignal.timeout(1000));
    assert.equal(m.score(), 3);
    assert.equal(events.find(e => e.type === 'submission_received').elapsed, 17);
    assert.equal(events.find(e => e.type === 'submission_judged').remote_submission_id, 321);
  } finally { await m.dispose(); }
});

test('Codeforces requires intended form and matches post-baseline Practice rows', () => {
  const markup = '<a href="/profile/cr-test">cr-test</a><form action="/contest/4/submit"><input type="hidden" name="csrf_token" value="fixture"><select name="submittedProblemIndex"></select><textarea name="source"></textarea></form>';
  assert.equal(cfForm(markup, 4, 'cr-test').fields.get('csrf_token'), 'fixture');
  assert.throws(() => cfForm(markup.replace('/contest/4/submit', 'https://example.com/contest/4/submit'), 4, 'cr-test'));
  assert.equal(cfReceipt('/contest/4/submission/99', 4), 99);
  assert.equal(cfReceipt('https://example.com/contest/4/submission/99', 4), undefined);
  const row = { id: 99, creationTimeSeconds: 50, contestId: 4, problem: { index: 'A' }, author: { participantType: 'PRACTICE', members: [{ handle: 'cr-test' }] } };
  assert.deepEqual(exactPracticeCandidates([row, { ...row, id: 97 }, { ...row, id: 100, contestId: 8 }],
    { baseline: 98, contest: 4, problem: 'A', since: 49, handle: 'cr-test' }), [99]);
});

test('relay rejects a different model and remote tools/files', () => {
  assert.throws(() => checkModelRequest({ model: 'other' }, 'expected'));
  assert.throws(() => checkModelRequest({ model: 'expected', tools: [{ type: 'web_search' }] }, 'expected'));
  assert.throws(() => checkModelRequest({ model: 'expected', input: [{ type: 'input_file', file_id: 'file-x' }] }, 'expected'));
  assert.equal(checkModelRequest({ model: 'expected', store: true }, 'expected').store, false);
});

test('result export omits raw answers/logs, merges by run and ranks Agent revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run_id = randomUUID(), dir = join(root, run_id), hash = 'a'.repeat(64);
  await mkdir(dir);
  await writeFile(join(dir, 'run.json'), JSON.stringify({ run_id, contest_id: 'demo', data_version: 1, input_sha256: { contest: hash },
    protocol_id: 'test', protocol_version: 2, protocol_sha256: hash, agent_id: 'a', agent_revision: hash, harness: { kind: 'codex', version: 'test' },
    model: { model: 'fixture', model_family_id: 'family', base_url: 'private' }, local_inputs: { pdf: '/private' } }));
  const events = [{ type: 'submission_received', submission_id: 's1', problem_id: 'A', elapsed_ms: 100, source: 'private code' },
    { type: 'submission_judged', submission_id: 's1', verdict: 'OK' }, { type: 'run_ended', status: 'completed', score: 1, max_score: 2 }];
  await writeFile(join(dir, 'events.jsonl'), events.map((e, i) => JSON.stringify({ schema_version: 1, seq: i+1, ...e })).join('\n')+'\n');
  const first = await exportRun(root, run_id);
  assert.doesNotMatch(JSON.stringify(first), /private/);
  const second = { ...first, run_id: randomUUID(), agent_revision: 'b'.repeat(64), score: 2 };
  const bundle = { schema_version: 1, results: [first, second] };
  assert.equal(mergeResults([bundle, bundle]).results.length, 2);
  assert.deepEqual(rankResults(bundle, 'family')[0].map(row => row.result.score), [2, 1]);
  assert.deepEqual(rankResults(bundle, 'another'), []);
});
