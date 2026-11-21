import { createServer, connect, type Socket } from 'node:net';
import { constants, existsSync, readdirSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

async function streamSessions(sessionsRoot = '/workspace/.codex/sessions', socketPath = '/channels/session.sock', timeoutMs = 1200) {
  if (!existsSync(sessionsRoot) || !existsSync(socketPath)) return;
  const deadline = Date.now() + timeoutMs;
  let sock: Socket | undefined;
  try {
    sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect(socketPath);
      const timer = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, Math.max(100, deadline - Date.now()));
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', err => { clearTimeout(timer); reject(err); });
    });
  } catch { return; }

  const writeLine = (line: string) => new Promise<void>((resolve, reject) => {
    if (!sock || sock.destroyed) return reject(new Error('closed'));
    if (Date.now() > deadline) return reject(new Error('timeout'));
    if (sock.write(line)) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('timeout')), Math.max(50, deadline - Date.now()));
    const onDrain = () => { clearTimeout(timer); sock?.off('error', onErr); sock?.off('close', onClose); resolve(); };
    const onErr = (err: Error) => { clearTimeout(timer); sock?.off('drain', onDrain); sock?.off('close', onClose); reject(err); };
    const onClose = () => { clearTimeout(timer); sock?.off('drain', onDrain); sock?.off('error', onErr); reject(new Error('closed')); };
    sock.once('drain', onDrain);
    sock.once('error', onErr);
    sock.once('close', onClose);
  });

  let filesSent = 0;
  let entriesVisited = 0;
  const walk = async (dir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > 8 || filesSent >= 256 || entriesVisited >= 2048 || Date.now() > deadline) return;
    let names: string[];
    try { names = (await readdir(dir)).sort(); } catch { return; }
    for (const name of names) {
      if (filesSent >= 256 || ++entriesVisited > 2048 || Date.now() > deadline) break;
      if (!name || name === '.' || name === '..' || !/^[A-Za-z0-9._-]+$/.test(name)) continue;
      const full = join(dir, name);
      let info;
      try { info = await lstat(full); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (info.isDirectory()) {
        await walk(full, rel, depth + 1);
      } else if (info.isFile() && info.nlink <= 1) {
        let handle;
        try { handle = await open(full, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); } catch { continue; }
        try {
          const statInfo = await handle.stat();
          if (!statInfo.isFile() || statInfo.nlink > 1) continue;
          const buf = Buffer.alloc(48 * 1024);
          let pos = 0;
          let sentAny = false;
          while (Date.now() <= deadline) {
            const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
            if (!bytesRead) break;
            pos += bytesRead;
            sentAny = true;
            await writeLine(JSON.stringify({ path: rel, data_base64: buf.subarray(0, bytesRead).toString('base64') }) + '\n');
          }
          if (!sentAny) await writeLine(JSON.stringify({ path: rel, data_base64: '' }) + '\n');
          filesSent++;
        } finally {
          await handle.close().catch(() => {});
        }
      }
    }
  };

  try {
    await walk(sessionsRoot, '', 0);
    await writeLine(JSON.stringify({ done: true }) + '\n');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { sock?.destroy(); resolve(); }, Math.max(50, deadline - Date.now()));
      sock?.once('close', () => { clearTimeout(timer); resolve(); });
      sock?.resume();
      sock?.end();
    });
  } catch {
    sock.destroy();
  }
}

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
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(8745, '127.0.0.1', resolve);
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
  const childExited = new Promise<number>(resolve => {
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 1));
  });
  const onSignal = () => {
    try { child.kill('SIGTERM'); } catch {}
    void Promise.race([childExited, new Promise(resolve => setTimeout(resolve, 500))])
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
