import Busboy from 'busboy';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join, extname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { id } from './config.js';
import { FieldError } from './agent-manifest.js';
import { protocolPresets } from './protocol.js';

const PDF = protocolPresets['icpc-5h'].pdfMaxBytes;
const ATTACHMENT = 16_000_000;
const TOTAL = 32_000_000;
const assetName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ext = /^\.[A-Za-z0-9]{1,12}$/;
const preamble = Buffer.from('%PDF-');
const uploadError = (message: string, status = 400) => new FieldError(['file'], message, status);
async function mkdirPrivate(dir: string) {
  await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.mode & 0o077) throw uploadError('Managed material directory is not private', 500);
}
export function managedMaterial(root: string, path: string, contestId: string, kind: 'entrypoint' | 'attachment') {
  if (!path.startsWith('managed/')) return undefined;
  const parts = path.split('/');
  if (parts.length !== 4 || parts[1] !== contestId || parts[2] !== kind || !assetName.test(parts[3]!)) throw uploadError('Invalid managed material reference');
  return join(root, '.materials', contestId, kind, parts[3]!);
}
// Serialize publication and the per-contest attachment quota within Studio.
let publishing = Promise.resolve();
function publish<T>(action: () => Promise<T>) {
  const next = publishing.then(action);
  publishing = next.then(() => {}, () => {});
  return next;
}
export async function uploadMaterial(root: string, req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('multipart/form-data;')) throw uploadError('Expected multipart/form-data', 415);
  if (Number(req.headers['content-length']) > PDF + 65_536) throw uploadError('Upload too large', 413);
  let parser;
  try { parser = Busboy({ headers: req.headers, preservePath: true, limits: { files: 1, fields: 2, parts: 4,
    fileSize: PDF + 1, fieldSize: 256, fieldNameSize: 32, headerPairs: 32 } }); }
  catch { throw uploadError('Invalid multipart upload'); }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = join(root, '.materials');
  await mkdirPrivate(parent);
  const temp = await mkdtemp(join(parent, '.upload-'));
  const staged = join(temp, 'data');
  try {
    const fields = new Map<string, string>();
    let name: string | undefined;
    let write: Promise<void> | undefined;
    let size = 0, header = Buffer.alloc(0);
    let error: FieldError | undefined;
    const hash = createHash('sha256');
    const reject = (message: string, status = 400) => { error ??= uploadError(message, status); };
    parser.on('field', (key, value, info) => {
      if (!['contest_id', 'kind'].includes(key) || fields.has(key) || info.valueTruncated || info.nameTruncated) reject('Invalid upload fields');
      else fields.set(key, value);
    });
    parser.on('file', (key, stream, info) => {
      if (key !== 'file' || !info.filename || !assetName.test(info.filename) || !ext.test(extname(info.filename))) {
        reject('Use a plain filename with an extension, without path separators'); stream.resume(); return;
      }
      name = info.filename;
      stream.once('limit', () => reject('Upload too large', 413));
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > PDF) reject('Upload too large', 413);
        if (header.length < 5) header = Buffer.concat([header, chunk.subarray(0, 5 - header.length)]);
        hash.update(chunk); callback(null, chunk);
      } });
      write = pipeline(stream, meter, createWriteStream(staged, { flags: 'wx', mode: 0o600 })).catch(() => { reject('Could not store upload'); });
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => reject('Too many multipart fields or files'));
    const parsed = new Promise<void>((resolve, reject) => { parser.once('close', resolve); parser.once('error', reject); });
    const onClose = () => { if (!req.complete) parser.destroy(new Error('Upload interrupted')); };
    const onError = (error: Error) => parser.destroy(error);
    req.once('close', onClose); req.once('error', onError);
    let received = 0;
    const count = (chunk: Buffer) => {
      received += chunk.length;
      if (received > PDF + 65_536) { reject('Upload too large', 413); req.unpipe(parser); parser.destroy(); req.resume(); }
    };
    req.on('data', count);
    req.pipe(parser);
    try { await parsed; }
    catch { reject('Invalid or interrupted multipart upload'); }
    finally { req.off('close', onClose); req.off('error', onError); req.off('data', count); }
    await write;
    if (error) throw error;
    const contest = id.safeParse(fields.get('contest_id'));
    const kind = fields.get('kind');
    if (!contest.success || (kind !== 'attachment' && kind !== 'entrypoint') || !name || !write || !size) throw uploadError('Expected contest_id, kind and a non-empty file');
    if (kind === 'entrypoint' && (extname(name).toLowerCase() !== '.pdf' || !header.equals(preamble))) throw uploadError('Entrypoint must be a PDF with a valid header');
    if (kind === 'attachment' && (name === 'problems.pdf' || size > ATTACHMENT)) throw uploadError('Invalid attachment name or attachment exceeds 16 MB', size > ATTACHMENT ? 413 : 400);
    const filename = name;
    return await publish(async () => {
      const contestDir = join(parent, contest.data);
      const dir = join(contestDir, kind);
      await mkdirPrivate(contestDir); await mkdirPrivate(dir);
      const entries = await readdir(dir);
      if (entries.includes(filename) || (kind === 'entrypoint' && entries.length)) throw uploadError('A material already exists at this destination', 409);
      if (kind === 'attachment') {
        const total = (await Promise.all(entries.map(x => stat(join(dir, x))))).reduce((sum, file) => sum + file.size, 0);
        if (total + size > TOTAL || entries.length >= 32) throw uploadError('Attachment limit exceeded', 413);
      }
      try { await link(staged, join(dir, filename)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw uploadError('Material already exists', 409); throw e; }
      return { path: `managed/${contest.data}/${kind}/${filename}`, name: filename, size, sha256: hash.digest('hex'), kind };
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
