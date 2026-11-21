import { createServer, connect, type Socket } from 'node:net';
import { copyFile, mkdir } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

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
    mkdir('/workspace/.codex', { mode: 0o700 }).then(() => copyFile('/inputs/config.toml', '/workspace/.codex/config.toml')),
  ]);
  const images = readdirSync('/inputs/pages').filter(f => /^page-\d+\.png$/.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!images.length) throw new Error('No rendered contest pages');
  const child = spawn('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--strict-config',
    '--dangerously-bypass-approvals-and-sandbox', ...images.flatMap(file => ['--image', join('/inputs/pages', file)]), '-'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  process.stdin.pipe(child.stdin);
  process.exitCode = await new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1)); });
  process.stdin.destroy();
  for (const socket of sockets) socket.destroy();
  server.close();
}
