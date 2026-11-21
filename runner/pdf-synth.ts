import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { z } from 'zod';
import { sha256 } from './config.js';

const execFileAsync = promisify(execFileCb);

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], {
    encoding: 'utf8',
    timeout: options?.timeout ?? 15_000,
    maxBuffer: options?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export const detectedProblemHeaderSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
});
export type DetectedProblemHeader = z.infer<typeof detectedProblemHeaderSchema>;

export const pdfInfoSchema = z.strictObject({
  path: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  page_count: z.number().int().nonnegative(),
  problems: z.array(detectedProblemHeaderSchema),
  problem_ids: z.array(z.string().min(1)),
  text_length: z.number().int().nonnegative(),
  text_truncated: z.boolean(),
  extractor: z.enum(['poppler', 'fallback']),
});
export type PdfInfo = z.infer<typeof pdfInfoSchema>;

export const pdfLimitsCheckSchema = z.strictObject({
  ok: z.boolean(),
  issues: z.array(z.string()),
});
export type PdfLimitsCheck = z.infer<typeof pdfLimitsCheckSchema>;

export const mergePdfsResultSchema = z.strictObject({
  output_path: z.string().min(1),
  input_count: z.number().int().positive(),
  size_bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  tool: z.enum(['pdfunite', 'qpdf', 'copy']),
});
export type MergePdfsResult = z.infer<typeof mergePdfsResultSchema>;

export const synthSampleSchema = z.strictObject({
  input: z.string().max(256_000),
  output: z.string().max(256_000),
});

export const synthProblemSchema = z.strictObject({
  id: z.string().trim().min(1).max(32),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(1_000_000),
  samples: z.array(synthSampleSchema).max(32).optional(),
});
export type SynthProblem = z.infer<typeof synthProblemSchema>;

export const synthPdfResultSchema = z.strictObject({
  output_path: z.string().min(1),
  page_count: z.number().int().positive(),
  size_bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  problem_ids: z.array(z.string().min(1)),
  warnings: z.array(z.string()),
});
export type SynthPdfResult = z.infer<typeof synthPdfResultSchema>;

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_STREAM_INFLATE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INFLATE_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

async function withPrivateTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cr-pdf-'));
  await chmod(dir, 0o700);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readRegularPdfFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (info.size === 0) throw new Error(`PDF file is empty: ${filePath}`);
    if (info.size > maxBytes) throw new Error(`PDF file exceeds ${maxBytes} bytes: ${filePath}`);
    const bytes = Buffer.alloc(info.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const res = await handle.read(bytes, read, bytes.length - read, read);
      if (!res.bytesRead) break;
      read += res.bytesRead;
    }
    if (read !== info.size) throw new Error(`File changed while reading: ${filePath}`);
    const result = bytes.subarray(0, read);
    if (result.length < 5 || !result.subarray(0, 5).equals(PDF_MAGIC)) {
      throw new Error(`Invalid PDF header (expected %PDF-): ${filePath}`);
    }
    return result;
  } finally {
    await handle.close();
  }
}

function stripPdfStreamsForStructure(latin: string): string {
  return latin.replace(/stream\r?\n[\s\S]*?endstream/g, 'stream\nendstream');
}

export function parsePdfPageCountFallback(bytes: Buffer): number {
  const structure = stripPdfStreamsForStructure(bytes.toString('latin1'));

  // Parse all indirect objects into a map so dictionary key ordering never matters.
  const objects = new Map<string, string>();
  const objPattern = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g;
  for (const match of structure.matchAll(objPattern)) {
    const key = `${match[1]!} ${match[2]!}`;
    objects.set(key, match[3] ?? '');
  }

  // 1. Follow /Catalog -> /Pages <obj> <gen> R -> /Count N regardless of dictionary key order.
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Catalog\b/.test(body)) continue;
    const pagesRef = body.match(/\/Pages\s+(\d+)\s+(\d+)\s+R\b/);
    if (!pagesRef) continue;
    const pagesBody = objects.get(`${pagesRef[1]!} ${pagesRef[2]!}`);
    const countMatch = pagesBody?.match(/\/Count\s+(\d+)/);
    if (countMatch) {
      const parsed = Number.parseInt(countMatch[1]!, 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }

  // 2. Count leaf /Type /Page objects (explicitly excluding /Type /Pages).
  let leafCount = 0;
  for (const body of objects.values()) {
    if (/\/Type\s*\/Page(?![A-Za-z])/.test(body)) leafCount++;
  }
  if (leafCount > 0) return leafCount;

  // 3. Fallback to max /Count found in any /Type /Pages object (order-independent).
  let maxCount = 0;
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Pages\b/.test(body)) continue;
    const countMatch = body.match(/\/Count\s+(\d+)/);
    if (countMatch) {
      const n = Number.parseInt(countMatch[1]!, 10);
      if (Number.isInteger(n) && n > maxCount) maxCount = n;
    }
  }
  return maxCount;
}

