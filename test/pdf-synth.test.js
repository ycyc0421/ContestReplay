import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  checkPdfLimits,
  detectProblemHeaders,
  extractPdfTextFallbackDetailed,
  inspectPdf,
  mergePdfs,
  mergePdfsResultSchema,
  parsePdfPageCountFallback,
  pdfInfoSchema,
  pdfLimitsCheckSchema,
  synthPdfResultSchema,
  synthesizeTextContestPdf,
} from '../dist/pdf-synth.js';

test('detectProblemHeaders handles English, mixed letter, Chinese headers, and ignores lowercase prose false positives', () => {
  assert.deepEqual(
    detectProblemHeaders([
      'Contest Replay Spring Open',
      'Problem A: Two Sum',
      'problem a is actually quite simple to solve.',
      '1. Given an array of N integers.',
      '2. Return indices i and j.',
      'Problem A: Two Sum',
      'B. Shortest Path',
      'Task C1 - Tree Queries',
    ].join('\n')),
    [
      { id: 'A', title: 'Two Sum' },
      { id: 'B', title: 'Shortest Path' },
      { id: 'C1', title: 'Tree Queries' },
    ],
  );

  assert.deepEqual(
    detectProblemHeaders([
      '2026 Regional Contest',
      '第 1 题：桥梁修复',
      '第2题 最短路径',
      '题目 3: 字符串匹配',
      '第 1 题：重复页眉',
    ].join('\n')),
    [
      { id: '1', title: '桥梁修复' },
      { id: '2', title: '最短路径' },
      { id: '3', title: '字符串匹配' },
    ],
  );

  assert.deepEqual(
    detectProblemHeaders([
      'ContestReplay Demo Final',
      '1. How many circles are in the box below?',
      '2. What is 7 + 5?',
    ].join('\n')),
    [
      { id: '1', title: 'How many circles are in the box below?' },
      { id: '2', title: 'What is 7 + 5?' },
    ],
  );
});

test('parsePdfPageCountFallback handles out-of-order PDF dictionary keys and extractPdfTextFallback blocks FlateDecode bombs', () => {
  // Out-of-order dictionary keys: /Pages before /Type /Catalog, /Count before /Type /Pages
  const reorderedPdf = Buffer.from([
    '%PDF-1.4',
    '1 0 obj',
    '<< /Pages 2 0 R /Type /Catalog >>',
    'endobj',
    '2 0 obj',
    '<< /Count 3 /Kids [3 0 R 4 0 R 5 0 R] /Type /Pages >>',
    'endobj',
    '%%EOF',
  ].join('\n'), 'latin1');
  assert.equal(parsePdfPageCountFallback(reorderedPdf), 3);

  // Multiple consecutive FlateDecode bombs + /Subtype /Image stream skipped safely;
  // extraction MUST stop immediately on the FIRST oversized stream and NOT process subsequent streams.
  const bombPayload = deflateSync(Buffer.alloc(200_000, 0x41));
  const imagePayload = deflateSync(Buffer.from('BT (SHOULD_BE_SKIPPED_IMAGE) Tj ET', 'latin1'));
  const textPayload = deflateSync(Buffer.from('BT (Problem A: Safe Text) Tj ET', 'latin1'));
  const afterBombPayload = deflateSync(Buffer.from('BT (Problem Z: After Bomb Should Stop) Tj ET', 'latin1'));

  const parts = [
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Filter /FlateDecode /Length ' + imagePayload.length + ' >>\nstream\n', 'latin1'),
    imagePayload,
    Buffer.from('\nendstream\nendobj\n2 0 obj\n<< /Filter /FlateDecode /Length ' + textPayload.length + ' >>\nstream\n', 'latin1'),
    textPayload,
    Buffer.from('\nendstream\nendobj\n3 0 obj\n<< /Filter /FlateDecode /Length ' + bombPayload.length + ' >>\nstream\n', 'latin1'),
    bombPayload,
    Buffer.from('\nendstream\nendobj\n4 0 obj\n<< /Filter /FlateDecode /Length ' + bombPayload.length + ' >>\nstream\n', 'latin1'),
    bombPayload,
    Buffer.from('\nendstream\nendobj\n5 0 obj\n<< /Filter /FlateDecode /Length ' + afterBombPayload.length + ' >>\nstream\n', 'latin1'),
    afterBombPayload,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ];
  const bombPdf = Buffer.concat(parts);

  const detailed = extractPdfTextFallbackDetailed(bombPdf, { maxStreamInflateBytes: 16_384, maxTotalInflateBytes: 32_768 });
  assert.equal(detailed.truncated, true);
  assert.ok(!detailed.text.includes('SHOULD_BE_SKIPPED_IMAGE'), 'Image stream must be skipped before inflating');
  assert.ok(detailed.text.includes('Problem A: Safe Text'));
  assert.ok(!detailed.text.includes('After Bomb Should Stop'), 'Must halt immediately on first oversized FlateDecode stream');

  // Corrupted FlateDecode stream also immediately sets truncated=true and halts further inflation while keeping prior text
  const corruptBytes = Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0x00, 0x01]);
  const corruptPdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length ' + textPayload.length + ' >>\nstream\n', 'latin1'),
    textPayload,
    Buffer.from('\nendstream\nendobj\n2 0 obj\n<< /Filter /FlateDecode /Length ' + corruptBytes.length + ' >>\nstream\n', 'latin1'),
    corruptBytes,
    Buffer.from('\nendstream\nendobj\n3 0 obj\n<< /Filter /FlateDecode /Length ' + afterBombPayload.length + ' >>\nstream\n', 'latin1'),
    afterBombPayload,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
  const corruptDetailed = extractPdfTextFallbackDetailed(corruptPdf);
  assert.equal(corruptDetailed.truncated, true);
  assert.ok(corruptDetailed.text.includes('Problem A: Safe Text'));
  assert.ok(!corruptDetailed.text.includes('After Bomb Should Stop'), 'Must halt immediately on corrupt FlateDecode stream');
});

