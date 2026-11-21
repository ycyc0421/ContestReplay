import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInputs, modelKey } from '../dist/config.js';
import { Connections } from '../dist/connections.js';
import { inspectImage, codexImage } from '../dist/docker.js';
import { runBench } from '../dist/run.js';
import { exportRun } from '../dist/results.js';

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
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': req.headers.authorization });
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
    for (const event of events) res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const store = new Connections(join(out, 'connection-store'));
    const connection = await store.create({ label: 'Mock upstream', protocol: 'responses',
      base_url: 'http://127.0.0.1:'+server.address().port+'/v1', secret: 'local-test-key' });
    const effort = 'max';
    const path = join(out, 'agent.json');
    await writeFile(path, JSON.stringify({ kind: 'contestreplay.dev/agent', schema_version: 1, id: 'codex-max',
      model, connection: connection.id, harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: effort },
        env: { LANG: 'C.UTF-8' }, native_config: { format: 'toml', content: 'model_verbosity = "high"' } } }));
    const inputs = await loadInputs('examples/demo/contest.json', path, store);
    const result = await runBench(inputs, { out, image: await inspectImage(codexImage), key: await modelKey(inputs, store), signal: AbortSignal.timeout(45_000) });
    const log = await readFile(join(result.directory, 'events.jsonl'), 'utf8');
    const diagnostics = await readFile(join(result.directory, 'agent.stderr.log'), 'utf8') + await readFile(join(result.directory, 'agent.stdout.log'), 'utf8');
    assert.equal(result.status, 'completed', log + '\n' + diagnostics);
    assert.equal(result.reason, 'finish', log + '\n' + diagnostics);
    assert.equal(observed.length, 2);
    assert.match(JSON.stringify(observed[0].input), /data:image\/png;base64,/);
    assert.equal(observed[0].store, false);
    assert.equal(observed[0].reasoning.effort, effort);
    assert.equal(observed[0].text.verbosity, 'high');
    assert.ok(!log.includes('local-test-key'));
    assert.ok(!diagnostics.includes('local-test-key'));
    assert.ok(!JSON.stringify(await exportRun(out, result.runId)).includes('local-test-key'));
    const events = log.trim().split('\n').map(JSON.parse);
    assert.equal(events.find(event => event.type === 'model_response').request_id, 'Bearer [REDACTED]');
    assert.ok(events.some(event => event.type === 'model_timing' && typeof event.ttft_ms === 'number' && typeof event.duration_ms === 'number'));
    assert.equal(events.at(-1).score, 3);
    const runMeta = JSON.parse(await readFile(join(result.directory, 'run.json'), 'utf8'));
    assert.equal(runMeta.protocol_preset, 'short');
    assert.equal(runMeta.scoring_mode, 'last_ac');
    assert.deepEqual(runMeta.problems, [{ id: '1', max_points: 3 }, { id: '2', max_points: 5 }]);
    assert.deepEqual(runMeta.sandbox.resources, { memory: '4g', cpus: '2', pids: 256, workspace: '512m' });
    assert.equal(runMeta.model.speed_tier, 'standard');
    assert.equal(runMeta.session_archive_status, 'archived');
    assert.ok(Array.isArray(runMeta.session_files) && runMeta.session_files.length >= 1, JSON.stringify(runMeta));
    const archivedSessionPath = join(result.directory, 'session', ...runMeta.session_files[0].split('/'));
    assert.equal((await stat(archivedSessionPath)).mode & 0o777, 0o600);
    const archivedSessionText = await readFile(archivedSessionPath, 'utf8');
    assert.ok(archivedSessionText.length > 0);
    assert.ok(!archivedSessionText.includes('local-test-key'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(out, { recursive: true, force: true });
  }
});