function decodePdfLiteralString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    i++;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (next === '\r' || next === '\n') {
      if (next === '\r' && raw[i + 1] === '\n') i++;
    } else if (next >= '0' && next <= '7') {
      let octal = next;
      for (let k = 0; k < 2 && i + 1 < raw.length; k++) {
        const digit = raw[i + 1]!;
        if (digit >= '0' && digit <= '7') {
          octal += digit;
          i++;
        } else break;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else {
      out += next;
    }
  }
  return out;
}

function extractTextFromContentStream(streamContent: string): string {
  const lines: string[] = [];
  const btBlocks = streamContent.matchAll(/\bBT\b([\s\S]*?)\bET\b/g);

  for (const block of btBlocks) {
    const body = block[1] ?? '';
    let currentLine = '';
    let i = 0;
    while (i < body.length) {
      const ch = body[i]!;
      if (ch === '(') {
        let depth = 1;
        let str = '';
        i++;
        while (i < body.length && depth > 0) {
          const c = body[i]!;
          if (c === '\\' && i + 1 < body.length) {
            str += c + body[i + 1]!;
            i += 2;
            continue;
          }
          if (c === '(') depth++;
          else if (c === ')') {
            depth--;
            if (depth === 0) { i++; break; }
          }
          str += c;
          i++;
        }
        currentLine += decodePdfLiteralString(str);
      } else if (body.startsWith('T*', i) && (i === 0 || /\s/.test(body[i - 1]!))) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = '';
        i += 2;
      } else if (
        (body.startsWith('Td', i) || body.startsWith('TD', i) || body.startsWith('Tm', i)) &&
        (i === 0 || /\s/.test(body[i - 1]!)) &&
        (i + 2 >= body.length || /\s|\(|\[/.test(body[i + 2]!))
      ) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = '';
        i += 2;
      } else {
        i++;
      }
    }
    if (currentLine.trim()) lines.push(currentLine.trim());
  }

  return lines.join('\n');
}

const NON_TEXT_STREAM_DICT = /\/Subtype\s*\/(?:Image|XML)\b|\/FontFile[23]?\b|\/Type\s*\/(?:ObjStm|XRef|Metadata)\b/;

