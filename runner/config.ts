import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096);
const redistribution = z.enum(['allowed', 'restricted', 'unknown']);
const artifact = z.strictObject({ path, sha256: digest.optional(), redistribution: redistribution.default('unknown') });
const source = z.strictObject({ name: z.string().trim().min(1), url: z.url({ protocol: /^https?$/ }).optional() });
const common = { contest_id: id, data_version: version, title: z.string().trim().min(1), source };
const legacyContest = z.strictObject({ schema_version: z.literal(1), ...common, statement: artifact.required(), judge: artifact.required() });
export const localBackend = z.strictObject({ kind: z.literal('local'), answers: artifact });
export const codeforcesBackend = z.strictObject({ kind: z.literal('codeforces'), contest_id: version,
  handle: z.string().regex(/^[A-Za-z0-9_.-]{1,50}$/), languages: z.record(id, version),
  problem_map: z.record(id, z.string().regex(/^[A-Za-z0-9]{1,12}$/)).optional() });
const problem = z.strictObject({ id, max_points: version });
const unique = (problems: { id: string; max_points: number }[]) => new Set(problems.map(p => p.id)).size === problems.length &&
  Number.isSafeInteger(problems.reduce((sum, p) => sum + p.max_points, 0));
export const contestSchema = z.strictObject({ schema_version: z.literal(2), ...common,
  // Only PDF entrypoints are executable today; ordered supporting files are optional.
  materials: z.strictObject({ entrypoint: artifact.extend({ kind: z.literal('pdf') }),
    attachments: z.array(artifact.extend({ name: id.refine(n => n !== 'problems.pdf') })).max(32).default([]) }),
  problems: z.array(problem).min(1).max(100).refine(unique, 'Invalid problem set').optional(),
  judge: z.discriminatedUnion('kind', [localBackend, codeforcesBackend]),
  rules: z.strictObject({ time_limit_ms: z.number().int().min(1000).max(8 * 60 * 60_000).default(900_000),
    max_submissions: z.number().int().min(1).max(1000).default(100) }).default({ time_limit_ms: 900_000, max_submissions: 100 }),
});
export const judgeSchema = z.strictObject({ schema_version: z.literal(1),
  problems: z.array(problem.extend({ accepted_answers: z.array(z.string().min(1).max(4096).refine(s => s.trim() === s)).min(1) })).min(1).max(100),
}).refine(j => unique(j.problems), 'Duplicate problem ID or unsafe total');
const legacyAgent = z.strictObject({ schema_version: z.literal(1), agent_id: id,
  harness: z.strictObject({ kind: z.literal('builtin-responses'), version: z.literal('0.1.0') }), config: path });
const apiFields = { api: z.literal('responses').default('responses'),
  base_url: z.url({ protocol: /^https?$/ }).default('https://api.openai.com/v1').superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      ctx.addIssue({ code: 'custom', message: 'Use an HTTPS origin without credentials/query, or loopback HTTP' });
    }
  }),
  api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default('OPENAI_API_KEY'),
  model_family_id: id.optional(),
};
const builtin = z.strictObject({ id, harness: z.literal('builtin-responses'), ...apiFields,
  model: z.literal('gpt-4.1-2025-04-14'), temperature: z.number().min(0).max(2).default(0) });
