import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { agentToml, resolveAgentManifest, resolveContest } from './config.js';
import { Connections } from './connections.js';
import { manifestProvider } from './agent-manifest.js';
import { documentFormat, serializeDocument } from './serialization.js';
import { importCodeforces } from './codeforces.js';

export async function saveAgent(path: string, raw: unknown) {
  if (!path.endsWith('.toml')) throw new Error('Agent output must end in .toml');
  await writeFile(path, agentToml(raw), { mode: 0o600, flag: 'wx' });
  return resolve(path);
}
export async function saveAgentManifest(path: string, raw: unknown, store = new Connections()) {
  const target = resolve(path);
  const format = documentFormat(target);
  const { manifest } = await resolveAgentManifest(raw, target, store);
  return persistAgentManifest(target, manifestProvider(manifest), serializeDocument(manifest, format), store);
}

export async function persistAgentManifest(target: string, connection: string, serialized: string, store: Connections, overwrite = false) {
  if (!overwrite) {
    await store.register(connection, target, () => writeFile(target, serialized, { mode: 0o600, flag: 'wx' }));
    return target;
  }
  await store.register(connection, target, async () => {
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, serialized, { mode: 0o600, flag: 'wx' });
      await rename(tmp, target);
    } finally {
      await rm(tmp, { force: true });
    }
  });
  return target;
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
  const pointsKnown = result.problems.every(p => typeof p.points === 'number' && Number.isFinite(p.points) && p.points >= 1);
  return saveContest(path, { schema_version: 2, contest_id: input.id, data_version: 1, title: result.contest.name,
    source: { name: 'Codeforces', url: `https://codeforces.com/contest/${input.contest}` },
    materials: { entrypoint: { kind: 'pdf', path: input.pdf } },
    problems: result.problems.map(p => ({ id: p.index, max_points: typeof p.points === 'number' && Number.isFinite(p.points) && p.points >= 1 ? Math.round(p.points) : 1 })),
    judge: { kind: 'codeforces', contest_id: input.contest, handle: input.handle, languages: input.languages, points_known: pointsKnown } });
}
