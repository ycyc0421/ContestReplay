import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInputs } from '../dist/config.js';
import { inspectImage, codexImage } from '../dist/docker.js';
import { runBench } from '../dist/run.js';

const enabled = process.env.CR_TEST_CODEX === '1';
test('actual Codex reads full PDF page images and submits over MCP in a no-network container', { skip: !enabled, timeout: 60_000 }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'cr-codex-test-'));
  const observed = [];
  const model = 'gpt-5.3-codex';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    observed.push(request);
    const turn = observed.length;
    const verb = turn === 1 ? 'submit' : 'finish';
    const tool = request.tools?.find(t => t.name?.endsWith('__' + verb)) ?? request.tools?.find(t => t.type === 'namespace' && t.tools?.some(inner => inner.name === verb));
    const namespace = tool?.type === 'namespace' ? tool.name : undefined;
    const name = namespace ? verb : tool?.name;
    if (req.url !== '/v1/responses' || req.headers.authorization !== 'Bearer local-test-key' || !name || turn > 2) {
      res.writeHead(400).end('{}'); return;
    }
    const item = { type: 'function_call', id: 'fc_'+turn, call_id: 'call_'+turn, name, ...(namespace ? { namespace } : {}),
      arguments: JSON.stringify(turn === 1 ? { problem_id: '1', answer: '3' } : {}), status: 'completed' };
    const response = { id: 'resp_'+turn, object: 'response', model, created_at: 1, status: 'completed', output: [item],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
    for (const event of events) res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const inputs = await loadInputs('examples/demo/contest.json', 'examples/demo/codex.toml');
    inputs.profile.base_url = 'http://127.0.0.1:'+server.address().port+'/v1';
    const result = await runBench(inputs, { out, image: await inspectImage(codexImage), key: 'local-test-key', signal: AbortSignal.timeout(45_000) });
    const log = await readFile(join(result.directory, 'events.jsonl'), 'utf8');
    const diagnostics = await readFile(join(result.directory, 'agent.stderr.log'), 'utf8') + await readFile(join(result.directory, 'agent.stdout.log'), 'utf8');
    assert.equal(result.status, 'completed', log + '\n' + diagnostics);
    assert.equal(result.reason, 'finish', log + '\n' + diagnostics);
    assert.equal(observed.length, 2);
    assert.match(JSON.stringify(observed[0].input), /data:image\/png;base64,/);
    assert.equal(observed[0].store, false);
    const events = log.trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).score, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(out, { recursive: true, force: true });
  }
});
