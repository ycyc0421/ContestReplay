#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ConnectionError, Connections, createConnectionSchema, rotateConnectionSchema } from './connections.js';
import { loadAgent, loadContest, modelKey } from './config.js';
import { makePlan, planFromFile, planSchema, readJson } from './plan.js';
import { saveAgent, saveAgentManifest, saveContest, codeforcesContest } from './author.js';
import { agentKind, FieldError } from './agent-manifest.js';
import { harness, harnessKind } from './harnesses.js';
import { protocolPresetNames, protocolPresets, scoringModes, type ProtocolPresetName, type ScoringMode } from './protocol.js';
import { exportBatch, exportRun, mergeResults, rankResults, resultBundle } from './results.js';
import { dispatch, enqueue, getBatch, listBatches, lookupRun, readRunLog, requestBatchStop, requestRunCancel, summarize, workdir } from './queue.js';
import {
  batchApplyAgents,
  batchImportContests,
  exportSchemas,
  generateAgentVariants,
  ifExistsSchema,
  schemaTargetSchema,
  type IfExistsMode,
  type SchemaTarget,
} from './automation.js';
import { OjAccountError, OjAccounts, ojPlatformSchema } from './oj-accounts.js';
import { checkPdfLimits, inspectPdf, synthesizeTextContestPdf } from './pdf-synth.js';
import { PushDispatcher, PushTargetError, PushTargets, pushAuthModeSchema } from './push.js';
import { toBatchSpec, WorkspaceIndex } from './sqlite-index.js';
import { serveWorkbenchMcp } from './mcp-server.js';

const usage = `Usage:
  cr bench run <contest.json> --agent <agent.toml|agent.yaml|agent.json> [--out <dir>] [--json]
  cr contest init <contest.json> --pdf <relative-path> --answers <relative-path> [--id <id>] [--title <title>]
  cr contest import-codeforces <contest.json> --contest <number> --pdf <path> --handle <handle> --languages <json>
  cr contest validate <contest.json>
  cr contest batch-import <file.json> [--workspace <dir>] [--base <dir>] [--dry-run] [--if-exists skip|error|overwrite] [--json]
  cr contest inspect-pdf <problems.pdf> [--preset short|cf-2h|icpc-5h] [--json]
  cr contest synth-pdf <spec.json> --out <problems.pdf> [--overwrite] [--allow-ascii-fallback] [--json]
  cr agent init <agent.toml|agent.yaml|agent.json> --id <id> --harness <kind> --model <model> --provider <id> [--name <label>] [--vendor <id>] [--speed-tier <standard|fast|ultrafast>] [--reasoning-effort <level>] [--service-tier <tier>] [--temperature <value>]
  cr agent init <agent.toml> --id <id> --harness <kind> --model <model> [--name <label>] [--speed-tier <standard|fast|ultrafast>] [--api <protocol>] [--base-url <url>] [--key-env <name>] [--reasoning-effort <level>] [--service-tier <tier>] [--family <id>]
  cr agent validate <agent.toml|agent.yaml|agent.json>
  cr agent batch-apply <file.json> [--base <dir>] [--dry-run] [--if-exists skip|error|overwrite] [--json]
  cr agent variants <spec.json> [--base <dir>] [--dry-run] [--if-exists skip|error|overwrite] [--json]
  cr schema export [--target all|agent|contest|batch|results] [--out <file>] [--json]
  cr coverage [--workspace <dir>] [--base <dir>] [--agent <id>] [--contest <id>] [--missing-only] [--min-repeats <n>] [--emit-spec] [--json]
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
  cr results rank <results.json> [--vendor <id>] [--family <legacy-id>] [--scoring <icpc|cf|ioi|last_ac>] [--group-by <model|revision>]
  cr provider add <id> [--label <label>] [--protocol <passthrough|responses|chat-completions|anthropic-messages>] [--supports-fast] [--supports-ultrafast] --base-url <url> --secret-stdin
  cr provider rotate <id> --secret-stdin
  cr connection add|rotate ...  # legacy alias
  cr oj-account add <id> --platform <codeforces|qoj|vjudge|hydro> --handle <handle> [--label <label>] [--pool <pool>] [--base-url <url>] (--secret-stdin | --submitter <abs-path>) [--json]
  cr oj-account list [--platform <p>] [--json]
  cr oj-account rotate <id> --secret-stdin [--json]
  cr oj-account remove <id> [--json]
  cr push-target add <id> --url <url> --events <csv> [--label <label>] [--auth none|bearer|hmac-sha256] [--secret-stdin] [--json]
  cr push-target list [--json]
  cr push-target rotate <id> --secret-stdin [--auth bearer|hmac-sha256] [--json]
  cr push-target remove <id> [--json]
  cr push-target test <id> [--json]
  cr mcp [--workspace <dir>] [--base <dir>]
  cr studio [--workspace <dir>] [--port <number>]`;
