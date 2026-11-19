import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson } from './plan.js';
import { getBatch } from './queue.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const submission = z.strictObject({ id: z.string(), problem_id: z.string(), elapsed_ms: count, verdict: z.string() });
export const resultSchema = z.strictObject({ run_id: z.uuid(), contest_id: z.string(), contest_title: z.string().optional(),
  data_version: count, contest_revision: digest, protocol_id: z.string(), protocol_version: count, protocol_sha256: digest,
  agent_id: z.string(), agent_revision: digest, harness: z.object({ kind: z.string(), version: z.string() }).strict(),
  model: z.strictObject({ requested: z.string(), observed: z.array(z.string()), family: z.string().optional(), reasoning_effort: z.string().optional() }),
  score: count, max_score: count, submissions: z.array(submission) });
export const resultsSchema = z.strictObject({ schema_version: z.literal(1), results: z.array(resultSchema) });
const metadata = resultSchema.omit({ score: true, max_score: true, submissions: true, model: true }).strip().extend({
  contest_revision: digest.optional(),
  input_sha256: z.object({ contest: digest }), model: z.object({ model: z.string(), model_family_id: z.string().optional(), reasoning_effort: z.string().optional() }),
});
export async function exportRun(root: string, id: string) {
  const directory = join(root, z.uuid().parse(id));
  const { input_sha256, model, ...meta } = metadata.parse(await readJson(join(directory, 'run.json')));
  if (meta.run_id !== id) throw new Error('Run ID mismatch');
  const lines = createInterface({ input: createReadStream(join(directory, 'events.jsonl')), crlfDelay: Infinity });
  const rows = new Map<string, Partial<z.infer<typeof submission>>>();
  const observed = new Set<string>();
  let terminal: Record<string, unknown> | undefined;
  let seq = 0;
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (terminal || event.schema_version !== 1 || event.seq !== ++seq) throw new Error('Invalid run event sequence');
      if (event.type === 'submission_received') rows.set(event.submission_id, { id: event.submission_id, problem_id: event.problem_id, elapsed_ms: event.elapsed_ms });
      if (event.type === 'submission_judged' && rows.has(event.submission_id)) rows.get(event.submission_id)!.verdict = event.verdict;
      if (['model_response', 'model_identity'].includes(event.type) && typeof event.model === 'string') observed.add(event.model);
      if (event.type === 'run_ended') terminal = event;
    }
  } finally { lines.close(); }
  if (terminal?.status !== 'completed') throw new Error(`Run ${id} did not complete`);
  return resultSchema.parse({ ...meta, contest_revision: meta.contest_revision ?? input_sha256.contest, score: terminal.score, max_score: terminal.max_score,
    model: { requested: model.model, observed: [...observed], family: model.model_family_id, reasoning_effort: model.reasoning_effort }, submissions: [...rows.values()] });
}
export async function exportBatch(root: string, batchId: string) {
  const batch = await getBatch(root, batchId);
  const results = [];
  for (const job of batch.jobs) if (job.status === 'completed') results.push(await exportRun(root, job.run_id!));
  return { schema_version: 1, results };
}
export function mergeResults(bundles: unknown[]) {
  const results = new Map<string, z.infer<typeof resultSchema>>();
  for (const bundle of bundles) for (const result of resultsSchema.parse(bundle).results) {
    const current = results.get(result.run_id);
    if (current && JSON.stringify(current) !== JSON.stringify(result)) throw new Error(`Conflicting run ${result.run_id}`);
    results.set(result.run_id, result);
  }
  return { schema_version: 1, results: [...results.values()] };
}
export function rankResults(bundle: unknown, family?: string) {
  const group = new Map<string, z.infer<typeof resultSchema>[]>();
  for (const result of resultsSchema.parse(bundle).results) {
    if (family && result.model.family !== family) continue;
    const key = JSON.stringify([result.contest_id, result.data_version, result.contest_revision, result.protocol_id, result.protocol_version, result.protocol_sha256]);
    const rows = group.get(key) ?? [];
    rows.push(result); group.set(key, rows);
  }
  return [...group.values()].map(rows => {
    // Default policy: best run per exact Agent revision, by score then time of last solve.
    const time = (r: z.infer<typeof resultSchema>) => {
      const first = new Map<string, number>();
      for (const s of r.submissions) if (['accepted', 'OK', 'AC'].includes(s.verdict)) first.set(s.problem_id, Math.min(s.elapsed_ms, first.get(s.problem_id) ?? Infinity));
      return Math.max(0, ...first.values());
    };
    const sorted = rows.map(result => ({ result, finish_ms: time(result) })).sort((a,b) => b.result.score - a.result.score || a.finish_ms - b.finish_ms || a.result.run_id.localeCompare(b.result.run_id));
    const seen = new Set<string>(); let rank = 0, index = 0, prev: typeof sorted[number] | undefined;
    return sorted.flatMap(row => {
      const key = JSON.stringify([row.result.agent_id, row.result.agent_revision]);
      if (seen.has(key)) return [];
      seen.add(key); index++;
      if (!prev || prev.result.score !== row.result.score || prev.finish_ms !== row.finish_ms) rank = index;
      prev = row;
      return [{ rank, ...row }];
    });
  });
}
