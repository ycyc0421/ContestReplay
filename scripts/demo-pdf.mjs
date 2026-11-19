// Rebuild the original, CC0 sample PDF and its manifest without external PDF tools.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const folder = new URL('../examples/demo/', import.meta.url);
const drawing = [
  'BT /F1 20 Tf 70 740 Td (ContestReplay Demo Final) Tj ET',
  'BT /F1 14 Tf 70 700 Td (1. How many circles are in the box below?) Tj ET',
  '70 555 290 115 re S',
  ...[115, 210, 305].map(x =>
    `${x + 20} 610 m ${x + 20} 621 ${x + 11} 630 ${x} 630 c ${x - 11} 630 ${x - 20} 621 ${x - 20} 610 c ${x - 20} 599 ${x - 11} 590 ${x} 590 c ${x + 11} 590 ${x + 20} 599 ${x + 20} 610 c S`),
  'BT /F1 14 Tf 70 510 Td (2. What is 7 + 5?) Tj ET',
].join('\n') + '\n';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}endstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = objects.map((object, i) => {
  const offset = Buffer.byteLength(pdf);
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  return offset;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const artifact = (path, bytes) => ({ path, sha256: sha256(bytes), redistribution: 'allowed' });
const judge = await readFile(new URL('judge.json', folder));
const manifest = { schema_version: 1, contest_id: 'cr-demo-final', data_version: 1, title: 'ContestReplay Demo Final',
  source: { name: 'ContestReplay original sample (CC0-1.0)' },
  statement: artifact('problems.pdf', pdf), judge: artifact('judge.json', judge) };
await writeFile(new URL('problems.pdf', folder), pdf);
await writeFile(new URL('contest.json', folder), JSON.stringify(manifest, null, 2) + '\n');