export function extractPdfTextFallbackDetailed(
  bytes: Buffer,
  limits: { maxStreamInflateBytes?: number; maxTotalInflateBytes?: number; maxTextChars?: number } = {},
): { text: string; truncated: boolean } {
  const maxStreamInflate = limits.maxStreamInflateBytes ?? MAX_STREAM_INFLATE_BYTES;
  const maxTotalInflate = limits.maxTotalInflateBytes ?? MAX_TOTAL_INFLATE_BYTES;
  const maxTextChars = limits.maxTextChars ?? MAX_EXTRACTED_TEXT_CHARS;

  const latin = bytes.toString('latin1');
  const chunks: string[] = [];
  let totalInflated = 0;
  let totalTextChars = 0;
  let truncated = false;
  let cursor = 0;

  while (cursor < latin.length) {
    const streamIdx = latin.indexOf('stream', cursor);
    if (streamIdx === -1) break;
    if (streamIdx >= 3 && latin.slice(streamIdx - 3, streamIdx) === 'end') {
      cursor = streamIdx + 6;
      continue;
    }
    let dataStart = streamIdx + 6;
    if (latin[dataStart] === '\r' && latin[dataStart + 1] === '\n') dataStart += 2;
    else if (latin[dataStart] === '\n') dataStart += 1;
    else {
      cursor = streamIdx + 6;
      continue;
    }

    const endIdx = latin.indexOf('endstream', dataStart);
    if (endIdx === -1) break;

    const prevEndObj = latin.lastIndexOf('endobj', streamIdx);
    const windowStart = Math.max(prevEndObj === -1 ? 0 : prevEndObj + 6, streamIdx - 4096);
    const dictWindow = latin.slice(windowStart, streamIdx);
    let dataEnd = endIdx;
    if (dataEnd > dataStart && bytes[dataEnd - 1] === 0x0a) dataEnd--;
    if (dataEnd > dataStart && bytes[dataEnd - 1] === 0x0d) dataEnd--;

    cursor = endIdx + 9;

    // Skip non-text binary/metadata streams before touching or inflating them.
    if (NON_TEXT_STREAM_DICT.test(dictWindow)) continue;

    const rawSlice = bytes.subarray(dataStart, dataEnd);
    let contentText: string | undefined;

    if (/\/Filter\s*(?:\[\s*)?\/FlateDecode\b/.test(dictWindow)) {
      const remainingBudget = maxTotalInflate - totalInflated;
      if (remainingBudget <= 0) {
        truncated = true;
        break;
      }
      const streamLimit = Math.min(maxStreamInflate, remainingBudget);
      try {
        const inflated = inflateSync(rawSlice, { maxOutputLength: streamLimit });
        totalInflated += inflated.length;
        contentText = inflated.toString('latin1');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ERR_BUFFER_TOO_LARGE' || /output length/i.test(String((error as Error)?.message ?? ''))) {
          // Stop immediately on the first decompression-bomb stream to bound CPU/memory work.
          truncated = true;
          break;
        }
        contentText = undefined;
      }
    } else {
      if (rawSlice.length > maxStreamInflate || totalInflated + rawSlice.length > maxTotalInflate) {
        truncated = true;
        continue;
      }
      totalInflated += rawSlice.length;
      contentText = rawSlice.toString('latin1');
    }

    if (contentText && contentText.includes('BT') && contentText.includes('ET')) {
      const extracted = extractTextFromContentStream(contentText);
      if (extracted) {
        if (totalTextChars + extracted.length > maxTextChars) {
          const room = Math.max(0, maxTextChars - totalTextChars);
          if (room > 0) chunks.push(extracted.slice(0, room));
          truncated = true;
          break;
        }
        chunks.push(extracted);
        totalTextChars += extracted.length;
      }
    }
  }

  return { text: chunks.join('\n'), truncated };
}

export function extractPdfTextFallback(bytes: Buffer): string {
  return extractPdfTextFallbackDetailed(bytes).text;
}

function normalizeProblemId(rawId: string): string {
  const trimmed = rawId.trim().toUpperCase();
  if (/^\d+$/.test(trimmed)) return String(Number.parseInt(trimmed, 10));
  return trimmed;
}