test('synthesizeTextContestPdf generates exact xref byte offsets, enforces Unicode/overwrite safety, and inspects identically across poppler and fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-pdf-synth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outPdf = join(dir, 'contest.pdf');
  const longParagraph = Array.from({ length: 45 }, (_, i) => `Line ${i + 1}: Compute f(x) <= 10^9 for all queries (1 <= x <= n) with fast I/O.`).join('\n');

  const synth = await synthesizeTextContestPdf(
    [
      {
        id: 'A',
        title: 'Two Sum (Warmup)',
        body: 'Given an array of integers and a target value, find two distinct indices whose elements sum to target.\n\nConstraints: 2 <= N <= 10^5.',
        samples: [{ input: '4 9\n2 7 11 15', output: '1 2' }],
      },
      {
        id: 'B',
        title: 'Long Multi-Page Graph Statement',
        body: longParagraph,
        samples: [{ input: '3 2\n1 2\n2 3', output: '2' }],
      },
      {
        id: 'C',
        title: 'Final Counting Task',
        body: 'Count the number of valid permutations modulo 998244353.',
      },
    ],
    outPdf,
    { title: 'ContestReplay Synthetic Round', subtitle: 'Generated pure-JS PDF 1.4 fixture' },
  );

  assert.doesNotThrow(() => synthPdfResultSchema.parse(synth));
  assert.ok(synth.page_count >= 4, `Expected >= 4 pages, got ${synth.page_count}`);
  assert.deepEqual(synth.problem_ids, ['A', 'B', 'C']);
  assert.deepEqual(synth.warnings, []);

  // Direct xref byte-offset verification on the synthesized PDF
  const raw = await readFile(outPdf);
  const latin = raw.toString('latin1');
  const startxrefMatch = latin.match(/startxref\n(\d+)\n%%EOF/);
  assert.ok(startxrefMatch, 'Missing startxref trailer');
  const xrefPos = Number.parseInt(startxrefMatch[1], 10);
  assert.equal(raw.subarray(xrefPos, xrefPos + 5).toString('latin1'), 'xref\n');

  const xrefSection = raw.subarray(xrefPos).toString('latin1');
  const entryLines = xrefSection.split('\n').slice(2).filter(line => /^\d{10} \d{5} [fn] $/.test(line));
  assert.ok(entryLines.length >= 6);
  for (let objNum = 1; objNum < entryLines.length; objNum++) {
    const offset = Number.parseInt(entryLines[objNum].slice(0, 10), 10);
    const prefix = `${objNum} 0 obj\n`;
    assert.equal(
      raw.subarray(offset, offset + prefix.length).toString('latin1'),
      prefix,
      `xref offset mismatch for object ${objNum}`,
    );
  }

  // Default overwrite: false prevents accidental clobbering
  await assert.rejects(
    synthesizeTextContestPdf([{ id: 'A', title: 'Dup', body: 'Dup' }], outPdf),
    /already exists/,
  );

  // Non-ASCII characters (including '×') and literal tabs in sample I/O are rejected by default (no silent rewriting)
  const unicodePdf = join(dir, 'unicode.pdf');
  await assert.rejects(
    synthesizeTextContestPdf([{ id: 'A', title: '桥梁修复', body: '中文题面' }], unicodePdf),
    /allowAsciiFallback/,
  );
  await assert.rejects(
    synthesizeTextContestPdf([{ id: 'A', title: 'Grid', body: 'An N × M grid.' }], join(dir, 'mul.pdf')),
    /allowAsciiFallback/,
  );
  await assert.rejects(
    synthesizeTextContestPdf([{ id: 'A', title: 'TSV', body: 'Parse TSV.', samples: [{ input: '1\t2', output: '3' }] }], join(dir, 'tab.pdf')),
    /allowAsciiFallback/,
  );
  const fallbackUnicode = await synthesizeTextContestPdf(
    [{ id: 'A', title: '桥梁修复', body: '中文题面', samples: [{ input: '1\t2', output: '3' }] }],
    unicodePdf,
    { allowAsciiFallback: true },
  );
  assert.equal(fallbackUnicode.warnings.length, 1);
  assert.match(fallbackUnicode.warnings[0], /Replaced 9 non-ASCII/);

  // Pure-JS fallback inspection
  const fallbackInfo = await inspectPdf(outPdf, { useExternalTools: false });
  assert.doesNotThrow(() => pdfInfoSchema.parse(fallbackInfo));
  assert.equal(fallbackInfo.extractor, 'fallback');
  assert.equal(fallbackInfo.text_truncated, false);
  assert.equal(fallbackInfo.page_count, synth.page_count);
  assert.equal(fallbackInfo.sha256, synth.sha256);
  assert.deepEqual(fallbackInfo.problem_ids, ['A', 'B', 'C']);

  // Poppler inspection passes a private 0o600 snapshot to external tools (TOCTOU protection)
  let seenSnapshotPath;
  await inspectPdf(outPdf, {
    useExternalTools: true,
    execImpl: async (cmd, args) => {
      const targetArg = cmd === 'pdfinfo' ? args[1] : args[2];
      assert.notEqual(targetArg, outPdf, 'External tool must receive private snapshot, not raw path');
      seenSnapshotPath = targetArg;
      assert.equal((await stat(targetArg)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(targetArg))).mode & 0o777, 0o700);
      if (cmd === 'pdfinfo') return { stdout: `Pages:          ${synth.page_count}\n`, stderr: '' };
      return { stdout: 'Problem A: Two Sum\nProblem B: Graph\nProblem C: Counting\n', stderr: '' };
    },
  });
  // Snapshot directory is cleaned up after inspectPdf returns
  await assert.rejects(stat(seenSnapshotPath), { code: 'ENOENT' });

  // Real poppler inspection on host
  const externalInfo = await inspectPdf(outPdf, { useExternalTools: true });
  assert.equal(externalInfo.page_count, synth.page_count);
  assert.deepEqual(externalInfo.problem_ids, ['A', 'B', 'C']);

  // Existing demo PDF fallback
  const demoInfo = await inspectPdf(resolve('examples/demo/problems.pdf'), { useExternalTools: false });
  assert.equal(demoInfo.page_count, 1);
  assert.deepEqual(demoInfo.problem_ids, ['1', '2']);

  // checkPdfLimits
  const okLimits = checkPdfLimits(fallbackInfo, { maxPages: 20, maxBytes: 1_000_000 });
  assert.doesNotThrow(() => pdfLimitsCheckSchema.parse(okLimits));
  assert.deepEqual(okLimits, { ok: true, issues: [] });

  const failLimits = checkPdfLimits(fallbackInfo, { maxPages: 2, maxBytes: 100 });
  assert.equal(failLimits.ok, false);
  assert.equal(failLimits.issues.length, 2);
});

