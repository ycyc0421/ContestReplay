#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAgent, loadContest, modelKey } from './config.js';
import { makePlan, planFromFile, planSchema, readJson } from './plan.js';
import { saveAgent, saveContest, codeforcesContest } from './author.js';
import { exportBatch, exportRun, mergeResults, rankResults } from './results.js';
import { dispatch, enqueue, getBatch, listBatches, lookupRun, readRunLog, requestBatchStop, requestRunCancel, summarize, workdir } from './queue.js';

const usage = `Usage:
  cr bench run <contest.json> --agent <agent.toml> [--out <dir>]
  cr contest init <contest.json> --pdf <relative-path> --answers <relative-path> [--id <id>] [--title <title>]
  cr contest import-codeforces <contest.json> --contest <number> --pdf <path> --handle <handle> --languages <json>
  cr contest validate <contest.json>
  cr agent init <agent.toml> --id <id> --harness <kind> --model <model> [--api <protocol>] [--base-url <url>] [--key-env <name>] [--reasoning-effort <level>] [--family <id>]
  cr agent validate <agent.toml>
  cr batch plan <batch.json> [--out <plan.json>]
  cr batch run <plan.json> [--workspace <dir>] [--json]
  cr batch resume <batch-id> [--workspace <dir>] [--json]
  cr batch status [batch-id] [--workspace <dir>] [--json]
  cr batch stop <batch-id> [--workspace <dir>]
  cr run show <run-id> [--workspace <dir>]
  cr run logs <run-id> [--stream stdout|stderr] [--follow] [--workspace <dir>]
  cr run cancel <run-id> [--workspace <dir>]
  cr results export (--batch <id> | --run <id>) [--workspace <dir>] [--out <file>]
  cr results merge <results.json>... [--out <file>]
  cr results rank <results.json> [--family <id>]
  cr studio [--workspace <dir>] [--port <number>]`;