const codex = z.strictObject({ id, harness: z.literal('codex'), ...apiFields,
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional() });
export const agentSchema = z.discriminatedUnion('harness', [builtin, codex]);
export type AgentProfile = z.infer<typeof agentSchema>;
export const harnessVersion = (kind: AgentProfile['harness']) => kind === 'codex' ? '0.170.0' : '0.1.0';
export const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export async function file(path: string, limit: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const meta = await handle.stat();
    if (!meta.isFile() || meta.size > limit) throw new Error(`Not a regular file or exceeds ${limit} bytes: ${path}`);
    const bytes = Buffer.alloc(meta.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== meta.size) throw new Error(`File changed while reading: ${path}`);
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
function json(bytes: Buffer, path: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`Invalid JSON: ${path}`); }
}
export function validated<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(`Invalid config: ${path}: ${result.error.issues.map(i => `${i.path.join('.') || '(root)'} (${i.code})`).join(', ')}`);
}
async function readArtifact(base: string, binding: z.infer<typeof artifact>, limit: number) {
  const path = resolve(base, binding.path);
  const bytes = await file(path, limit);
  const hash = sha256(bytes);
  if (binding.sha256 && binding.sha256 !== hash) throw new Error(`SHA-256 mismatch: ${path}`);
  return { path, bytes, hash };
}
export async function resolveContest(raw: unknown, contestPath: string) {
  const old = legacyContest.safeParse(raw);
  const v = old.success ? validated(contestSchema, { schema_version: 2, contest_id: old.data.contest_id, data_version: old.data.data_version,
    title: old.data.title, source: old.data.source, materials: { entrypoint: { kind: 'pdf', ...old.data.statement } },
    judge: { kind: 'local', answers: old.data.judge } }, contestPath) : validated(contestSchema, raw, contestPath);
  const base = dirname(contestPath);
  const paper = await readArtifact(base, v.materials.entrypoint, 40_000_000);
  if (!paper.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`Missing PDF header: ${paper.path}`);
  v.materials.entrypoint.sha256 = paper.hash;
  const attachments = [];
  const names = new Set<string>();
  let attachmentBytes = 0;
  for (const attachment of v.materials.attachments) {
    if (names.has(attachment.name)) throw new Error('Duplicate attachment name');
    names.add(attachment.name);
    const material = await readArtifact(base, attachment, 16_000_000);
    attachmentBytes += material.bytes.length;
    if (attachmentBytes > 32_000_000) throw new Error('Attachments exceed 32 MB');
    attachment.sha256 = material.hash;
    attachments.push({ name: attachment.name, bytes: material.bytes });
  }
  let localJudge: z.infer<typeof judgeSchema> | undefined;
  let judgePath: string | undefined;
  if (v.judge.kind === 'local') {
    const answerFile = await readArtifact(base, v.judge.answers, 4_000_000);
    judgePath = answerFile.path;
    v.judge.answers.sha256 = answerFile.hash;
    localJudge = validated(judgeSchema, json(answerFile.bytes, answerFile.path), answerFile.path);
    if (v.problems && (v.problems.length !== localJudge.problems.length || v.problems.some(p =>
      !localJudge!.problems.some(q => q.id === p.id && q.max_points === p.max_points)))) throw new Error('Problem IDs/points do not match local judge');
    v.problems ??= localJudge.problems.map(({ id, max_points }) => ({ id, max_points }));
  } else {
    if (!v.problems || !Object.keys(v.judge.languages).length) throw new Error('Codeforces requires explicit problems and language IDs');
    const mapping = v.judge.problem_map ?? {};
    if (Object.keys(mapping).some(key => !v.problems!.some(p => p.id === key))) throw new Error('Unknown problem in Codeforces mapping');
    const targets = v.problems.map(p => Object.hasOwn(mapping, p.id) ? mapping[p.id]! : p.id);
    if (new Set(targets).size !== targets.length || targets.some(t => !/^[A-Za-z0-9]{1,12}$/.test(t))) throw new Error('Invalid or duplicate Codeforces target');
  }
  const contest = { ...v, problems: v.problems!, statement: v.materials.entrypoint };
  const cf = v.judge.kind === 'codeforces' ? v.judge : undefined;
  const judgeDefinition = v.judge.kind === 'local' ? { kind: v.judge.kind, sha256: v.judge.answers.sha256 } : {
    kind: v.judge.kind, contest_id: v.judge.contest_id,
    problem_map: v.problems!.map(p => [p.id, Object.hasOwn(cf?.problem_map ?? {}, p.id) ? cf!.problem_map![p.id] : p.id]),
    languages: Object.entries(v.judge.languages).sort(([a], [b]) => a.localeCompare(b)),
  };
  const contestRevision = sha256(JSON.stringify({ materials: [paper.hash, ...v.materials.attachments.map(a => [a.name, a.sha256])],
    problems: v.problems, rules: v.rules, judge: judgeDefinition }));
  return { contest, contestPath, contestRevision, contestDigest: sha256(JSON.stringify(v)), pdf: paper.bytes, attachments,
    judge: localJudge ?? { schema_version: 1 as const, problems: [] }, pdfPath: paper.path, judgePath };
}
export async function loadContest(contestFile: string) {
  const contestPath = resolve(contestFile);
  return resolveContest(json(await file(contestPath, 1_000_000), contestPath), contestPath);
}
export function agentToml(raw: unknown) { return stringify(validated(agentSchema, raw, 'Agent')); }
export async function loadAgent(agentFile: string) {
  const agentPath = resolve(agentFile);
  const bytes = await file(agentPath, 1_000_000);
  let native = bytes;
  let raw: unknown;
  const isLegacy = agentPath.endsWith('.json');
  if (isLegacy) {
    const agent = validated(legacyAgent, json(bytes, agentPath), agentPath);
    native = await file(resolve(dirname(agentPath), agent.config), 64_000);
    try { raw = { ...parse(native.toString('utf8')), id: agent.agent_id, harness: agent.harness.kind }; }
    catch { throw new Error(`Invalid native TOML for ${agentPath}`); }
  } else {
    try { raw = parse(bytes.toString('utf8')); }
    catch { throw new Error(`Invalid TOML: ${agentPath}`); }
  }
  const profile = validated(agentSchema, raw, agentPath);
  const agent = { agent_id: profile.id, harness: { kind: profile.harness, version: harnessVersion(profile.harness) } };
  return { agent, agentPath, agentDigest: sha256(bytes), profileDigest: sha256(native), profile };
}
export async function loadInputs(contestFile: string, agentFile: string) {
  return { ...await loadContest(contestFile), ...await loadAgent(agentFile) };
}
export function agentRevision(inputs: Awaited<ReturnType<typeof loadAgent>>, image: string) {
  const { model_family_id: _family, id: _id, api_key_env: _key, ...profile } = inputs.profile;
  return sha256(JSON.stringify({ harness: inputs.agent.harness, profile, adapter: '0.2.0', image }));
}
export function modelKey(profile: AgentProfile) {
  // Bind custom endpoints to explicitly authorized credentials; never silently
  // forward a default provider key to a URL from a portable config.
  const base = profile.base_url.replace(/\/+$/, '');
  const name = profile.api_key_env;
  if (base !== 'https://api.openai.com/v1' && process.env[`${name}_BASE_URL`] !== base) {
    throw new Error(`Approve the endpoint in ${name}_BASE_URL before using custom base_url`);
  }
  const key = process.env[name]?.trim();
  if (!key) throw new Error(`Set ${name} in the runner environment.`);
  return key;
}
export type Inputs = Awaited<ReturnType<typeof loadInputs>>;
