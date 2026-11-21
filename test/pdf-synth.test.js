import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  checkPdfLimits,
  detectProblemHeaders,
  inspectPdf,
  mergePdfs,
  mergePdfsResultSchema,
  pdfInfoSchema,
  pdfLimitsCheckSchema,
  synthPdfResultSchema,
  synthesizeTextContestPdf,
} from '../dist/pdf-synth.js';

test('detectProblemHeaders recognizes English, bare, and Chinese contest problem headers with deduplication', () => {
  assert.deepEqual(
    detectProblemHeaders([
      'Contest Replay Spring Open',
      'Problem A: Two Sum',
      '1. Given an array of N integers.',
      '2. Return indices i and j.',
      'Problem A: Two Sum',
      'Problem B. Shortest Path',
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
      'Round 999',
      'A. Watermelon',
      '1. Input contains integer w.',
      'B. Domino Piling',
      'C. Next Round',
    ].join('\n')),
    [
      { id: 'A', title: 'Watermelon' },
      { id: 'B', title: 'Domino Piling' },
      { id: 'C', title: 'Next Round' },
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

test('synthesizeTextContestPdf generates valid multi-page PDF inspected identically by poppler and pure-JS fallback', async t => {
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
        samples: [
          { input: '4 9\n2 7 11 15', output: '1 2' },
        ],
      },
      {
        id: 'B',
        title: 'Long Multi-Page Graph Statement',
        body: longParagraph,
        samples: [
          { input: '3 2\n1 2\n2 3', output: '2' },
        ],
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
  assert.ok(synth.page_count >= 4, `Expected >= 4 pages due to overflow on Problem B, got ${synth.page_count}`);
  assert.deepEqual(synth.problem_ids, ['A', 'B', 'C']);

  const raw = await readFile(outPdf);
  assert.equal(raw.subarray(0, 5).toString('latin1'), '%PDF-');

  // Pure-JS fallback inspection (no external tools)
  const fallbackInfo = await inspectPdf(outPdf, { useExternalTools: false });
  assert.doesNotThrow(() => pdfInfoSchema.parse(fallbackInfo));
  assert.equal(fallbackInfo.extractor, 'fallback');
  assert.equal(fallbackInfo.page_count, synth.page_count);
  assert.equal(fallbackInfo.sha256, synth.sha256);
  assert.equal(fallbackInfo.size_bytes, synth.size_bytes);
  assert.deepEqual(fallbackInfo.problem_ids, ['A', 'B', 'C']);
  assert.equal(fallbackInfo.problems[0].title, 'Two Sum (Warmup)');

  // Real poppler inspection (when pdfinfo/pdftotext installed, or fallback gracefully)
  const externalInfo = await inspectPdf(outPdf, { useExternalTools: true });
  assert.doesNotThrow(() => pdfInfoSchema.parse(externalInfo));
  assert.equal(externalInfo.page_count, synth.page_count);
  assert.equal(externalInfo.sha256, synth.sha256);
  assert.deepEqual(externalInfo.problem_ids, ['A', 'B', 'C']);

  // Also verify existing repository demo PDF with pure-JS fallback
  const demoInfo = await inspectPdf(resolve('examples/demo/problems.pdf'), { useExternalTools: false });
  assert.equal(demoInfo.page_count, 1);
  assert.deepEqual(demoInfo.problem_ids, ['1', '2']);

  // Reject non-PDF file
  const fakePdf = join(dir, 'fake.pdf');
  await writeFile(fakePdf, 'not a pdf document', 'utf8');
  await assert.rejects(inspectPdf(fakePdf), /Invalid PDF header/);

  // checkPdfLimits pass and fail cases
  const okLimits = checkPdfLimits(fallbackInfo, { maxPages: 20, maxBytes: 1_000_000 });
  assert.doesNotThrow(() => pdfLimitsCheckSchema.parse(okLimits));
  assert.deepEqual(okLimits, { ok: true, issues: [] });

  const failLimits = checkPdfLimits(fallbackInfo, { maxPages: 2, maxBytes: 100 });
  assert.equal(failLimits.ok, false);
  assert.equal(failLimits.issues.length, 2);
  assert.match(failLimits.issues[0], /exceeding maximum of 2/);
  assert.match(failLimits.issues[1], /exceeds maximum of 100/);
});

test('mergePdfs validates inputs, prevents accidental overwrite, supports pdfunite/qpdf fallback, and merges real PDFs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-pdf-merge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const pdf1 = join(dir, 'part1.pdf');
  const pdf2 = join(dir, 'part2.pdf');
  const notPdf = join(dir, 'notes.txt');
  await synthesizeTextContestPdf([{ id: 'A', title: 'Alpha', body: 'Solve Alpha.' }], pdf1);
  await synthesizeTextContestPdf([{ id: 'B', title: 'Beta', body: 'Solve Beta.' }], pdf2);
  await writeFile(notPdf, 'plain text', 'utf8');

  // Input validation failures
  await assert.rejects(mergePdfs([], join(dir, 'empty.pdf')), /At least one input PDF/);
  await assert.rejects(mergePdfs([pdf1, notPdf], join(dir, 'bad.pdf')), /Invalid PDF header/);
  await assert.rejects(mergePdfs([pdf1, pdf2], join(dir, 'tiny.pdf'), { maxTotalBytes: 100 }), /exceeds/);

  // Mocked pdfunite invocation
  const calls = [];
  const mockedUniteOut = join(dir, 'mock-unite.pdf');
  const uniteResult = await mergePdfs([pdf1, pdf2], mockedUniteOut, {
    execImpl: async (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      assert.equal(cmd, 'pdfunite');
      assert.equal(args.length, 3);
      assert.equal(args[0], pdf1);
      assert.equal(args[1], pdf2);
      await copyFile(pdf1, args[2]);
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
      assert.deepEqual(args.slice(0, 5), ['--empty', '--pages', pdf1, pdf2, '--']);
      await copyFile(pdf2, args[5]);
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(qpdfResult.tool, 'qpdf');

  // Mocked missing both tools -> clear deterministic install hint
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

  // Real host merge via pdfunite (installed on this host) and overwrite: true
  const realMerged = join(dir, 'real-merged.pdf');
  const merged = await mergePdfs([pdf1, pdf2], realMerged);
  assert.equal(merged.input_count, 2);
  assert.ok(['pdfunite', 'qpdf'].includes(merged.tool));

  const inspectedMerged = await inspectPdf(realMerged);
  assert.equal(inspectedMerged.page_count, 2);
  assert.deepEqual(inspectedMerged.problem_ids, ['A', 'B']);

  // Overwrite: true replaces existing file cleanly
  const overwritten = await mergePdfs([pdf1, pdf2], realMerged, { overwrite: true });
  assert.equal(overwritten.output_path, realMerged);

  // Single-input merge copies validated PDF cleanly without invoking external tools
  const singleOut = join(dir, 'single-copy.pdf');
  const copied = await mergePdfs([pdf1], singleOut);
  assert.equal(copied.tool, 'copy');
  assert.equal(copied.input_count, 1);
  const inspectedSingle = await inspectPdf(singleOut, { useExternalTools: false });
  assert.deepEqual(inspectedSingle.problem_ids, ['A']);
});
