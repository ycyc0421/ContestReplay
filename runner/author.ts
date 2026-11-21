import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { agentToml, resolveContest } from './config.js';
import { importCodeforces } from './codeforces.js';

export async function saveAgent(path: string, raw: unknown) {
  if (!path.endsWith('.toml')) throw new Error('Agent output must end in .toml');
  await writeFile(path, agentToml(raw), { mode: 0o600, flag: 'wx' });
  return resolve(path);
}
export async function saveContest(path: string, raw: unknown) {
  const { contest } = await resolveContest(raw, resolve(path));
  const { statement: _legacy, ...manifest } = contest;
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return resolve(path);
}
export async function codeforcesContest(path: string, raw: unknown, signal?: AbortSignal) {
  const input = z.strictObject({ contest: z.number().int().positive(), id: z.string(), pdf: z.string(), handle: z.string(),
    languages: z.record(z.string(), z.number().int().positive()) }).parse(raw);
  const result = await importCodeforces(input.contest, signal);
  return saveContest(path, { schema_version: 2, contest_id: input.id, data_version: 1, title: result.contest.name,
    source: { name: 'Codeforces', url: `https://codeforces.com/contest/${input.contest}` },
    materials: { entrypoint: { kind: 'pdf', path: input.pdf } }, problems: result.problems.map(p => ({ id: p.index, max_points: 1 })),
    judge: { kind: 'codeforces', contest_id: input.contest, handle: input.handle, languages: input.languages } });
}
