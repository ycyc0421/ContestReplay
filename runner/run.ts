import { randomUUID } from 'node:crypto';
import { constants, createWriteStream, type WriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ResponseInput } from 'openai/resources/responses/responses.js';
import { z } from 'zod';
import { createContest, createMcp, finishArgs, statusArgs, submitArgs, type EventSink } from './contest.js';
import { protocol, protocolDigestForPreset, protocolForPreset, resolveProtocolPreset, resolveScoringMode } from './protocol.js';
import { agentRevision, type Inputs } from './config.js';
import { launch, renderPdf, resources, SandboxCleanupError } from './docker.js';
import { match } from './match.js';
import { codeforces, type ProgramJudge } from './codeforces.js';
import { codexConfig, serveContestChannels, type ContestChannelsHandle, type SessionArchiveResult } from './codex.js';
import type { Infer } from './model.js';
import { send } from './wire.js';
import { credentialJson, redactCredentialStream } from './credential-redaction.js';

const ready = z.strictObject({ op: z.literal('ready') });
const next = z.strictObject({ op: z.literal('next') });
const tool = z.strictObject({ op: z.literal('tool'), index: z.number().int().nonnegative() });
class RunFailure extends Error {}

function interrupt(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

function waitForGraceExit(exited: Promise<number | null>, signal: AbortSignal, ms = 1_500): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  return new Promise<void>(resolve => {
    const done = () => {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    };
    onAbort = done;
    timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener('abort', done, { once: true });
    void exited.then(done, done);
  });
}

export const SESSION_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
const SESSION_ARCHIVE_MAX_FILES = 256;
const SESSION_ARCHIVE_MAX_ENTRIES = 2048;
const SESSION_ARCHIVE_MAX_DEPTH = 8;

