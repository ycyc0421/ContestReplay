import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { frames } from './wire.js';
import { type AgentProfile } from './config.js';
import { harness, type HarnessEnv } from './harnesses.js';
import { protocolPresets, type SandboxResources } from './protocol.js';

const docker = promisify(execFile);
const image = 'cr-bench:0.1.0';
export const codexImage = harness('codex').image;
export const imageFor = (kind: AgentProfile['harness']) => harness(kind).image;
export async function inspectImage(ref = image) {
  try {
    const { stdout } = await docker('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { timeout: 10_000 });
    const id = stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error('Invalid image ID');
    return id;
  } catch {
    throw new Error(`Docker image ${ref} unavailable; see README for image build commands`);
  }
}

export class SandboxCleanupError extends Error {
  constructor(cause: unknown) { super('Could not clean up the sandbox', { cause }); }
}

export const resources = Object.freeze({ memory: '256m', cpus: '1', pids: 64, workspace: '32m' });
export async function removeContainer(id: string) {
  const name = `cr-${id}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await docker('docker', ['rm', '-f', name], { timeout: 10_000 }); return; }
    catch (error) {
      const stderr = String((error as { stderr?: string }).stderr);
      if (stderr.includes('No such container')) return;
      if (!stderr.includes('removal') || !stderr.includes('already in progress')) throw new Error(`Could not remove ${name}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Could not confirm removal of ${name}`);
}

export async function launch(id: string, imageId: string, pdfPath: string, signal: AbortSignal, onStderr?: (chunk: Buffer) => void,
  codex?: { input: string; channels: string; env?: HarnessEnv; resources?: SandboxResources; onStdout: (chunk: Buffer) => void }) {
  if ([pdfPath, codex?.input, codex?.channels].some(path => path?.includes(','))) throw new Error('Docker PDF staging path cannot contain a comma');
  const name = `cr-${id}`;
  const limits = codex ? (codex.resources ?? protocolPresets.short.sandbox) : resources;
  const args = [
    'create', '--rm', '--pull=never', '--name', name, '--label', `org.contestreplay.run=${id}`, '-i',
    '--network=none', '--read-only', '--user', '1000:1000', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit', String(limits.pids),
    '--memory', limits.memory, '--cpus', limits.cpus, '--log-driver=none',
    '--tmpfs', codex ? `/workspace:rw,nosuid,nodev,exec,size=${limits.workspace},uid=1000,gid=1000,mode=0700` : `/workspace:rw,nosuid,nodev,noexec,size=${resources.workspace},uid=1000,gid=1000,mode=0700`,
    '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${codex ? 128 : 8}m`, '--workdir', '/workspace', '--env', 'HOME=/workspace',
    ...(codex ? ['--env', 'CODEX_HOME=/workspace/.codex',
      ...Object.entries(harness('codex').env.parse(codex.env ?? {})).flatMap(([key, value]) => value ? ['--env', `${key}=${value}`] : []),
      '--mount', `type=bind,source=${codex.input},target=/inputs,readonly`,
      '--mount', `type=bind,source=${codex.channels},target=/channels,readonly`]
      : ['--mount', `type=bind,source=${pdfPath},target=/inputs/problems.pdf,readonly`]),
    '--entrypoint', 'node', imageId, codex ? '/app/bridge.js' : '/app/worker.js',
  ];
  let containerId: string;
  try {
    // Wait for create to finish rather than racing removal against docker run.
    const { stdout } = await docker('docker', args, { timeout: 15_000 });
    containerId = stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Invalid created container ID');
    signal.throwIfAborted();
  } catch (error) {
    try { await removeContainer(id); }
    catch (cause) { throw new SandboxCleanupError(cause); }
    throw error;
  }
  // Attach by immutable ID; a concurrent remove cannot make start create or
  // attach to a replacement container.
  const child = spawn('docker', ['start', '-a', '-i', containerId], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk: Buffer) => onStderr?.(chunk)); // Separate from control and scoring.
  if (codex) child.stdout.on('data', (chunk: Buffer) => codex.onStdout(chunk));
  child.stdin.on('error', () => {}); // send() reports write failures.
  const exited = new Promise<number|null>(resolve => {
    child.once('error', () => resolve(null));
    child.once('close', code => resolve(code));
  });
  const close = async () => {
    try { await removeContainer(id); }
    finally {
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill();
    }
  };
  return { input: child.stdin, frames: frames(child.stdout), exited, close };
}

// Render untrusted PDFs inside a networkless image rather than in the host process.
export async function renderPdf(id: string, image: string, input: string, pages: string, signal: AbortSignal,
  limits?: { maxPages?: number; maxBytes?: number }) {
  if ([input, pages].some(p => p.includes(','))) throw new Error('Docker mount paths cannot contain a comma');
  const maxPages = limits?.maxPages ?? protocolPresets.short.pdfMaxPages;
  const maxBytes = limits?.maxBytes ?? protocolPresets.short.pdfMaxBytes;
  const args = ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--memory', '1g', '--cpus', '1', '--pids-limit', '16',
    '--mount', `type=bind,source=${input},target=/paper.pdf,readonly`];
  const renderId = `render-${id}`;
  try {
    const run = (entry: string, rest: string[], more: string[] = []) => docker('docker', [...args, '--name', `cr-${renderId}`, ...more,
      '--entrypoint', entry, image, ...rest], { timeout: 120_000, signal, maxBuffer: 65_536 });
    const { stdout } = await run('pdfinfo', ['/paper.pdf']);
    const count = Number(stdout.match(/^Pages:\s*(\d+)\s*$/m)?.[1]);
    if (!Number.isInteger(count) || count < 1 || count > maxPages) throw new Error(`Codex transport requires 1–${maxPages} PDF pages`);
    await run('pdftoppm', ['-png', '-scale-to', '1600', '/paper.pdf', '/pages/page'], ['--mount', `type=bind,source=${pages},target=/pages`]);
    const { readdir, stat } = await import('node:fs/promises');
    const files = await readdir(pages);
    if (files.length !== count || !files.every(f => /^page-\d+\.png$/.test(f))) throw new Error('PDF rendering produced an incomplete page set');
    const sizes = await Promise.all(files.map(f => stat(`${pages}/${f}`)));
    if (sizes.reduce((sum, s) => sum + s.size, 0) > maxBytes) throw new Error(`Rendered PDF exceeds ${Math.round(maxBytes / 1_000_000)} MB`);
  } catch (error) {
    try { await removeContainer(renderId); } catch (cause) { throw new SandboxCleanupError(cause); }
    throw error;
  }
}
