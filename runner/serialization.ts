import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { extname } from 'node:path';
import type { z } from 'zod';
import { manifestFormatSchema as formatSchema } from './studio-contract.js';

export { formatSchema };
export type Format = z.infer<typeof formatSchema>;
export function documentFormat(path: string): Format {
  const ext = extname(path).toLowerCase();
  const format = formatSchema.safeParse(ext === '.yml' ? 'yaml' : ext.slice(1));
  if (!format.success) throw new Error('Expected a .toml, .yaml, .yml or .json file');
  return format.data;
}
export function parseDocumentText(text: string, format: Format): unknown {
  try {
    if (format === 'json') return JSON.parse(text);
    if (format === 'toml') return parseToml(text);
    const doc = parseDocument(text, { schema: 'core', uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error('Invalid YAML');
    return doc.toJS({ maxAliasCount: 0 });
  } catch { throw new Error(`Invalid ${format.toUpperCase()} document; check content and file extension`); }
}
export function serializeDocument(value: Record<string, unknown>, format: Format) {
  const clean = JSON.parse(JSON.stringify(value));
  return format === 'toml' ? stringifyToml(clean) : format === 'yaml' ? stringifyYaml(clean) : JSON.stringify(clean, null, 2) + '\n';
}
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) => val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1)) : val);
}