function cleanHeaderTitle(rawTitle: string | undefined): string {
  if (!rawTitle) return '';
  return rawTitle.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function detectProblemHeaders(text: string): DetectedProblemHeader[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  type Candidate = { id: string; title: string; kind: 'explicit' | 'bare-letter' | 'bare-numeric' };
  const candidates: Candidate[] = [];

  // Require capitalized keyword (Problem/PROBLEM/Task/TASK/Question/QUESTION) and uppercase letter or digit ID
  // so prose lines like "problem a is easy" do not trigger false positives.
  const explicitEn = /^(?:Problem|PROBLEM|Task|TASK|Question|QUESTION)\s+([A-Z]\d?|\d{1,2})(?:\s*[:.\-–—]\s*(.*)|\s+(.+))?$/;
  const explicitZh1 = /^第\s*([A-Za-z]\d?|\d{1,2})\s*题(?:[\s:：.\-–—]*(.*))?$/;
  const explicitZh2 = /^(?:题目|问题)\s*([A-Za-z]\d?|\d{1,2})(?:[\s:：.\-–—]+(.*))?$/;
  const bareLetterRe = /^([A-Z]\d?)\.\s+(.{2,140})$/;
  const bareNumericRe = /^(\d{1,2})\.\s+(.{2,140})$/;

  for (const line of lines) {
    if (line.length > 180) continue;

    const mEn = line.match(explicitEn);
    if (mEn) {
      candidates.push({ id: normalizeProblemId(mEn[1]!), title: cleanHeaderTitle(mEn[2] ?? mEn[3]), kind: 'explicit' });
      continue;
    }

    const mZh1 = line.match(explicitZh1);
    if (mZh1) {
      candidates.push({ id: normalizeProblemId(mZh1[1]!), title: cleanHeaderTitle(mZh1[2]), kind: 'explicit' });
      continue;
    }

    const mZh2 = line.match(explicitZh2);
    if (mZh2) {
      candidates.push({ id: normalizeProblemId(mZh2[1]!), title: cleanHeaderTitle(mZh2[2]), kind: 'explicit' });
      continue;
    }

    const mLetter = line.match(bareLetterRe);
    if (mLetter) {
      candidates.push({ id: normalizeProblemId(mLetter[1]!), title: cleanHeaderTitle(mLetter[2]), kind: 'bare-letter' });
      continue;
    }

    const mNum = line.match(bareNumericRe);
    if (mNum) {
      candidates.push({ id: normalizeProblemId(mNum[1]!), title: cleanHeaderTitle(mNum[2]), kind: 'bare-numeric' });
    }
  }

  const hasExplicit = candidates.some(c => c.kind === 'explicit');
  const explicitUsesLetters = candidates.some(c => c.kind === 'explicit' && /^[A-Z]/.test(c.id));
  const hasBareLetter = candidates.some(c => c.kind === 'bare-letter');

  let allowedKinds: Set<Candidate['kind']>;
  if (hasExplicit) {
    // Allow mixed letter format (e.g., "Problem A: Alpha" followed by "B. Beta") while excluding numbered statement lists.
    allowedKinds = explicitUsesLetters ? new Set(['explicit', 'bare-letter']) : new Set(['explicit']);
  } else if (hasBareLetter) {
    allowedKinds = new Set(['bare-letter']);
  } else {
    allowedKinds = new Set(['bare-numeric']);
  }

  const out: DetectedProblemHeader[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!allowedKinds.has(c.kind) || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, title: c.title });
  }
  return out;
}

