import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { agentKind } from './agent-manifest.js';
import { loadAgent, loadContest } from './config.js';
import type { Connections } from './connections.js';
import { speedTierSchema } from './harnesses.js';
import { assertCompatible } from './plan.js';
import { resolveProtocolPreset, resolveScoringMode } from './protocol.js';
import { documentFormat, parseDocumentText } from './serialization.js';

const skipped = new Set(['node_modules', 'dist', 'coverage', 'runs']);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const issue = (error: unknown) => error instanceof Error ? error.message : 'Invalid configuration';
async function files(base: string) {
  const result: string[] = [];
  const dirs = [base];
  let scanned = 0;
  while (dirs.length) {
    for (const entry of await readdir(dirs.pop()!, { withFileTypes: true })) {
      if (++scanned > 10_000) throw new Error('Workspace is too large to list configurations');
      if (entry.name.startsWith('.') || skipped.has(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) dirs.push(path);
      else if (entry.isFile() && /\.(toml|yaml|yml|json)$/i.test(entry.name)) result.push(path);
    }
  }
  return result.sort();
}
async function read(path: string) {
  const { readFile } = await import('node:fs/promises');
  return record(parseDocumentText(await readFile(path, 'utf8'), documentFormat(path)));
}
export async function agentCatalog(base: string, store: Connections) {
  const providers = new Set((await store.list()).map(item => item.id));
  const entries = [];
  for (const path of await files(base)) {
    const raw: Record<string, unknown> = await read(path).catch(() => ({}));
    const agentLike = raw.kind === agentKind || 'agent_id' in raw || ('harness' in raw && 'model' in raw);
    if (!agentLike) continue;
    const loaded = await loadAgent(path, store).then(value => ({ value }), error => ({ error }));
    const harness = record(raw.harness);
    const provider = text(raw.provider) ?? text(raw.connection) ?? ('value' in loaded ? loaded.value.connection : undefined);
    const id = text(raw.id) ?? text(raw.agent_id) ?? ('value' in loaded ? loaded.value.agent.agent_id : path.split('/').at(-1)!);
    const name = ('value' in loaded ? loaded.value.agentName : undefined) ?? (text(raw.name)?.trim() || undefined);
    const rawTier = speedTierSchema.safeParse(raw.speed_tier);
    const speed_tier = 'value' in loaded ? loaded.value.speedTier : (rawTier.success ? rawTier.data : undefined);
    entries.push({
      id, ...(name ? { name } : {}), path: relative(base, path), model: text(raw.model) ?? ('value' in loaded ? loaded.value.profile.model : ''),
      vendor: text(raw.vendor) ?? ('value' in loaded ? loaded.value.vendor : undefined),
      ...(speed_tier ? { speed_tier } : {}),
      harness: text(harness.kind) ?? text(raw.harness) ?? ('value' in loaded ? loaded.value.profile.harness : 'unknown'), provider,
      provider_available: provider ? providers.has(provider) : true,
      valid: 'value' in loaded, issues: 'error' in loaded ? [issue(loaded.error)] : [],
    });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
}
export async function contestCatalog(base: string) {
  const entries = [];
  for (const path of await files(base)) {
    const raw: Record<string, unknown> = await read(path).catch(() => ({}));
    if (!('contest_id' in raw)) continue;
    const loaded = await loadContest(path).then(value => ({ value }), error => ({ error }));
    const judge = record(raw.judge);
    const rules = record(raw.rules);
    entries.push({ id: text(raw.contest_id) ?? path.split('/').at(-1)!, path: relative(base, path),
      title: text(raw.title) ?? text(raw.contest_id) ?? path.split('/').at(-1)!,
      data_version: typeof raw.data_version === 'number' ? raw.data_version : 1,
      judge_kind: text(judge.kind) ?? 'unknown',
      problem_count: 'value' in loaded ? loaded.value.contest.problems.length : Array.isArray(raw.problems) ? raw.problems.length : 0,
      time_limit_ms: 'value' in loaded ? loaded.value.contest.rules.time_limit_ms : typeof rules.time_limit_ms === 'number' ? rules.time_limit_ms : 900_000,
      ...('value' in loaded ? {
        protocol_preset: resolveProtocolPreset(loaded.value.contest.rules),
        scoring_mode: resolveScoringMode(loaded.value.contest.rules),
      } : {}),
      valid: 'value' in loaded, issues: 'error' in loaded ? [issue(loaded.error)] : [] });
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
}
export async function evaluateMatrix(raw: unknown, base: string, store: Connections) {
  const input = z.strictObject({ agents: z.array(z.string().min(1)).min(1).max(100), contests: z.array(z.string().min(1)).min(1).max(100) })
    .refine(value => value.agents.length * value.contests.length <= 1000).parse(raw);
  const agents = new Map<string, Awaited<ReturnType<typeof loadAgent>>>();
  const contests = new Map<string, Awaited<ReturnType<typeof loadContest>>>();
  for (const path of input.agents) agents.set(path, await loadAgent(resolve(base, path), store));
  for (const path of input.contests) contests.set(path, await loadContest(resolve(base, path)));
  const cells = [];
  for (const agent of input.agents) for (const contest of input.contests) {
    const a = agents.get(agent)!;
    try { assertCompatible(a.profile.harness, contests.get(contest)!.contest, a.agent.agent_id); cells.push({ agent, contest, compatible: true }); }
    catch (error) { cells.push({ agent, contest, compatible: false, reason: issue(error) }); }
  }
  return { cells };
}
