import { createServer, connect, type Socket } from 'node:net';
import { constants, existsSync, readdirSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_SESSION_FILES = 256;
const MAX_SESSION_ENTRIES = 2048;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_DEPTH = 8;

export async function streamSessions(
  sessionsRoot = '/workspace/.codex/sessions',
  socketPath = '/channels/session.sock',
  timeoutMs = 1200,
  limits: { maxFiles?: number; maxEntries?: number; maxBytes?: number; now?: () => number } = {},
) {
  if (!existsSync(sessionsRoot) || !existsSync(socketPath)) return;
  const maxFiles = limits.maxFiles ?? MAX_SESSION_FILES;
  const maxEntries = limits.maxEntries ?? MAX_SESSION_ENTRIES;
  const maxBytes = limits.maxBytes ?? MAX_SESSION_BYTES;
  const now = limits.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  let sock: Socket | undefined;
  try {
    sock = await new Promise<Socket>((resolveSocket, rejectSocket) => {
      const s = connect(socketPath);
      const timer = setTimeout(() => { s.destroy(); rejectSocket(new Error('timeout')); }, Math.max(100, deadline - now()));
      s.once('connect', () => { clearTimeout(timer); resolveSocket(s); });
      s.once('error', err => { clearTimeout(timer); rejectSocket(err); });
    });
  } catch { return; }

  class StreamTimeoutError extends Error {}

  const writeLine = (line: string, writeDeadline = deadline) => new Promise<void>((resolveWrite, rejectWrite) => {
    if (!sock || sock.destroyed) return rejectWrite(new Error('closed'));
    if (now() > writeDeadline) return rejectWrite(new StreamTimeoutError('timeout'));
    if (sock.write(line)) { resolveWrite(); return; }
    const timer = setTimeout(() => rejectWrite(new StreamTimeoutError('timeout')), Math.max(50, writeDeadline - now()));
    const onDrain = () => { clearTimeout(timer); sock?.off('error', onErr); sock?.off('close', onClose); resolveWrite(); };
    const onErr = (err: Error) => { clearTimeout(timer); sock?.off('drain', onDrain); sock?.off('close', onClose); rejectWrite(err); };
    const onClose = () => { clearTimeout(timer); sock?.off('drain', onDrain); sock?.off('error', onErr); rejectWrite(new Error('closed')); };
    sock.once('drain', onDrain);
    sock.once('error', onErr);
    sock.once('close', onClose);
  });

  let filesSent = 0;
  let entriesVisited = 0;
  let bytesSent = 0;
  let truncated = false;

  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    let names: string[];
    try { names = (await readdir(dir)).sort(); } catch { return; }
    for (const name of names) {
      if (now() > deadline || bytesSent >= maxBytes) { truncated = true; break; }
      if (++entriesVisited > maxEntries) { truncated = true; break; }
      if (!name || name === '.' || name === '..' || !/^[A-Za-z0-9._-]+$/.test(name)) continue;
      const full = join(dir, name);
      let info;
      try { info = await lstat(full); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const segCount = rel.split('/').length;
      if (info.isDirectory()) {
        // Receiver permits file paths with at most MAX_SESSION_DEPTH (8) segments;
        // any file inside a directory already at depth 8 would have >= 9 segments.
        if (segCount >= MAX_SESSION_DEPTH) { truncated = true; continue; }
        await walk(full, rel);
      } else if (info.isFile() && info.nlink <= 1) {
        if (segCount > MAX_SESSION_DEPTH) { truncated = true; continue; }
        if (filesSent >= maxFiles) { truncated = true; break; }
        let handle;
        try { handle = await open(full, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); } catch { continue; }
        try {
          const statInfo = await handle.stat();
          if (!statInfo.isFile() || statInfo.nlink > 1) continue;
          const buf = Buffer.alloc(48 * 1024);
          let pos = 0;
          let sentAny = false;
          while (true) {
            if (now() > deadline) { truncated = true; break; }
            const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
            if (!bytesRead) break;
            if (now() > deadline) { truncated = true; break; }
            pos += bytesRead;
            const remaining = maxBytes - bytesSent;
            if (remaining <= 0) { truncated = true; break; }
            const slice = bytesRead > remaining ? buf.subarray(0, remaining) : buf.subarray(0, bytesRead);
            bytesSent += slice.length;
            sentAny = true;
            await writeLine(JSON.stringify({ path: rel, data_base64: slice.toString('base64') }) + '\n');
            if (bytesRead > remaining) { truncated = true; break; }
          }
          if (!sentAny && !truncated) await writeLine(JSON.stringify({ path: rel, data_base64: '' }) + '\n');
          filesSent++;
        } finally {
          await handle.close().catch(() => {});
        }
      }
    }
  };

  try {
    try {
      await walk(sessionsRoot, '');
    } catch (err) {
      if (err instanceof StreamTimeoutError) truncated = true;
      else throw err;
    }
    // Always reserve a short dedicated flush budget for the terminal done/truncated frame
    // even when the walk or data write timed out, so the receiver cleanly records 'truncated' instead of 'failed'.
    const finishDeadline = Math.max(deadline, now() + 250);
    await writeLine(JSON.stringify(truncated ? { done: true, truncated: true } : { done: true }) + '\n', finishDeadline);
    await new Promise<void>(resolveClose => {
      const timer = setTimeout(() => { sock?.destroy(); resolveClose(); }, Math.max(250, finishDeadline - now()));
      sock?.once('close', () => { clearTimeout(timer); resolveClose(); });
      sock?.resume();
      sock?.end();
    });
  } catch {
    sock.destroy();
  }
}

const isEntrypoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href;

if (isEntrypoint) {
  if (process.argv[2] === 'mcp') {
    const socket = connect('/channels/mcp.sock');
    socket.on('error', () => { process.exitCode = 1; process.stdin.destroy(); });
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.once('close', () => process.stdin.destroy());
  } else {
    // Only container-local TCP is used. Docker disables all external interfaces.
    const sockets = new Set<Socket>();
    const server = createServer(client => {
      const upstream = connect('/channels/model.sock');
      sockets.add(client); sockets.add(upstream);
      client.pipe(upstream).pipe(client);
      const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
      client.on('error', close); upstream.on('error', close);
      client.on('close', close); upstream.on('close', close);
    });
    await Promise.all([
      new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(8745, '127.0.0.1', resolveListen);
      }),
      mkdir('/workspace/.codex', { recursive: true, mode: 0o700 }).then(() => copyFile('/inputs/config.toml', '/workspace/.codex/config.toml')),
    ]);
    const images = readdirSync('/inputs/pages').filter(f => /^page-\d+\.png$/.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (!images.length) throw new Error('No rendered contest pages');
    const child = spawn('codex', ['exec', '--json', '--skip-git-repo-check', '--ignore-rules', '--strict-config',
      '--dangerously-bypass-approvals-and-sandbox', ...images.flatMap(file => ['--image', join('/inputs/pages', file)]), '-'], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error', () => {});
    process.stdin.pipe(child.stdin);

    let flushing: Promise<void> | undefined;
    const flushOnce = () => (flushing ??= streamSessions());
    const childExited = new Promise<number>(resolveExit => {
      child.once('error', () => resolveExit(1));
      child.once('exit', code => resolveExit(code ?? 1));
    });
    const onSignal = () => {
      try { child.kill('SIGTERM'); } catch {}
      void Promise.race([childExited, new Promise(resolveWait => setTimeout(resolveWait, 500))])
        .then(() => flushOnce())
        .finally(() => process.exit(0));
    };
    process.once('SIGTERM', onSignal);

    process.exitCode = await childExited;
    process.off('SIGTERM', onSignal);
    await flushOnce();
    process.stdin.destroy();
    for (const socket of sockets) socket.destroy();
    server.close();
  }
}