test('mergePdfs validates inputs, passes TOCTOU-safe snapshots to pdfunite/qpdf, and merges real PDFs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-pdf-merge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const pdf1 = join(dir, 'part1.pdf');
  const pdf2 = join(dir, 'part2.pdf');
  const notPdf = join(dir, 'notes.txt');
  await synthesizeTextContestPdf([{ id: 'A', title: 'Alpha', body: 'Solve Alpha.' }], pdf1);
  await synthesizeTextContestPdf([{ id: 'B', title: 'Beta', body: 'Solve Beta.' }], pdf2);
  await writeFile(notPdf, 'plain text', 'utf8');

  await assert.rejects(mergePdfs([], join(dir, 'empty.pdf')), /At least one input PDF/);
  await assert.rejects(mergePdfs([pdf1, notPdf], join(dir, 'bad.pdf')), /Invalid PDF header/);
  await assert.rejects(mergePdfs([pdf1, pdf2], join(dir, 'tiny.pdf'), { maxTotalBytes: 100 }), /exceeds/);

  // Mocked pdfunite receives private 0o600 byte snapshots (not raw input paths)
  const mockedUniteOut = join(dir, 'mock-unite.pdf');
  const uniteResult = await mergePdfs([pdf1, pdf2], mockedUniteOut, {
    execImpl: async (cmd, args) => {
      assert.equal(cmd, 'pdfunite');
      assert.equal(args.length, 3);
      assert.notEqual(args[0], pdf1);
      assert.notEqual(args[1], pdf2);
      assert.equal((await stat(args[0])).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(args[0]))).mode & 0o777, 0o700);
      assert.deepEqual(await readFile(args[0]), await readFile(pdf1));
      assert.deepEqual(await readFile(args[1]), await readFile(pdf2));
      await copyFile(args[0], args[2]);
      return { stdout: '', stderr: '' };
    },
  });
  assert.doesNotThrow(() => mergePdfsResultSchema.parse(uniteResult));
  assert.equal(uniteResult.tool, 'pdfunite');
  assert.equal(uniteResult.input_count, 2);

  // Overwrite protection by default
  await assert.rejects(mergePdfs([pdf1, pdf2], mockedUniteOut), /already exists/);

  // Mocked fallback from missing pdfunite -> qpdf
  const qpdfOut = join(dir, 'mock-qpdf.pdf');
  const qpdfResult = await mergePdfs([pdf1, pdf2], qpdfOut, {
    execImpl: async (cmd, args) => {
      if (cmd === 'pdfunite') {
        const err = new Error('spawn pdfunite ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      assert.equal(cmd, 'qpdf');
      assert.deepEqual(args.slice(0, 2), ['--empty', '--pages']);
      assert.equal(args[4], '--');
      await copyFile(args[3], args[5]);
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(qpdfResult.tool, 'qpdf');

  // Missing both tools throws deterministic install hint
  await assert.rejects(
    mergePdfs([pdf1, pdf2], join(dir, 'none.pdf'), {
      execImpl: async cmd => {
        const err = new Error(`spawn ${cmd} ENOENT`);
        err.code = 'ENOENT';
        throw err;
      },
    }),
    /Install poppler-utils \(pdfunite\) or qpdf/,
  );

  // Real host merge via pdfunite/qpdf when installed on PATH (otherwise verify overwrite: true via injected execImpl)
  const { spawnSync } = await import('node:child_process');
  const hasHostMergeTool = ['pdfunite', 'qpdf'].some(bin => spawnSync(bin, ['--version'], { stdio: 'ignore' }).error == null);
  const realMerged = join(dir, 'real-merged.pdf');
  if (hasHostMergeTool) {
    const merged = await mergePdfs([pdf1, pdf2], realMerged);
    assert.equal(merged.input_count, 2);
    assert.ok(['pdfunite', 'qpdf'].includes(merged.tool));

    const inspectedMerged = await inspectPdf(realMerged);
    assert.equal(inspectedMerged.page_count, 2);
    assert.deepEqual(inspectedMerged.problem_ids, ['A', 'B']);

    const overwritten = await mergePdfs([pdf1, pdf2], realMerged, { overwrite: true });
    assert.equal(overwritten.output_path, realMerged);
  } else {
    const mockMerge = async (_cmd, args) => {
      await copyFile(args[0], args[args.length - 1]);
      return { stdout: '', stderr: '' };
    };
    const merged = await mergePdfs([pdf1, pdf2], realMerged, { execImpl: mockMerge });
    assert.equal(merged.input_count, 2);
    const overwritten = await mergePdfs([pdf1, pdf2], realMerged, { overwrite: true, execImpl: mockMerge });
    assert.equal(overwritten.output_path, realMerged);
  }

  const singleOut = join(dir, 'single-copy.pdf');
  const copied = await mergePdfs([pdf1], singleOut);
  assert.equal(copied.tool, 'copy');
  assert.equal(copied.input_count, 1);
});