const str = { type: 'string' } as const;
const multiStr = { type: 'string', multiple: true } as const;
const bool = { type: 'boolean' } as const;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));

class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2 | 3 | 4 = 1, readonly code = 'error') {
    super(message);
    this.name = 'CliError';
  }
}

async function readSecretStdin(maxLength: number, label: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError(`Pipe the ${label} via stdin with --secret-stdin; never use a command-line argument`, 4, 'missing_credential');
  }
  let secret = '';
  for await (const part of process.stdin.setEncoding('utf8')) {
    secret += part;
    if (secret.length > maxLength) throw new CliError(`${label} too long`, 3, 'validation_error');
  }
  const trimmed = secret.trim();
  if (!trimmed) throw new CliError(`Empty ${label} on stdin`, 4, 'missing_credential');
  return trimmed;
}

function sanitizeParseArgsError(code: string, message: string): string {
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const match = message.match(/Unknown option '(--?[A-Za-z0-9][A-Za-z0-9_-]{0,63})'/);
    return match ? `Unknown option ${match[1]}` : 'Unknown command-line option';
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const match = message.match(/Option '(--?[A-Za-z0-9][A-Za-z0-9_-]{0,63})/);
    return match ? `Invalid value for option ${match[1]}` : 'Invalid command-line option value';
  }
  if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
    return 'Unexpected positional argument';
  }
  return 'Invalid command-line arguments';
}

