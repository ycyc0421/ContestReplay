import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'studio');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
};

export const studioCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export async function serveStudioStatic(path: string, res: ServerResponse) {
  let pathname: string;
  try { pathname = decodeURIComponent(path); } catch { return false; }
  // Never serve workspace/private files even if --workspace points inside dist.
  const asset = /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|png|svg|woff2)$/.test(pathname);
  if (extname(pathname) && !asset && !['/favicon.svg', '/studio.js', '/index.html'].includes(pathname)) return false;
  const relative = pathname === '/' || !extname(pathname) ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return false;
  try {
    const content = await readFile(target);
    res.writeHead(200, {
      'Content-Type': types[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': studioCsp,
      'Referrer-Policy': 'no-referrer',
    });
    res.end(content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative === 'index.html') {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': studioCsp });
      res.end('Studio assets are not built. Run pnpm build first.');
      return true;
    }
    return false;
  }
}
