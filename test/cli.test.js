import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = (...args) => {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', env });
};

test('cr help prints the usable command', () => {
  const result = cli('bench', 'run', '--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /cr bench run/);
});

test('a missing credential fails preflight without starting a run', () => {
  const result = cli('bench', 'run', 'examples/demo/contest.json', '--agent', 'examples/demo/agent.json');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY/);
  assert.equal(result.stdout, '');
});