function classifyCliError(error: unknown, started: boolean, structured: boolean): { exitCode: number; code: string; message: string } {
  if (started) {
    return { exitCode: 2, code: 'run_failed', message: 'Run failed while recording results; see the run directory.' };
  }
  if (error instanceof CliError) {
    return { exitCode: error.exitCode, code: error.code, message: error.message };
  }
  const errCode = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : 'Command failed';
  if (typeof errCode === 'string' && errCode.startsWith('ERR_PARSE_ARGS_')) {
    return { exitCode: 3, code: 'validation_error', message: sanitizeParseArgsError(errCode, message) };
  }
  if (!structured) {
    return { exitCode: 1, code: 'error', message };
  }
  if (error instanceof z.ZodError) {
    return {
      exitCode: 3,
      code: 'validation_error',
      message: error.issues.map(iss => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; '),
    };
  }
  if (error instanceof FieldError) {
    return { exitCode: 3, code: 'validation_error', message };
  }
  if (error instanceof ConnectionError || error instanceof OjAccountError || error instanceof PushTargetError) {
    if (error.status === 409) return { exitCode: 3, code: 'conflict', message };
    if (error.status === 400) return { exitCode: 3, code: 'validation_error', message };
    if (error.status === 404 || error.status === 503) return { exitCode: 4, code: 'missing_credential', message };
    return { exitCode: 1, code: 'error', message };
  }
  if (errCode === 'EEXIST') {
    return { exitCode: 3, code: 'conflict', message };
  }
  if (/Set [A-Z0-9_]+ in the runner environment|Approve the endpoint|credential unavailable|missing_model_key|Pipe the .* via stdin with --secret-stdin/i.test(message)) {
    return { exitCode: 4, code: 'missing_credential', message };
  }
  return { exitCode: 1, code: 'error', message };
}

function parseIfExists(raw: string | undefined): IfExistsMode {
  const res = ifExistsSchema.safeParse(raw ?? 'error');
  if (!res.success) throw new CliError('--if-exists must be one of: skip, error, overwrite', 3, 'validation_error');
  return res.data;
}

function unwrapBatchArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: unknown[] }).items;
  }
  throw new CliError('Expected a JSON array or an object with an "items" array', 3, 'validation_error');
}
function position(list: string[], optional = false) {
  if (list.length > 1 || (!optional && list.length !== 1)) throw new CliError(usage, 3, 'validation_error');
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
  const wantsJson = args.includes('--json');
  const [group, command, ...rest] = args;
  const isMcp = group === 'mcp';
  const isAutomationCommand =
    group === 'schema' ||
    group === 'coverage' ||
    group === 'oj-account' ||
    group === 'push-target' ||
    group === 'mcp' ||
    (group === 'agent' && (command === 'batch-apply' || command === 'variants')) ||
    (group === 'contest' && (command === 'batch-import' || command === 'inspect-pdf' || command === 'synth-pdf'));
  try {
    if (!group || args.includes('--help') || args.includes('-h') ||
        (args.length === 1 && ['bench', 'batch', 'run', 'contest', 'agent', 'connection', 'provider', 'schema', 'oj-account', 'push-target'].includes(group))) {
      console.log(usage); return 0;
    }
    if (group === 'bench' && command === 'run') {
      if (!rest.length) { console.log(usage); return 0; }
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { agent: str, out: str, json: bool } });
      const file = position(positionals)!;
      if (!values.agent || values.out === '') throw new Error(usage);
      const root = workdir(values.out);
      await modelKey(await loadAgent(values.agent));
      const plan = await makePlan({ schema_version: 1, agents: [values.agent], contests: [file] }, process.cwd());
      const { id: batchId } = await enqueue(root, plan);
      const batch = await abortable(signal => dispatch(root, batchId, signal, { onJobStart: (id, directory) => {
        started = true;
        if (!values.json) console.log(`run_id=${id}\nrun_dir=${directory}`);
      } }));
      const result = batch.jobs[0]!;
      if (values.json) print({ ok: result.status === 'completed', batch_id: batchId, job: result });
      else console.log(`${result.status}: ${result.reason}`);
      return result.status === 'completed' ? 0 : 2;
    }
    if ((group === 'provider' || group === 'connection') && (command === 'add' || command === 'rotate')) {
      const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: {
        label: str, protocol: str, 'base-url': str, 'secret-stdin': bool, 'supports-fast': bool, 'supports-ultrafast': bool,
      } });
      const id = position(positionals)!;
      if (!v['secret-stdin'] || process.stdin.isTTY) throw new Error('Pipe the API key via stdin with --secret-stdin; never use a command-line argument');
      let secret = '';
      for await (const part of process.stdin.setEncoding('utf8')) {
        secret += part;
        if (secret.length > 8194) throw new Error('API credential too long');
      }
      const store = new Connections();
      try {
        if (command === 'add') print(await store.create(createConnectionSchema.parse({
          id, label: v.label ?? id, protocol: v.protocol ?? 'passthrough', base_url: v['base-url'], secret,
          ...(v['supports-fast'] ? { supports_fast: true } : {}),
          ...(v['supports-ultrafast'] ? { supports_ultrafast: true } : {}),
        })));
        else print(await store.rotate(id, rotateConnectionSchema.parse({ secret }).secret));
      } catch { throw new Error('Could not save provider; check ID, label, protocol, endpoint and credential storage'); }
      return 0;
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
      const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: {
        id: str, name: str, harness: str, model: str, 'speed-tier': str, 'service-tier': str,
        api: str, 'base-url': str, 'key-env': str, 'reasoning-effort': str, family: str,
        connection: str, provider: str, vendor: str, temperature: str,
      } });
      const out = position(positionals)!;
      const provider = v.provider ?? v.connection;
      if (v.provider && v.connection) throw new Error('Use only one of --provider and legacy --connection');
      if (provider !== undefined) {
        if ([v.api, v['base-url'], v['key-env'], v.family].some(value => value !== undefined)) {
          throw new Error('--provider (or legacy --connection) cannot be combined with legacy API or family options');
        }
        const kind = harnessKind.parse(v.harness);
        const options = {
          ...(v['reasoning-effort'] !== undefined ? { reasoning_effort: v['reasoning-effort'] } : {}),
          ...(v['service-tier'] !== undefined ? { service_tier: v['service-tier'] } : {}),
          ...(v.temperature !== undefined ? { temperature: v.temperature } : {}),
        };
        console.log(await saveAgentManifest(out, {
          kind: agentKind, schema_version: 1, id: v.id,
          ...(v.name !== undefined ? { name: v.name } : {}),
          model: v.model,
          ...(v['speed-tier'] !== undefined ? { speed_tier: v['speed-tier'] } : {}),
          provider, vendor: v.vendor, harness: { kind, version: harness(kind).version, options },
        }));
      } else {
        if (v.vendor !== undefined || v.temperature !== undefined) throw new Error('--vendor and --temperature require --provider (or legacy --connection)');
        console.log(await saveAgent(out, {
          id: v.id, ...(v.name !== undefined ? { name: v.name } : {}),
          ...(v['speed-tier'] !== undefined ? { speed_tier: v['speed-tier'] } : {}),
          harness: v.harness, model: v.model, api: v.api, base_url: v['base-url'],
          api_key_env: v['key-env'], model_family_id: v.family,
          ...(v['reasoning-effort'] !== undefined ? { reasoning_effort: v['reasoning-effort'] } : {}),
          ...(v['service-tier'] !== undefined ? { service_tier: v['service-tier'] } : {}),
        }));
      }
      return 0;
    }
    if (group === 'results' && (command === 'export' || command === 'merge' || command === 'rank')) {
      const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true,
        options: { out: str, workspace: str, batch: str, run: str, family: str, vendor: str, scoring: str, 'group-by': str } });
      let data: unknown;
      if (command === 'export') {
        if (positionals.length || Boolean(v.batch) === Boolean(v.run)) throw new Error('Select exactly one of --batch or --run');
        const root = workdir(v.workspace);
        data = v.batch ? await exportBatch(root, v.batch) : resultBundle([await exportRun(root, v.run!)]);
      } else if (command === 'merge') {
        if (!positionals.length) throw new Error('Provide one or more result bundles');
        data = mergeResults(await Promise.all(positionals.map(readJson)));
      } else {
        if (v.scoring !== undefined && !(scoringModes as readonly string[]).includes(v.scoring)) {
          throw new Error(`--scoring must be one of: ${scoringModes.join(', ')}`);
        }
        if (v['group-by'] !== undefined && !['model', 'revision'].includes(v['group-by'])) {
          throw new Error('--group-by must be model or revision');
        }
        data = rankResults(mergeResults([await readJson(position(positionals)!)]), {
          family: v.family,
          vendor: v.vendor,
          scoring: v.scoring as ScoringMode | undefined,
          groupBy: v['group-by'] as 'model' | 'revision' | undefined,
        });
      }
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
        const { agent, agentName, speedTier, profile, vendor, connection, agentDigest, profileDigest, nativeDigest, effectiveDigest } = await loadAgent(file);
        print({
          agent_id: agent.agent_id, ...(agentName ? { name: agentName } : {}), harness: agent.harness, model: profile.model,
          speed_tier: speedTier, vendor, connection,
          source_sha256: agentDigest, profile_sha256: profileDigest, native_sha256: nativeDigest, effective_sha256: effectiveDigest,
        });
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
    if (group === 'schema' && command === 'export') {
      const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { target: str, out: str, json: bool } });
      if (positionals.length) throw new CliError(usage, 3, 'validation_error');
      const targetCheck = schemaTargetSchema.safeParse(v.target ?? 'all');
      if (!targetCheck.success) throw new CliError('--target must be one of: all, agent, contest, batch, results', 3, 'validation_error');
      const exported = exportSchemas(targetCheck.data as SchemaTarget);
      if (v.out) {
        await writeFile(v.out, JSON.stringify(exported, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        if (v.json) print({ ok: true, target: exported.target, out: resolve(v.out) });
        else console.log(resolve(v.out));
      } else {
        print(exported);
      }
      return 0;
    }
    if (group === 'agent' && command === 'batch-apply') {
      const { positionals, values: v } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { 'dry-run': bool, 'if-exists': str, base: str, json: bool },
      });
      const file = position(positionals)!;
      const items = unwrapBatchArray(await readJson(file));
      const result = await batchApplyAgents(items, {
        base: resolve(v.base ?? process.cwd()),
        store: new Connections(),
        dryRun: v['dry-run'],
        ifExists: parseIfExists(v['if-exists']),
      });
      if (v.json) print(result);
      else if (result.ok) console.log(`created=${result.created} overwritten=${result.overwritten} skipped=${result.skipped}${result.dry_run ? ' (dry-run)' : ''}`);
      else for (const err of result.errors) console.error(`${err.path.join('.') || '(root)'}: ${err.message}`);
      return result.ok ? 0 : 3;
    }
    if (group === 'agent' && command === 'variants') {
      const { positionals, values: v } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { 'dry-run': bool, 'if-exists': str, base: str, json: bool },
      });
      const file = position(positionals)!;
      const spec = await readJson(file);
      const result = await generateAgentVariants(spec, {
        base: resolve(v.base ?? process.cwd()),
        store: new Connections(),
        dryRun: v['dry-run'],
        ifExists: parseIfExists(v['if-exists']),
      });
      if (v.json) print(result);
      else if (result.ok) console.log(`total=${result.total} created=${result.created} overwritten=${result.overwritten} skipped=${result.skipped}${result.dry_run ? ' (dry-run)' : ''}`);
      else for (const err of result.errors) console.error(`${err.path.join('.') || '(root)'}: ${err.message}`);
      return result.ok ? 0 : 3;
    }
    if (group === 'contest' && command === 'batch-import') {
      const { positionals, values: v } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { workspace: str, base: str, 'dry-run': bool, 'if-exists': str, json: bool },
      });
      const file = position(positionals)!;
      const items = unwrapBatchArray(await readJson(file));
      const result = await abortable(signal =>
        batchImportContests(items, {
          root: workdir(v.workspace),
          base: resolve(v.base ?? process.cwd()),
          dryRun: v['dry-run'],
          ifExists: parseIfExists(v['if-exists']),
          signal,
        }),
      );
      if (v.json) print(result);
      else if (result.ok) console.log(`created=${result.created} overwritten=${result.overwritten} skipped=${result.skipped}${result.dry_run ? ' (dry-run)' : ''}`);
      else for (const err of result.errors) console.error(`${err.path.join('.') || '(root)'}: ${err.message}`);
      return result.ok ? 0 : 3;
    }
    if (group === 'contest' && command === 'inspect-pdf') {
      const { positionals, values: v } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { preset: str, json: bool },
      });
      const pdfFile = position(positionals)!;
      const presetName = (v.preset ?? 'short') as ProtocolPresetName;
      if (!(protocolPresetNames as readonly string[]).includes(presetName)) {
        throw new CliError(`--preset must be one of: ${protocolPresetNames.join(', ')}`, 3, 'validation_error');
      }
      const info = await inspectPdf(pdfFile);
      const preset = protocolPresets[presetName];
      const limits = checkPdfLimits(info, { maxPages: preset.pdfMaxPages, maxBytes: preset.pdfMaxBytes });
      if (v.json) print({ ok: true, protocol_preset: presetName, info, limits });
      else {
        console.log(`${info.path}: ${info.page_count} page(s), ${info.size_bytes} bytes, problems=[${info.problem_ids.join(', ')}]`);
        if (!limits.ok) for (const iss of limits.issues) console.error(`limit warning: ${iss}`);
      }
      return 0;
    }
    if (group === 'contest' && command === 'synth-pdf') {
      const { positionals, values: v } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { out: str, overwrite: bool, 'allow-ascii-fallback': bool, json: bool },
      });
      const specFile = position(positionals)!;
      if (!v.out) throw new CliError('Expected --out <problems.pdf>', 3, 'validation_error');
      const rawSpec = await readJson(specFile);
      const specObj = Array.isArray(rawSpec)
        ? { problems: rawSpec }
        : rawSpec && typeof rawSpec === 'object'
          ? (rawSpec as { problems?: unknown; title?: string; subtitle?: string })
          : {};
      if (!Array.isArray(specObj.problems)) {
        throw new CliError('Expected spec JSON to be an array of problems or an object with a "problems" array', 3, 'validation_error');
      }
      const result = await synthesizeTextContestPdf(specObj.problems, v.out, {
        title: specObj.title,
        subtitle: specObj.subtitle,
        overwrite: v.overwrite,
        allowAsciiFallback: v['allow-ascii-fallback'],
      });
      if (v.json) print({ ok: true, ...result });
      else console.log(result.output_path);
      return 0;
    }
    if (group === 'coverage') {
      const { positionals, values: v } = parseArgs({
        args: args.slice(1),
        allowPositionals: true,
        options: {
          workspace: str,
          base: str,
          agent: multiStr,
          contest: multiStr,
          'missing-only': bool,
          'min-repeats': str,
          'emit-spec': bool,
          json: bool,
        },
      });
      if (positionals.length) throw new CliError(usage, 3, 'validation_error');
      const minRepeats = v['min-repeats'] === undefined ? 1 : Number(v['min-repeats']);
      if (!Number.isInteger(minRepeats) || minRepeats < 1 || minRepeats > 100) {
        throw new CliError('--min-repeats must be an integer between 1 and 100', 3, 'validation_error');
      }
      const root = workdir(v.workspace);
      const base = resolve(v.base ?? process.cwd());
      const index = new WorkspaceIndex(root);
      try {
        await index.sync({ base, root, store: new Connections() });
        const agentIds = v.agent?.length ? v.agent : undefined;
        const contestIds = v.contest?.length ? v.contest : undefined;
        if (v['emit-spec']) {
          const diff = index.findUncoveredCells({ agentIds, contestIds, minRepeats });
          const spec = toBatchSpec(diff);
          if (v.json) {
            print({
              ok: true,
              total_gaps: diff.total_gaps,
              waves_required: diff.waves_required,
              truncated: diff.truncated,
              incompatible_skipped: diff.incompatible_skipped,
              batch_spec: spec,
            });
          } else {
            print(spec);
          }
          return 0;
        }
        if (v['missing-only']) {
          const diff = index.findUncoveredCells({ agentIds, contestIds, minRepeats });
          if (v.json) print({ ok: true, ...diff, batch_spec: toBatchSpec(diff) });
          else for (const cell of diff.cells) console.log(`${cell.agent_id} × ${cell.contest_id}@v${cell.data_version}: ${cell.reason} (missing ${cell.missing_repeats})`);
          return 0;
        }
        const cells = index.queryCoverage({ agentIds, contestIds });
        const diff = index.findUncoveredCells({ agentIds, contestIds, minRepeats });
        if (v.json) {
          print({
            ok: true,
            cells,
            total_cells: cells.length,
            total_gaps: diff.total_gaps,
            waves_required: diff.waves_required,
            truncated: diff.truncated,
            incompatible_skipped: diff.incompatible_skipped,
            gaps: diff.cells,
            batch_spec: toBatchSpec(diff),
          });
        }
        else for (const cell of cells) {
          console.log(`${cell.agent_id} × ${cell.contest_id}@v${cell.data_version}: completed=${cell.completed_count} void=${cell.void_count} running=${cell.running_count} total=${cell.total_runs} latest=${cell.latest_status ?? 'unrun'}`);
        }
        return 0;
      } finally {
        index.close();
      }
    }
    if (group === 'oj-account') {
      const store = new OjAccounts();
      if (command === 'add') {
        const { positionals, values: v } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            platform: str,
            handle: str,
            label: str,
            pool: str,
            'base-url': str,
            'secret-stdin': bool,
            submitter: str,
            json: bool,
          },
        });
        const id = position(positionals)!;
        if (!v.platform || !v.handle) throw new CliError('Expected --platform and --handle', 3, 'validation_error');
        if (Boolean(v['secret-stdin']) === Boolean(v.submitter)) {
          throw new CliError('Specify exactly one of --secret-stdin or --submitter <abs-path>', 3, 'validation_error');
        }
        const platform = ojPlatformSchema.parse(v.platform);
        const created = v['secret-stdin']
          ? await store.create({
              id,
              label: v.label ?? `${platform}:${v.handle}`,
              platform,
              handle: v.handle,
              ...(v.pool ? { pool: v.pool } : {}),
              ...(v['base-url'] ? { base_url: v['base-url'] } : {}),
              transport: 'cookie',
              secret: await readSecretStdin(16_386, 'OJ credential'),
            })
          : await store.create({
              id,
              label: v.label ?? `${platform}:${v.handle}`,
              platform,
              handle: v.handle,
              ...(v.pool ? { pool: v.pool } : {}),
              ...(v['base-url'] ? { base_url: v['base-url'] } : {}),
              transport: 'submitter',
              executable_path: v.submitter!,
            });
        print(v.json ? { ok: true, account: created } : created);
        return 0;
      }
      if (command === 'list') {
        const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { platform: str, json: bool } });
        if (positionals.length) throw new CliError(usage, 3, 'validation_error');
        const platformFilter = v.platform ? ojPlatformSchema.parse(v.platform) : undefined;
        const accounts = (await store.list()).filter(acc => !platformFilter || acc.platform === platformFilter);
        print(v.json ? { ok: true, accounts } : accounts);
        return 0;
      }
      if (command === 'rotate') {
        const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { 'secret-stdin': bool, json: bool } });
        const id = position(positionals)!;
        if (!v['secret-stdin']) throw new CliError('Expected --secret-stdin', 4, 'missing_credential');
        const secret = await readSecretStdin(16_386, 'OJ credential');
        const updated = await store.rotate(id, secret);
        print(v.json ? { ok: true, account: updated } : updated);
        return 0;
      }
      if (command === 'remove') {
        const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { json: bool } });
        const id = position(positionals)!;
        await store.remove(id);
        if (v.json) print({ ok: true, removed: id });
        else console.log(`Removed ${id}`);
        return 0;
      }
      throw new CliError(usage, 3, 'validation_error');
    }
    if (group === 'push-target') {
      const store = new PushTargets();
      if (command === 'add') {
        const { positionals, values: v } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { url: str, events: str, label: str, auth: str, 'secret-stdin': bool, json: bool },
        });
        const id = position(positionals)!;
        if (!v.url || !v.events) throw new CliError('Expected --url and --events', 3, 'validation_error');
        const authMode = pushAuthModeSchema.parse(v.auth ?? 'none');
        const events = v.events.split(',').map(s => s.trim()).filter(Boolean);
        let secret: string | undefined;
        if (authMode === 'none') {
          if (v['secret-stdin']) throw new CliError('Do not pass --secret-stdin when --auth is none', 3, 'validation_error');
        } else {
          if (!v['secret-stdin']) throw new CliError(`Expected --secret-stdin for --auth ${authMode}`, 4, 'missing_credential');
          secret = await readSecretStdin(8194, 'push secret');
        }
        const created = await store.create({
          id,
          label: v.label ?? id,
          url: v.url,
          events: events as ('run.completed' | 'run.progress' | 'batch.completed')[],
          auth_mode: authMode,
          ...(secret !== undefined ? { secret } : {}),
        });
        print(v.json ? { ok: true, target: created } : created);
        return 0;
      }
      if (command === 'list') {
        const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { json: bool } });
        if (positionals.length) throw new CliError(usage, 3, 'validation_error');
        const targets = await store.list();
        print(v.json ? { ok: true, targets } : targets);
        return 0;
      }
      if (command === 'rotate') {
        const { positionals, values: v } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { 'secret-stdin': bool, auth: str, json: bool },
        });
        const id = position(positionals)!;
        if (!v['secret-stdin']) throw new CliError('Expected --secret-stdin', 4, 'missing_credential');
        const secret = await readSecretStdin(8194, 'push secret');
        const authMode = v.auth ? z.enum(['bearer', 'hmac-sha256']).parse(v.auth) : undefined;
        const updated = await store.rotate(id, { secret, ...(authMode ? { auth_mode: authMode } : {}) });
        print(v.json ? { ok: true, target: updated } : updated);
        return 0;
      }
      if (command === 'remove') {
        const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { json: bool } });
        const id = position(positionals)!;
        await store.remove(id);
        if (v.json) print({ ok: true, removed: id });
        else console.log(`Removed ${id}`);
        return 0;
      }
      if (command === 'test') {
        const { positionals, values: v } = parseArgs({ args: rest, allowPositionals: true, options: { json: bool } });
        const id = position(positionals)!;
        const dispatcher = new PushDispatcher(store);
        const delivery = await abortable(signal => dispatcher.testTarget(id, { signal }));
        const ok = delivery.status === 'delivered';
        print(v.json ? { ok, delivery } : delivery);
        return ok ? 0 : 1;
      }
      throw new CliError(usage, 3, 'validation_error');
    }
    if (group === 'mcp') {
      const { positionals, values: v } = parseArgs({
        args: args.slice(1),
        allowPositionals: true,
        options: { workspace: str, base: str },
      });
      if (positionals.length) throw new CliError(usage, 3, 'validation_error');
      await abortable(signal =>
        serveWorkbenchMcp(
          {
            root: workdir(v.workspace),
            base: resolve(v.base ?? process.cwd()),
          },
          signal,
        ),
      );
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
    throw new CliError(usage, 3, 'validation_error');
  } catch (error) {
    const classified = classifyCliError(error, started, wantsJson || isAutomationCommand);
    if (wantsJson && !isMcp) {
      print({ ok: false, error: classified.message, code: classified.code });
    } else {
      console.error(classified.message);
    }
    return classified.exitCode;
  }
}
process.exitCode = await main(process.argv.slice(2));
