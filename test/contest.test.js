import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInputs } from '../dist/config.js';
import { createContest } from '../dist/contest.js';

const sample = () => loadInputs('examples/demo/contest.json', 'examples/demo/agent.json');

test('loads the example with relative paths and pinned hashes', async () => {
  const input = await sample();
  assert.equal(input.judge.problems.length, 2);
  assert.equal(input.profile.model, 'gpt-4.1-2025-04-14');
});

test('records mistakes before first acceptance and never scores twice', async () => {
  const { judge } = await sample();
  let clock = 1000;
  const events = [];
  const c = createContest(judge, event => events.push(event), { maxSubmissions: 3, timeLimitMs: 100 }, () => clock);
  assert.equal(c.submit('1', '2').verdict, 'wrong_answer');
  clock += 30;
  assert.equal(c.submit('1', ' 3 ').verdict, 'accepted');
  assert.equal(c.submit('1', '3').verdict, 'already_accepted');
  assert.equal(c.submit('2', '12').verdict, 'submission_limit');
  assert.equal(events[2].elapsed_ms, 30);
  assert.equal(c.score(), 3);
  assert.equal(c.finish().status, 'finished');
  assert.equal(c.submit('2', '12').verdict, 'contest_closed');
});

test('does not accept submissions on or after the deadline', async () => {
  const { judge } = await sample();
  let clock = 0;
  const c = createContest(judge, () => assert.fail('No late events'), { maxSubmissions: 3, timeLimitMs: 100 }, () => clock);
  clock = 100;
  assert.equal(c.submit('1', '3').verdict, 'contest_closed');
  assert.equal(c.score(), 0);
});