export async function inspectPdf(
  pdfPath: string,
  opts: { execImpl?: ExecFileFn; useExternalTools?: boolean; maxBytes?: number } = {},
): Promise<PdfInfo> {
  const resolvedPath = resolve(pdfPath);
  const maxBytes = opts.maxBytes ?? 128 * 1024 * 1024;
  const bytes = await readRegularPdfFile(resolvedPath, maxBytes);
  const digest = sha256(bytes);

  const execFn = opts.execImpl ?? defaultExecFile;
  const useExternal = opts.useExternalTools !== false;

  let pageCount: number | undefined;
  let text: string | undefined;
  let textTruncated = false;
  let usedPoppler = false;

  if (useExternal) {
    // Feed external tools a private 0o600 snapshot of the exact verified bytes to prevent TOCTOU swaps.
    await withPrivateTempDir(async snapDir => {
      const snapPath = join(snapDir, 'input.pdf');
      await writeFile(snapPath, bytes, { mode: 0o600, flag: 'wx' });

      try {
        const infoRes = await execFn('pdfinfo', ['--', snapPath], { timeout: 10_000 });
        const pagesMatch = infoRes.stdout.match(/^Pages:\s+(\d+)/m);
        if (pagesMatch) {
          pageCount = Number.parseInt(pagesMatch[1]!, 10);
          usedPoppler = true;
        }
      } catch {
        // Fallback to pure-JS PDF page count parser below.
      }

      try {
        const textRes = await execFn('pdftotext', ['-enc', 'UTF-8', snapPath, '-'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
        if (textRes.stdout.length > MAX_EXTRACTED_TEXT_CHARS) {
          text = textRes.stdout.slice(0, MAX_EXTRACTED_TEXT_CHARS);
          textTruncated = true;
        } else {
          text = textRes.stdout;
        }
        usedPoppler = true;
      } catch {
        // Fallback to pure-JS literal text extractor below.
      }
    });
  }

  if (pageCount === undefined) {
    pageCount = parsePdfPageCountFallback(bytes);
  }
  if (text === undefined) {
    const detailed = extractPdfTextFallbackDetailed(bytes);
    text = detailed.text;
    textTruncated = detailed.truncated;
  }

  const problems = detectProblemHeaders(text);
  return pdfInfoSchema.parse({
    path: resolvedPath,
    size_bytes: bytes.length,
    sha256: digest,
    page_count: pageCount,
    problems,
    problem_ids: problems.map(p => p.id),
    text_length: text.length,
    text_truncated: textTruncated,
    extractor: usedPoppler ? 'poppler' : 'fallback',
  });
}

export function checkPdfLimits(
  info: Pick<PdfInfo, 'page_count' | 'size_bytes'>,
  limits: { maxPages: number; maxBytes: number },
): PdfLimitsCheck {
  const issues: string[] = [];
  if (!Number.isInteger(limits.maxPages) || limits.maxPages < 1) {
    throw new Error('limits.maxPages must be a positive integer');
  }
  if (!Number.isFinite(limits.maxBytes) || limits.maxBytes < 1) {
    throw new Error('limits.maxBytes must be a positive number');
  }

  if (info.page_count <= 0) {
    issues.push('PDF page count could not be determined or is 0');
  } else if (info.page_count > limits.maxPages) {
    issues.push(`PDF has ${info.page_count} pages, exceeding maximum of ${limits.maxPages}`);
  }

  if (info.size_bytes <= 0) {
    issues.push('PDF file is empty');
  } else if (info.size_bytes > limits.maxBytes) {
    issues.push(`PDF size (${info.size_bytes} bytes) exceeds maximum of ${limits.maxBytes} bytes`);
  }

  return pdfLimitsCheckSchema.parse({ ok: issues.length === 0, issues });
}

function isCommandNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT';
}

export async function mergePdfs(
  inputPaths: string[],
  outputPath: string,
  opts: { maxTotalBytes?: number; overwrite?: boolean; execImpl?: ExecFileFn } = {},
): Promise<MergePdfsResult> {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('At least one input PDF is required');
  }
  const maxTotalBytes = opts.maxTotalBytes ?? 64 * 1024 * 1024;
  const overwrite = opts.overwrite === true;
  const resolvedOutput = resolve(outputPath);

  if (!overwrite) {
    try {
      await lstat(resolvedOutput);
      throw new Error(`Output PDF already exists (pass overwrite: true to replace): ${resolvedOutput}`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  const resolvedInputs = inputPaths.map(p => resolve(p));
  const verifiedBuffers: Buffer[] = [];
  let totalBytes = 0;

  for (const inputPath of resolvedInputs) {
    const bytes = await readRegularPdfFile(inputPath, maxTotalBytes);
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Combined input PDF size (${totalBytes} bytes) exceeds budget of ${maxTotalBytes} bytes`);
    }
    verifiedBuffers.push(bytes);
  }

  await mkdir(dirname(resolvedOutput), { recursive: true });
  const tempOutput = `${resolvedOutput}.${randomUUID()}.tmp.pdf`;
  const execFn = opts.execImpl ?? defaultExecFile;
  let toolUsed: 'pdfunite' | 'qpdf' | 'copy' = 'pdfunite';

  try {
    if (verifiedBuffers.length === 1 && !opts.execImpl) {
      await writeFile(tempOutput, verifiedBuffers[0]!, { mode: 0o600, flag: 'wx' });
      toolUsed = 'copy';
    } else {
      // Write validated input bytes to private 0o600 snapshots so external tools cannot see TOCTOU swaps.
      await withPrivateTempDir(async snapDir => {
        const snapInputs: string[] = [];
        for (let i = 0; i < verifiedBuffers.length; i++) {
          const snapPath = join(snapDir, `in-${i}.pdf`);
          await writeFile(snapPath, verifiedBuffers[i]!, { mode: 0o600, flag: 'wx' });
          snapInputs.push(snapPath);
        }

        try {
          await execFn('pdfunite', [...snapInputs, tempOutput], { timeout: 60_000 });
          toolUsed = 'pdfunite';
        } catch (firstError) {
          if (!isCommandNotFound(firstError)) {
            throw new Error(`pdfunite failed: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
          }
          try {
            await execFn('qpdf', ['--empty', '--pages', ...snapInputs, '--', tempOutput], { timeout: 60_000 });
            toolUsed = 'qpdf';
          } catch (secondError) {
            if (isCommandNotFound(secondError)) {
              throw new Error(
                'No PDF merge tool found on PATH. Install poppler-utils (pdfunite) or qpdf ' +
                '(e.g. apt install poppler-utils, brew install poppler, or pacman -S poppler qpdf).',
              );
            }
            throw new Error(`qpdf failed: ${secondError instanceof Error ? secondError.message : String(secondError)}`);
          }
        }
      });
    }

    const mergedBytes = await readRegularPdfFile(tempOutput, maxTotalBytes * 2);
    if (overwrite) await rename(tempOutput, resolvedOutput);
    else await link(tempOutput, resolvedOutput);

    return mergePdfsResultSchema.parse({
      output_path: resolvedOutput,
      input_count: resolvedInputs.length,
      size_bytes: mergedBytes.length,
      sha256: sha256(mergedBytes),
      tool: toolUsed,
    });
  } finally {
    await rm(tempOutput, { force: true });
  }
}