const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));
function position(list: string[], optional = false) {
  if (list.length > 1 || (!optional && list.length !== 1)) throw new Error(usage);
  return list[0];
}
async function abortable<T>(fn: (signal: AbortSignal) => Promise<T>) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try { return await fn(abort.signal); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

async function main(args: string[]) {
  let started = false;
  try {
    const [group, command, ...rest] = args;
    if (!group || args.includes('--help') || args.includes('-h') ||
        (args.length === 1 && ['bench', 'batch', 'run', 'contest', 'agent'].includes(group))) {
      console.log(usage); return 0;
    }
    if (group === 'bench' && command === 'run') {
      if (!rest.length) { console.log(usage); return 0; }
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { agent: str, out: str } });
      const file = position(positionals)!;
      if (!values.agent || values.out === '') throw new Error(usage);
      const root = workdir(values.out);
      modelKey((await loadAgent(values.agent)).profile);
      const plan = await makePlan({ schema_version: 1, agents: [values.agent], contests: [file] }, process.cwd());
      const { id: batchId } = await enqueue(root, plan);
      const batch = await abortable(signal => dispatch(root, batchId, signal, { onJobStart: (id, directory) => {
        started = true;
        console.log(`run_id=${id}\nrun_dir=${directory}`);
      } }));
      const result = batch.jobs[0]!;
      console.log(`${result.status}: ${result.reason}`);
      return result.status === 'completed' ? 0 : 2;
    }
    if (group === 'contest' && command === 'init') {
      const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { pdf: str, answers: str, id: str, title: str } });
      const out = position(positionals)!;
      if (!v.pdf || !v.answers) throw new Error('Expected --pdf and --answers');
      const id = v.id ?? 'local-contest';
      console.log(await saveContest(out, { schema_version: 2, contest_id: id, data_version: 1, title: v.title ?? id,
        source: { name: 'Local' }, materials: { entrypoint: { kind: 'pdf', path: v.pdf } }, judge: { kind: 'local', answers: { path: v.answers } } }));
      return 0;
    }
    if (group === 'contest' && command === 'import-codeforces') {
      const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true,
        options: { contest: str, pdf: str, handle: str, languages: str, id: str } });
      const out = position(positionals)!;
      const contest = Number(v.contest);
      if (!Number.isSafeInteger(contest) || contest < 1 || !v.pdf || !v.handle || !v.languages) throw new Error('Expected --contest, --pdf, --handle and --languages');
      console.log(await abortable(signal => codeforcesContest(out, { contest, id: v.id ?? 'cf-'+contest,
        pdf: v.pdf, handle: v.handle, languages: JSON.parse(v.languages!) }, signal)));
      return 0;
    }
    if (group === 'agent' && command === 'init') {
      const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { id: str, harness: str, model: str,
        api: str, 'base-url': str, 'key-env': str, 'reasoning-effort': str, family: str } });
      console.log(await saveAgent(position(positionals)!, { id: v.id, harness: v.harness, model: v.model, api: v.api, base_url: v['base-url'],
        api_key_env: v['key-env'], model_family_id: v.family, ...(v['reasoning-effort'] ? { reasoning_effort: v['reasoning-effort'] } : {}) }));
      return 0;
    }
    if (group === 'results' && (command === 'export' || command === 'merge' || command === 'rank')) {
      const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true,
        options: { out: str, workspace: str, batch: str, run: str, family: str } });
      let data: unknown;
      if (command === 'export') {
        if (positionals.length || Boolean(v.batch) === Boolean(v.run)) throw new Error('Select exactly one of --batch or --run');
        const root = workdir(v.workspace);
        data = v.batch ? await exportBatch(root, v.batch) : { schema_version: 1, results: [await exportRun(root, v.run!)] };
      } else if (command === 'merge') {
        if (!positionals.length) throw new Error('Provide one or more result bundles');
        data = mergeResults(await Promise.all(positionals.map(readJson)));
      } else data = rankResults(mergeResults([await readJson(position(positionals)!)]), v.family);
      if (v.out) await writeFile(v.out, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      else print(data);
      return 0;
    }
    if ((group === 'contest' || group === 'agent') && command === 'validate') {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const file = position(positionals)!;
      if (group === 'contest') {
        const { contest } = await loadContest(file);
        print({ contest_id: contest.contest_id, data_version: contest.data_version });
      } else {
        const { agent, profile } = await loadAgent(file);
        print({ agent_id: agent.agent_id, harness: agent.harness, model: profile.model });
      }
      return 0;
    }
    if (group === 'batch' && command === 'plan') {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { out: str, json: bool } });
      const plan = await planFromFile(position(positionals)!);
      if (values.out) await writeFile(values.out, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (!values.out || values.json) print(plan);
      else console.log(`${plan.jobs.length} job(s) → ${values.out}`);
      return 0;
    }
    if (group === 'batch' && (command === 'run' || command === 'resume')) {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { workspace: str, json: bool } });
      const ref = position(positionals)!;
      const root = workdir(values.workspace);
      const batchId = command === 'run' ? (await enqueue(root, planSchema.parse(await readJson(ref)))).id : ref;
      console.error(`batch_id=${batchId}`);
      return await abortable(async signal => {
        const batch = summarize(await dispatch(root, batchId, signal));
        if (values.json) print(batch);
        else for (const job of batch.jobs) console.log(`${job.agent_id} × ${job.contest_id}: ${job.status}${job.run_id ? ' '+job.run_id : ''}${job.reason ? ' ('+job.reason+')' : ''}`);
        return batch.jobs.every(job => job.status === 'completed') ? 0 : 2;
      });
    }
    if (group === 'batch' && command === 'status') {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { workspace: str, json: bool } });
      const batchId = position(positionals, true);
      const root = workdir(values.workspace);
      const batches = batchId ? [await getBatch(root, batchId)] : await listBatches(root);
      if (values.json) print(batchId ? summarize(batches[0]!) : batches.map(summarize));
      else for (const batch of batches) {
        console.log(batch.id);
        for (const job of summarize(batch).jobs) console.log(`  ${job.agent_id} × ${job.contest_id}: ${job.status}${job.run_id ? ' '+job.run_id : ''}`);
      }
      return 0;
    }
    if ((group === 'batch' && command === 'stop') || (group === 'run' && command === 'cancel')) {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { workspace: str } });
      const id = position(positionals)!;
      await (group === 'batch' ? requestBatchStop : requestRunCancel)(workdir(values.workspace), id);
      console.log('Cancellation requested');
      return 0;
    }
    if (group === 'run' && (command === 'show' || command === 'logs')) {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { workspace: str, stream: str, follow: bool, json: bool } });
      const id = position(positionals)!;
      const root = workdir(values.workspace);
      const run = await lookupRun(root, id);
      if (command === 'show') {
        const meta = await readJson(join(root, id, 'run.json')).catch(error => {
          if (run && error.code === 'ENOENT') return null;
          throw error;
        });
        print({ run: meta, job: run?.job, batch_id: run?.batchId });
      } else {
        const stream = values.stream ?? 'stdout';
        if (stream !== 'stdout' && stream !== 'stderr') throw new Error('--stream must be stdout or stderr');
        await abortable(async signal => {
          let offset = 0;
          while (!signal.aborted) {
            const running = values.follow && (await lookupRun(root, id))?.job.status === 'running';
            const raw = await readRunLog(root, id, stream);
            const log = running ? raw.replace(/\uFFFD+$/, '') : raw;
            // Untrusted output is data, not terminal escape sequences.
            process.stdout.write(log.slice(offset).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
            offset = log.length;
            if (!running) break;
            await wait(250);
          }
        });
      }
      return 0;
    }
    if (group === 'studio') {
      const { values } = parseArgs({ args: args.slice(1), options: { workspace: str, port: str } });
      const port = values.port === undefined ? 0 : Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
      const { serveStudio } = await import('./studio.js');
      await abortable(async signal => { await serveStudio(workdir(values.workspace), port, signal); });
      return 0;
    }
    throw new Error(usage);
  } catch (error) {
    console.error(started ? 'Run failed while recording results; see the run directory.' : error instanceof Error ? error.message : 'Command failed');
    return started ? 2 : 1;
  }
}
process.exitCode = await main(process.argv.slice(2));