export async function archiveSessionDir(
  sourceDir: string,
  targetDir: string,
  key?: string,
  maxBytes = SESSION_ARCHIVE_MAX_BYTES,
  maxEntriesVisited = SESSION_ARCHIVE_MAX_ENTRIES,
): Promise<string[]> {
  let rootInfo;
  try { rootInfo = await lstat(sourceDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return [];
  const rootReal = await realpath(sourceDir);
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;

  const archived: string[] = [];
  let remaining = maxBytes;
  let entriesVisited = 0;

  const walk = async (currentDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > SESSION_ARCHIVE_MAX_DEPTH || remaining <= 0 || archived.length >= SESSION_ARCHIVE_MAX_FILES || entriesVisited >= maxEntriesVisited) return;
    const names = (await readdir(currentDir)).sort();
    for (const name of names) {
      if (remaining <= 0 || archived.length >= SESSION_ARCHIVE_MAX_FILES || ++entriesVisited > maxEntriesVisited) break;
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) continue;
      const srcPath = join(currentDir, name);
      let info;
      try { info = await lstat(srcPath); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      let resolvedPath: string;
      try { resolvedPath = await realpath(srcPath); } catch { continue; }
      if (!resolvedPath.startsWith(rootPrefix)) continue;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (info.isDirectory()) {
        await walk(srcPath, rel, depth + 1);
      } else if (info.isFile()) {
        if (info.nlink > 1) continue;
        let handle;
        try { handle = await open(srcPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
        catch { continue; }
        try {
          const statInfo = await handle.stat();
          if (!statInfo.isFile() || statInfo.nlink > 1) continue;
          const destPath = join(targetDir, ...rel.split('/'));
          await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
          const out = createWriteStream(destPath, { mode: 0o600, flags: 'wx' });
          const outClosed = finished(out);
          void outClosed.catch(() => {});
          await once(out, 'open');
          let truncated = false;
          const redactor = redactCredentialStream(key, bytes => {
            if (truncated || out.destroyed || bytes.length === 0) return;
            if (bytes.length <= remaining) {
              remaining -= bytes.length;
              out.write(bytes);
            } else {
              if (remaining > 0) out.write(bytes.subarray(0, remaining));
              remaining = 0;
              truncated = true;
              out.write('\n[cr: session archive truncated at byte limit]\n');
            }
          });
          const buf = Buffer.alloc(64 * 1024);
          let pos = 0;
          try {
            while (!truncated && remaining > 0) {
              const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
              if (!bytesRead) break;
              pos += bytesRead;
              redactor.push(Buffer.from(buf.subarray(0, bytesRead)));
            }
            redactor.end();
          } finally {
            out.end();
            await outClosed;
          }
          await chmod(destPath, 0o600).catch(() => {});
          archived.push(rel);
        } finally {
          await handle.close();
        }
      }
    }
  };

  await walk(sourceDir, '', 0);
  return archived;
}

export async function runBench(inputs: Inputs, opts: {
  out: string; image: string; infer?: Infer; key?: string; programJudge?: ProgramJudge; signal: AbortSignal;
  runId?: string;
  onStart?: (id: string, directory: string) => void;
}) {
  const runId = opts.runId ?? randomUUID();
  const directory = resolve(opts.out, runId);
  const presetName = resolveProtocolPreset(inputs.contest.rules);
  const preset = protocolForPreset(presetName);
  const effectiveProtocolDigest = protocolDigestForPreset(presetName);
  const scoringMode = resolveScoringMode(inputs.contest.rules);
  const sandboxResources = inputs.profile.harness === 'codex' ? preset.sandbox : resources;

  await mkdir(resolve(opts.out), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const runMeta: Record<string, unknown> = {
    schema_version: 1, run_id: runId, created_at: new Date().toISOString(),
    contest_id: inputs.contest.contest_id, data_version: inputs.contest.data_version,
    local_inputs: { contest: inputs.contestPath, agent: inputs.agentPath, pdf: inputs.pdfPath, judge: inputs.judgePath },
    input_sha256: { contest: inputs.contestDigest, pdf: inputs.contest.statement.sha256,
      judge: inputs.contest.judge.kind === 'local' ? inputs.contest.judge.answers.sha256 : undefined },
    contest_title: inputs.contest.title, contest_revision: inputs.contestRevision,
    problems: inputs.contest.problems.map(({ id, max_points }) => ({ id, max_points })),
    ...(inputs.contest.judge.kind === 'codeforces' && inputs.contest.judge.points_known !== undefined
      ? { points_known: inputs.contest.judge.points_known } : {}),
    protocol_id: inputs.profile.harness === 'codex' ? 'codex-pdf-pages-mcp' : protocol.id, protocol_version: 2,
    protocol_preset: presetName, scoring_mode: scoringMode,
    protocol_sha256: effectiveProtocolDigest, rules: inputs.contest.rules,
    agent_id: inputs.agent.agent_id,
    ...(inputs.agentName ? { agent_name: inputs.agentName } : {}),
    agent_revision: agentRevision(inputs, opts.image, effectiveProtocolDigest),
    agent_digests: { source_sha256: inputs.agentDigest, profile_sha256: inputs.profileDigest, native_sha256: inputs.nativeDigest, effective_sha256: inputs.effectiveDigest },
    harness: inputs.agent.harness, runner_version: '0.2.0', adapter_version: '0.2.0', judge_kind: inputs.contest.judge.kind,
    sandbox: { runtime: 'docker', image: opts.image, resources: sandboxResources },
    model: {
      model: inputs.profile.model, api: inputs.profile.api, base_url: inputs.profile.base_url,
      vendor: inputs.vendor, model_family_id: inputs.profile.model_family_id,
      speed_tier: inputs.speedTier,
      ...(inputs.profile.harness === 'codex'
        ? { reasoning_effort: inputs.profile.reasoning_effort, ...(inputs.profile.service_tier ? { service_tier: inputs.profile.service_tier } : {}) }
        : { temperature: inputs.profile.temperature, max_output_tokens: preset.maxOutputTokens }),
    },
  };
  const runJsonPath = join(directory, 'run.json');
  await writeFile(runJsonPath, credentialJson(runMeta, opts.key, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const log: WriteStream = createWriteStream(join(directory, 'events.jsonl'), { mode: 0o600, flags: 'wx' });
  const logClosed = finished(log);
  // Attach a rejection handler before the first async operation; await below to surface failure.
  void logClosed.catch(() => {});
  await once(log, 'open');
  const writers: { stream: WriteStream; closed: Promise<void>; flush: () => void }[] = [];
  const diagnostic = (name: 'stdout' | 'stderr') => {
    const stream = createWriteStream(join(directory, `agent.${name}.log`), { mode: 0o600, flags: 'wx' });
    const closed = finished(stream);
    void closed.catch(() => {});
    let total = 0;
    let truncated = false;
    const maxBytes = preset.diagnosticMaxBytes;
    const redactor = redactCredentialStream(opts.key, bytes => {
      if (truncated || stream.destroyed || bytes.length === 0) return;
      const budget = maxBytes - total;
      total += bytes.length;
      stream.write(bytes.subarray(0, budget));
      if (bytes.length > budget) {
        truncated = true;
        stream.write(`\n[cr: diagnostics truncated at ${Math.round(maxBytes / (1024 * 1024))} MiB]\n`);
      }
    });
    writers.push({ stream, closed, flush: redactor.end });
    return (chunk: Buffer | string) => redactor.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  };
  let elapsed = () => 0;
  let seq = 0;
  const event: EventSink = entry => {
    log.write(credentialJson({ schema_version: 1, seq: ++seq, elapsed_ms: elapsed(), ...entry }, opts.key) + '\n');
  };
  const cleanup = new AbortController();
  const deadline = new AbortController();
  const stopped = AbortSignal.any([opts.signal, cleanup.signal, deadline.signal]);
  const stoppedPromise = interrupt(stopped);
  void stoppedPromise.catch(() => {});
  const wait = <T>(p: Promise<T>) => Promise.race([p, stoppedPromise]);
  let stage: string | undefined;
  let sessionResult: SessionArchiveResult = { status: 'not_connected', files: [] };
  const isCodex = inputs.profile.harness === 'codex';
  let sandbox: Awaited<ReturnType<typeof launch>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let client: Client | undefined;
  let mcp: ReturnType<typeof createMcp> | undefined;
  let contest: ReturnType<typeof createContest> | undefined;
  let contestMatch: ReturnType<typeof match> | undefined;
  let closeChannels: ContestChannelsHandle | undefined;
  let started = false;
  let status: 'completed' | 'void' = 'void';
  let reason = 'runner_error';
  try {
    opts.onStart?.(runId, directory);
    const stdout = diagnostic('stdout');
    const stderr = diagnostic('stderr');
    opts.signal.throwIfAborted();
    stage = await mkdtemp(join(tmpdir(), 'cr-bench-'));
    const pdfPath = join(stage, 'problems.pdf');
    await writeFile(pdfPath, inputs.pdf, { mode: 0o444 });
    opts.signal.throwIfAborted();
    const limits = inputs.contest.rules;
    if (inputs.profile.harness === 'codex') {
      if (!opts.key) throw new RunFailure('missing_model_key');
      const input = join(stage, 'input');
      await mkdir(input, { mode: 0o755 });
      await writeFile(join(input, 'problems.pdf'), inputs.pdf, { mode: 0o444 });
      const pages = join(input, 'pages');
      await mkdir(pages, { mode: 0o755 });
      await renderPdf(runId, opts.image, pdfPath, pages, opts.signal, { maxPages: preset.pdfMaxPages, maxBytes: preset.pdfMaxBytes });
      const attachments = join(input, 'attachments');
      await mkdir(attachments, { mode: 0o755 });
      for (const file of inputs.attachments) await writeFile(join(attachments, file.name), file.bytes, { mode: 0o444 });
      await codexConfig(input, inputs.profile, inputs.native);
      const channels = join(stage, 'channels');
      const judge = opts.programJudge ?? (inputs.contest.judge.kind === 'codeforces' ? codeforces(inputs.contest.judge) : undefined);
      // Create the session lazily at t=0, after the container is launched.
      let live: ReturnType<typeof match> | undefined;
      const session = () => live ??= (contestMatch = match(inputs, event, judge));
      let endRun!: (reason: string) => void;
      const terminal = new Promise<string>(resolve => { endRun = resolve; });
      closeChannels = await serveContestChannels({
        dir: channels, profile: inputs.profile, native: inputs.native, key: opts.key, signal: stopped,
        maxTurns: preset.maxTurns, requestTimeoutMs: preset.requestTimeoutMs, maxRequestBytes: preset.maxRequestBytes,
        sessionArchive: {
          dir: join(directory, 'session'),
          maxBytes: SESSION_ARCHIVE_MAX_BYTES,
          onResult: res => { sessionResult = res; },
        },
        contest: { submit: args => session().submit(args), status: id => session().status(id), close: () => session().close() },
        event, finish: () => {
          endRun('finish');
        }, fault: endRun,
      });
      sandbox = await launch(runId, opts.image, pdfPath, opts.signal, stderr, {
        input, channels, env: inputs.env, resources: preset.sandbox, onStdout: stdout,
      });
      elapsed = session().elapsed;
      started = true;
      timer = setTimeout(() => deadline.abort(), limits.time_limit_ms);
      event({ type: 'run_started', started_at: new Date().toISOString() });
      const form = judge ? `Submit programming solutions with problem_id, language (one of ${Object.keys(inputs.contest.judge.kind === 'codeforces' ? inputs.contest.judge.languages : {}).join(', ')}), and source.` :
        'Submit final answers with problem_id and answer.';
      const task = `You are competing in a timed contest. The attached images are all pages of the complete problem PDF, in order. The original is /inputs/problems.pdf. Optional contest materials are read-only in /inputs/attachments. Use the contest MCP tools: submit, status, finish. ${form} Only submissions are scored. No external resources. Work independently; call finish when done.`;
      sandbox.input.end(task);
      const end = await wait(Promise.race([terminal, sandbox.exited.then(code => code === 0 ? 'agent_ended' : 'sandbox_exited')]));
      // Immediately lock out further submissions and model inference before waiting for session flush.
      contestMatch?.close();
      closeChannels.stopInference();
      reason = end;
      status = ['finish', 'agent_ended', 'turn_limit'].includes(end) ? 'completed' : 'void';
      if (end === 'finish' || end === 'turn_limit') {
        await waitForGraceExit(sandbox.exited, opts.signal, 1_500);
      }
    } else {
    if (!opts.infer) throw new RunFailure('missing_model_adapter');
    if (inputs.contest.judge.kind !== 'local' || inputs.attachments.length) throw new RunFailure('unsupported_contest');
    sandbox = await launch(runId, opts.image, pdfPath, opts.signal, stderr);
    const workerReady = await Promise.race([wait(sandbox.frames.next()), interrupt(AbortSignal.timeout(20_000))]);
    if (workerReady.done || !ready.safeParse(workerReady.value).success) throw new RunFailure('sandbox_start_failed');
    contest = createContest(inputs.judge, event, { timeLimitMs: limits.time_limit_ms, maxSubmissions: limits.max_submissions });
    elapsed = contest.elapsed;
    started = true;
    timer = setTimeout(() => deadline.abort(), limits.time_limit_ms);
    event({ type: 'run_started', started_at: new Date().toISOString() });
    mcp = createMcp(contest);
    const [local, remote] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'cr-builtin-responses', version: '0.1.0' });
    await mcp.connect(remote);
    await client.connect(local);

    const history: ResponseInput = [{ role: 'user', content: [
      { type: 'input_file', filename: 'problems.pdf', file_data: `data:application/pdf;base64,${inputs.pdf.toString('base64')}` },
      { type: 'input_text', text: 'This is the complete contest paper. Begin the contest.' },
    ] }];
    reason = 'turn_limit';
    for (let turn = 1; turn <= preset.maxTurns; turn++) {
      const frame = await wait(sandbox.frames.next());
      if (frame.done || !next.safeParse(frame.value).success) throw new RunFailure('sandbox_protocol_error');
      if (elapsed() >= limits.time_limit_ms) { deadline.abort(); stopped.throwIfAborted(); }
      // The built-in adapter's Docker stdout is IPC. Expose its visible model
      // messages and turn activity as operator logs instead of leaking IPC frames.
      stdout(`[cr] model turn ${turn}\n`);
      event({ type: 'model_request', turn });
      const apiTimeout = AbortSignal.timeout(preset.requestTimeoutMs);
      const requestSignal = AbortSignal.any([stopped, apiTimeout]);
      const requestEnd = interrupt(requestSignal);
      const turnStart = performance.now();
      let result: Awaited<ReturnType<Infer>>;
      try {
        result = await Promise.race([opts.infer(history, requestSignal), requestEnd]);
        stopped.throwIfAborted();
      } catch {
        if (stopped.aborted) stopped.throwIfAborted();
        throw new RunFailure(apiTimeout.aborted ? 'model_timeout' : 'model_request_failed');
      }
      const durationMs = Math.max(0, Math.round(performance.now() - turnStart));
      event({ type: 'model_response', turn, model: result.model || null, request_id: result.requestId ?? null,
        response_id: result.responseId ?? null, usage: result.usage ?? null, status: result.status ?? null,
        incomplete_reason: result.incompleteReason ?? null, duration_ms: durationMs, output: result.output });
      if (result.model && result.model !== inputs.profile.model) throw new RunFailure('unexpected_model');
      if (result.status === 'incomplete' && result.incompleteReason === 'max_output_tokens') {
        reason = 'output_limit';
        await wait(send(sandbox.input, { done: true }));
        break;
      }
      if (result.status && result.status !== 'completed') throw new RunFailure('model_response_failed');
      for (const item of result.output) {
        if (item.type === 'message') for (const content of item.content) {
          if (content.type === 'output_text') stdout(content.text + '\n');
        }
      }
      const calls = result.output.filter(item => item.type === 'function_call');
      if (!calls.length) {
        reason = 'agent_ended';
        await wait(send(sandbox.input, { done: true }));
        break;
      }
      if (calls.length > 128) throw new RunFailure('model_tool_limit');
      for (const item of result.output) {
        if (item.type !== 'message' && item.type !== 'function_call') throw new RunFailure('unexpected_model_output');
        history.push(item);
      }
      await wait(send(sandbox.input, { calls: calls.length }));
      for (const [index, call] of calls.entries()) {
        const request = await wait(sandbox.frames.next());
        const parsed = tool.safeParse(request.value);
        if (request.done || !parsed.success || parsed.data.index !== index) throw new RunFailure('sandbox_protocol_error');
        if (elapsed() >= limits.time_limit_ms) { deadline.abort(); stopped.throwIfAborted(); }
        event({ type: 'tool_call', turn, call_id: call.call_id, tool: call.name });
        let args: unknown;
        try { args = JSON.parse(call.arguments); } catch { /* invalid arguments */ }
        const checked = call.name === 'submit' ? submitArgs.safeParse(args) : call.name === 'finish' ? finishArgs.safeParse(args) :
          call.name === 'status' ? statusArgs.safeParse(args && typeof args === 'object' && 'submission_id' in args && args.submission_id === null ? {} : args) : undefined;
        let output: unknown = { verdict: 'invalid_submission' };
        if (checked?.success) {
          const reply = await wait(client.callTool({ name: call.name, arguments: checked.data }));
          if (reply.isError || !reply.structuredContent) throw new RunFailure('mcp_tool_failed');
          output = reply.structuredContent;
        } else {
          event({ type: 'tool_rejected', turn, call_id: call.call_id, reason: 'invalid_arguments_or_tool' });
        }
        history.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) });
        const done = contest.finished() || (turn === preset.maxTurns && index === calls.length - 1);
        await wait(send(sandbox.input, { done }));
        if (done) break;
      }
      if (contest.finished()) { reason = 'finish'; break; }
    }
    const exitCode = await Promise.race([wait(sandbox.exited), interrupt(AbortSignal.timeout(5_000))]);
    if (exitCode !== 0) throw new RunFailure('sandbox_exited');
    status = 'completed';
    }
  } catch (error) {
    if (error instanceof SandboxCleanupError) reason = 'sandbox_cleanup_failed';
    else if (opts.signal.aborted) reason = 'interrupted';
    else if (deadline.signal.aborted && started) {
      status = 'completed';
      reason = 'time_limit';
      contestMatch?.close();
      closeChannels?.stopInference();
      if (inputs.profile.harness === 'codex' && sandbox) {
        // Gently signal bridge.js (SIGTERM) and wait up to 1.5s for session flush before force removal.
        void sandbox.stop(2);
        await waitForGraceExit(sandbox.exited, opts.signal, 1_500);
      }
    }
    else reason = error instanceof RunFailure ? error.message : !started ? 'sandbox_start_failed' : 'runner_error';
  } finally {
    contestMatch?.close();
    closeChannels?.stopInference();
    cleanup.abort();
    if (timer) clearTimeout(timer);
    let sandboxCleanupFailed = reason === 'sandbox_cleanup_failed';
    try { await sandbox?.close(); }
    catch { status = 'void'; reason = 'sandbox_cleanup_failed'; sandboxCleanupFailed = true; }
    try { await closeChannels?.(); }
    catch { status = 'void'; if (!sandboxCleanupFailed) reason = 'relay_cleanup_failed'; }
    try { await client?.close(); await mcp?.close(); }
    catch { status = 'void'; if (!sandboxCleanupFailed) reason = 'mcp_cleanup_failed'; }
    if (isCodex) {
      if (sandboxCleanupFailed) {
        sessionResult = { status: 'failed', files: [] };
        await rm(join(directory, 'session'), { recursive: true, force: true }).catch(() => {});
      }
      const tmp = `${runJsonPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, credentialJson({
          ...runMeta,
          session_archive_status: sessionResult.status,
          ...(sessionResult.files.length > 0 ? { session_files: sessionResult.files } : {}),
        }, opts.key, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(tmp, runJsonPath);
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    catch { status = 'void'; if (reason !== 'sandbox_cleanup_failed') reason = 'staging_cleanup_failed'; }
    if (contestMatch) {
      if (status === 'completed') {
        if (contestMatch.hasPending()) event({ type: 'settling' });
        try { await contestMatch.settle(AbortSignal.any([opts.signal, AbortSignal.timeout(preset.settlementMs)])); }
        catch { status = 'void'; reason = opts.signal.aborted ? 'interrupted' : 'judge_unsettled'; }
      }
      await contestMatch.dispose();
    }
    for (const writer of writers) { writer.flush(); writer.stream.end(); }
    await Promise.allSettled(writers.map(writer => writer.closed));
    event({
      type: 'run_ended', status, reason,
      score: status === 'completed' ? contestMatch?.score() ?? contest?.score() ?? 0 : null,
      max_score: inputs.contest.problems.reduce((sum, p) => sum + p.max_points, 0),
      ...(isCodex ? { session_archive_status: sessionResult.status } : {}),
      ...(sessionResult.files.length > 0 ? { session_files: sessionResult.files } : {}),
    });
    log.end();
    await logClosed;
  }
  return { runId, directory, status, reason };
}