const LOSSY_ASCII_MAP: Record<string, string> = {
  '\t': '    ',
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u2013': '-',
  '\u2014': '--',
  '\u2026': '...',
  '\u00A0': ' ',
  '\u2264': '<=',
  '\u2265': '>=',
  '\u00D7': 'x',
};

function encodePdfAscii(
  text: string,
  allowAsciiFallback: boolean,
  opts: { allowTabExpansion?: boolean } = {},
): { text: string; replacedCount: number } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let out = '';
  let replacedCount = 0;
  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    if (ch === '\n' || (code >= 0x20 && code <= 0x7e)) {
      out += ch;
    } else if (ch === '\t' && opts.allowTabExpansion) {
      out += '    ';
    } else if (allowAsciiFallback) {
      out += LOSSY_ASCII_MAP[ch] ?? '?';
      replacedCount++;
    } else {
      throw new Error(
        'synthesizeTextContestPdf uses PDF Base-14 ASCII/Type1 fonts and refuses lossy character rewriting ' +
        '(non-ASCII symbols or verbatim sample tabs). Use lossless ASCII or pass allowAsciiFallback: true.',
      );
    }
  }
  return { text: out, replacedCount };
}

function escapePdfString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapText(text: string, maxChars: number, allowAsciiFallback: boolean): { lines: string[]; replacedCount: number } {
  const encoded = encodePdfAscii(text, allowAsciiFallback, { allowTabExpansion: true });
  const paragraphs = encoded.text.split('\n');
  const wrapped: string[] = [];

  for (const para of paragraphs) {
    if (!para.trim()) {
      wrapped.push('');
      continue;
    }
    const words = para.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (!word) continue;
      if (word.length > maxChars) {
        if (current) { wrapped.push(current); current = ''; }
        for (let i = 0; i < word.length; i += maxChars) {
          wrapped.push(word.slice(i, i + maxChars));
        }
        continue;
      }
      if (!current) {
        current = word;
      } else if (current.length + 1 + word.length <= maxChars) {
        current += ' ' + word;
      } else {
        wrapped.push(current);
        current = word;
      }
    }
    if (current) wrapped.push(current);
  }
  return { lines: wrapped, replacedCount: encoded.replacedCount };
}

function wrapVerbatimLines(text: string, maxChars: number, allowAsciiFallback: boolean): { lines: string[]; replacedCount: number } {
  const encoded = encodePdfAscii(text, allowAsciiFallback, { allowTabExpansion: false });
  const rawLines = encoded.text.split('\n');
  const out: string[] = [];
  for (const line of rawLines) {
    if (line.length <= maxChars) {
      out.push(line);
    } else {
      for (let i = 0; i < line.length; i += maxChars) {
        out.push(line.slice(i, i + maxChars));
      }
    }
  }
  return { lines: out.length ? out : [''], replacedCount: encoded.replacedCount };
}

export async function synthesizeTextContestPdf(
  rawProblems: SynthProblem[],
  outputPath: string,
  opts: { title?: string; subtitle?: string; overwrite?: boolean; allowAsciiFallback?: boolean } = {},
): Promise<SynthPdfResult> {
  const problems = z.array(synthProblemSchema).min(1).max(100).parse(rawProblems);
  const resolvedOutput = resolve(outputPath);
  const overwrite = opts.overwrite === true;
  const allowAsciiFallback = opts.allowAsciiFallback === true;

  if (!overwrite) {
    try {
      await lstat(resolvedOutput);
      throw new Error(`Output PDF already exists (pass overwrite: true to replace): ${resolvedOutput}`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  const pageWidth = 612;
  const pageHeight = 792;
  const marginX = 54;
  const topY = 738;
  const bottomY = 66;
  const contentWidth = pageWidth - marginX * 2;

  const pages: string[][] = [];
  let cmds: string[] = [];
  let y = topY;
  let totalReplacedChars = 0;

  const startPage = () => {
    cmds = [];
    pages.push(cmds);
    y = topY;
  };

  const ensureSpace = (heightNeeded: number) => {
    if (y - heightNeeded < bottomY) startPage();
  };

  const drawTextLine = (font: 'F1' | 'F2' | 'F3', size: number, x: number, line: string, leading: number) => {
    ensureSpace(leading);
    if (line.length > 0) {
      cmds.push(`BT /${font} ${size} Tf ${x} ${y} Td (${escapePdfString(line)}) Tj ET`);
    }
    y -= leading;
  };

  startPage();

  if (opts.title?.trim()) {
    const titleWrapped = wrapText(opts.title.trim(), 48, allowAsciiFallback);
    totalReplacedChars += titleWrapped.replacedCount;
    for (const line of titleWrapped.lines) {
      drawTextLine('F2', 18, marginX, line, 24);
    }
    if (opts.subtitle?.trim()) {
      const subWrapped = wrapText(opts.subtitle.trim(), 78, allowAsciiFallback);
      totalReplacedChars += subWrapped.replacedCount;
      for (const line of subWrapped.lines) {
        drawTextLine('F1', 11, marginX, line, 15);
      }
    }
    y -= 6;
    cmds.push(`0.75 w ${marginX} ${y} m ${marginX + contentWidth} ${y} l S`);
    y -= 18;
  }

  for (let idx = 0; idx < problems.length; idx++) {
    const problem = problems[idx]!;
    if (idx > 0) startPage();

    const heading = `Problem ${problem.id}: ${problem.title}`;
    const headingWrapped = wrapText(heading, 58, allowAsciiFallback);
    totalReplacedChars += headingWrapped.replacedCount;
    for (const line of headingWrapped.lines) {
      drawTextLine('F2', 15, marginX, line, 20);
    }
    y -= 2;
    cmds.push(`0.5 w ${marginX} ${y} m ${marginX + contentWidth} ${y} l S`);
    y -= 14;

    const bodyWrapped = wrapText(problem.body, 84, allowAsciiFallback);
    totalReplacedChars += bodyWrapped.replacedCount;
    for (const line of bodyWrapped.lines) {
      if (line === '') {
        y -= 8;
        if (y < bottomY) startPage();
      } else {
        drawTextLine('F1', 11, marginX, line, 15);
      }
    }

    if (problem.samples?.length) {
      y -= 10;
      for (let sIdx = 0; sIdx < problem.samples.length; sIdx++) {
        const sample = problem.samples[sIdx]!;
        const sections: Array<[string, string]> = [
          [`Sample Input ${sIdx + 1}`, sample.input],
          [`Sample Output ${sIdx + 1}`, sample.output],
        ];
        for (const [label, content] of sections) {
          const sampleWrapped = wrapVerbatimLines(content, 76, allowAsciiFallback);
          totalReplacedChars += sampleWrapped.replacedCount;
          const sampleLines = sampleWrapped.lines;
          const lineHeight = 13;
          const padY = 6;
          const boxHeight = sampleLines.length * lineHeight + padY * 2;
          const totalNeeded = 16 + boxHeight + 10;
          if (totalNeeded < topY - bottomY) ensureSpace(totalNeeded);
          else ensureSpace(48);

          drawTextLine('F2', 10, marginX, label, 14);
          const boxTop = y + 4;
          if (boxHeight <= boxTop - bottomY) {
            cmds.push(`0.4 w ${marginX} ${boxTop - boxHeight} ${contentWidth} ${boxHeight} re S`);
            y = boxTop - padY - 10;
            for (const line of sampleLines) {
              cmds.push(`BT /F3 9.5 Tf ${marginX + 8} ${y} Td (${escapePdfString(line)}) Tj ET`);
              y -= lineHeight;
            }
            y = boxTop - boxHeight - 10;
          } else {
            for (const line of sampleLines) {
              drawTextLine('F3', 9.5, marginX + 8, line, lineHeight);
            }
            y -= 8;
          }
        }
      }
    }
  }

  const totalPages = pages.length;
  for (let p = 0; p < totalPages; p++) {
    pages[p]!.push(`BT /F1 9 Tf ${marginX} 36 Td (Page ${p + 1} of ${totalPages}) Tj ET`);
  }

  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  for (let p = 0; p < totalPages; p++) pageObjectIds.push(6 + p * 2);

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${totalPages} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

  for (let p = 0; p < totalPages; p++) {
    const contentObjId = 7 + p * 2;
    const streamBody = pages[p]!.join('\n');
    const streamLength = Buffer.byteLength(streamBody, 'latin1');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    );
    objects.push(`<< /Length ${streamLength} >>\nstream\n${streamBody}\nendstream`);
  }

  const parts: Buffer[] = [];
  const offsets: number[] = [0];
  let bytePos = 0;
  const pushAscii = (chunk: string) => {
    const buf = Buffer.from(chunk, 'latin1');
    parts.push(buf);
    bytePos += buf.length;
  };

  pushAscii('%PDF-1.4\n');
  for (let i = 0; i < objects.length; i++) {
    offsets.push(bytePos);
    pushAscii(`${i + 1} 0 obj\n${objects[i]!}\nendobj\n`);
  }

  const xrefOffset = bytePos;
  pushAscii(`xref\n0 ${objects.length + 1}\n`);
  pushAscii('0000000000 65535 f \n');
  for (let i = 1; i < offsets.length; i++) {
    pushAscii(`${String(offsets[i]!).padStart(10, '0')} 00000 n \n`);
  }
  pushAscii(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const pdfBytes = Buffer.concat(parts);

  await mkdir(dirname(resolvedOutput), { recursive: true });
  const tempOutput = `${resolvedOutput}.${randomUUID()}.tmp.pdf`;
  try {
    await writeFile(tempOutput, pdfBytes, { mode: 0o644, flag: 'wx' });
    if (overwrite) await rename(tempOutput, resolvedOutput);
    else await link(tempOutput, resolvedOutput);
  } finally {
    await rm(tempOutput, { force: true });
  }

  const warnings: string[] = [];
  if (totalReplacedChars > 0) {
    warnings.push(`Replaced ${totalReplacedChars} non-ASCII character(s) with "?" due to Base-14 ASCII font fallback`);
  }

  return synthPdfResultSchema.parse({
    output_path: resolvedOutput,
    page_count: totalPages,
    size_bytes: pdfBytes.length,
    sha256: sha256(pdfBytes),
    problem_ids: problems.map(p => p.id),
    warnings,
  });
}
