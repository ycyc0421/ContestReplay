import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { agentKind, agentNameSchema, manifestProvider, resolveManifest } from './agent-manifest.js';
import { connectionProtocolSchema, Connections, endpoint } from './connections.js';
import { builtinModel, codexModel, effectiveFor, efforts, harness, responsesServiceTier, speedTierSchema, type HarnessEnv, type NativeOverride } from './harnesses.js';
import { defaultOriginFor, effectiveOriginFor, ojAccountId, ojHandle, ojPoolName, OjAccounts, type OjAccount, type OjPlatform } from './oj-accounts.js';
import { protocolPresetNames, protocolPresets, resolveProtocolPreset, scoringModes } from './protocol.js';
import { canonical, documentFormat, parseDocumentText, serializeDocument } from './serialization.js';
import { z } from 'zod';

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096);
const redistribution = z.enum(['allowed', 'restricted', 'unknown']);
const artifact = z.strictObject({ path, sha256: digest.optional(), redistribution: redistribution.default('unknown') });
const source = z.strictObject({ name: z.string().trim().min(1), url: z.url({ protocol: /^https?$/ }).optional() });
const common = { contest_id: id, data_version: version, title: z.string().trim().min(1), source };
export const legacyContestSchema = z.strictObject({ schema_version: z.literal(1), ...common, statement: artifact.required(), judge: artifact.required() });
const legacyContest = legacyContestSchema;
export const localBackend = z.strictObject({ kind: z.literal('local'), answers: artifact });
const remoteLanguageId = z.string().trim().min(1).max(64);
const codeforcesLanguageId = z.union([
  version,
  z.string().trim().regex(/^[0-9]+$/).refine(value => {
    const num = Number(value);
    return Number.isSafeInteger(num) && num >= 1;
  }, 'Codeforces language ID must be a positive safe integer'),
]).transform(value => String(Number(value)));
const remoteProblemTarget = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
const settlementMsSchema = z.number().int().min(1000).max(1_800_000);
const remoteContestRef = z.union([version, z.string().trim().min(1).max(128)]);
export const codeforcesBackend = z.strictObject({
  kind: z.literal('codeforces'),
  contest_id: version,
  gym: z.boolean().optional(),
  handle: z.string().regex(/^[A-Za-z0-9_.-]{1,50}$/).optional(),
  account_id: ojAccountId.optional(),
  pool: ojPoolName.optional(),
  base_url: endpoint.optional(),
  languages: z.record(id, codeforcesLanguageId),
  problem_map: z.record(id, z.string().regex(/^[A-Za-z0-9]{1,12}$/)).optional(),
  points_known: z.boolean().optional(),
  settlement_ms: settlementMsSchema.optional(),
});
export const qojBackend = z.strictObject({
  kind: z.literal('qoj'),
  contest_id: remoteContestRef.optional(),
  account_id: ojAccountId.optional(),
  pool: ojPoolName.optional(),
  handle: ojHandle.optional(),
  base_url: endpoint.optional(),
  languages: z.record(id, remoteLanguageId),
  problem_map: z.record(id, remoteProblemTarget).optional(),
  settlement_ms: settlementMsSchema.optional(),
});
export const vjudgeBackend = z.strictObject({
  kind: z.literal('vjudge'),
  contest_id: remoteContestRef.optional(),
  account_id: ojAccountId.optional(),
  pool: ojPoolName.optional(),
  handle: ojHandle.optional(),
  base_url: endpoint.optional(),
  languages: z.record(id, remoteLanguageId),
  problem_map: z.record(id, remoteProblemTarget).optional(),
  settlement_ms: settlementMsSchema.optional(),
});
export const hydroBackend = z.strictObject({
  kind: z.literal('hydro'),
  base_url: endpoint,
  domain: z.string().trim().min(1).max(128).optional(),
  contest_id: z.string().trim().min(1).max(128).optional(),
  live_contest: z.boolean().optional(),
  account_id: ojAccountId.optional(),
  pool: ojPoolName.optional(),
  handle: ojHandle.optional(),
  languages: z.record(id, remoteLanguageId),
  problem_map: z.record(id, remoteProblemTarget).optional(),
  settlement_ms: settlementMsSchema.optional(),
});
const problem = z.strictObject({ id, max_points: version });
const unique = (problems: { id: string; max_points: number }[]) => new Set(problems.map(p => p.id)).size === problems.length &&
  Number.isSafeInteger(problems.reduce((sum, p) => sum + p.max_points, 0));
export const contestSchema = z.strictObject({ schema_version: z.literal(2), ...common,
  // Only PDF entrypoints are executable today; ordered supporting files are optional.
  materials: z.strictObject({ entrypoint: artifact.extend({ kind: z.literal('pdf') }),
    attachments: z.array(artifact.extend({ name: id.refine(n => n !== 'problems.pdf') })).max(32).default([]) }),
  problems: z.array(problem).min(1).max(100).refine(unique, 'Invalid problem set').optional(),
  judge: z.discriminatedUnion('kind', [localBackend, codeforcesBackend, qojBackend, vjudgeBackend, hydroBackend]),
  rules: z.strictObject({
    time_limit_ms: z.number().int().min(1000).max(8 * 60 * 60_000).default(900_000),
    max_submissions: z.number().int().min(1).max(1000).default(100),
    protocol_preset: z.enum(protocolPresetNames).optional(),
    scoring_mode: z.enum(scoringModes).optional(),
  }).default({ time_limit_ms: 900_000, max_submissions: 100 }),
}).superRefine((value, ctx) => {
  if (value.judge.kind !== 'local' && value.judge.account_id && value.judge.pool) {
    ctx.addIssue({
      code: 'custom',
      path: ['judge', 'pool'],
      message: 'Specify either account_id or pool, not both',
    });
  }
  if (value.judge.kind === 'codeforces' && !value.judge.handle && !value.judge.account_id && !value.judge.pool) {
    ctx.addIssue({
      code: 'custom',
      path: ['judge', 'handle'],
      message: 'Codeforces judge requires at least one of handle, account_id, or pool',
    });
  }
});
export const judgeSchema = z.strictObject({ schema_version: z.literal(1),
  problems: z.array(problem.extend({ accepted_answers: z.array(z.string().min(1).max(4096).refine(s => s.trim() === s)).min(1) })).min(1).max(100),
}).refine(j => unique(j.problems), 'Duplicate problem ID or unsafe total');
export const legacyAgentSchema = z.strictObject({ schema_version: z.literal(1), agent_id: id,
  harness: z.strictObject({ kind: z.literal('builtin-responses'), version: z.literal('0.1.0') }), config: path });
const legacyAgent = legacyAgentSchema;
const apiFields = {
  name: agentNameSchema.optional(),
  speed_tier: speedTierSchema.optional(),
  api: connectionProtocolSchema.default('responses'),
  base_url: endpoint.default('https://api.openai.com/v1'),
  api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default('OPENAI_API_KEY'),
  model_family_id: id.optional(),
};
const builtin = z.strictObject({ id, harness: z.literal('builtin-responses'), ...apiFields,
  api: z.enum(['passthrough', 'responses']).default('responses'),
  model: builtinModel, temperature: z.number().min(0).max(2).default(0) });
const codex = z.strictObject({ id, harness: z.literal('codex'), ...apiFields,
  model: codexModel, reasoning_effort: z.enum(efforts).optional(),
  service_tier: z.preprocess(v => v === 'default' ? undefined : v, z.enum(['standard', 'fast', 'priority']).optional()) });
export const agentSchema = z.discriminatedUnion('harness', [builtin, codex]);
export type AgentProfile = z.infer<typeof agentSchema>;
export const harnessVersion = (kind: AgentProfile['harness']) => harness(kind).version;
export const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export type RemoteJudgeConfig = Exclude<z.infer<typeof contestSchema>['judge'], { kind: 'local' }>;

export function canonicalRemoteTarget(kind: OjPlatform, rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (kind === 'qoj') return trimmed.replace(/^qoj:/i, '').trim();
  return trimmed;
}

function canonicalRemoteContestId(judge: RemoteJudgeConfig): string | number | undefined {
  if (judge.contest_id === undefined) return undefined;
  if (judge.kind === 'qoj') return String(judge.contest_id).replace(/^qoj:/i, '').trim();
  if (judge.kind === 'vjudge') return String(judge.contest_id).replace(/^vjudge:/i, '').trim();
  if (judge.kind === 'hydro') return judge.contest_id.trim();
  return judge.contest_id;
}

function normalizedEffectiveBaseUrl(judge: RemoteJudgeConfig): string {
  const raw = judge.base_url ?? defaultOriginFor(judge.kind);
  if (!raw) throw new Error(`${judge.kind} requires base_url`);
  const parsed = new URL(raw);
  const pathPart = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathPart}`;
}

const OJ_ENV_PREFIX: Record<OjPlatform, string> = {
  codeforces: 'CODEFORCES',
  qoj: 'QOJ',
  vjudge: 'VJUDGE',
  hydro: 'HYDRO',
};

function parseOriginSafe(raw: string | undefined, label: string): string | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, query parameters, or fragments`);
  }
  return parsed.origin;
}

export interface OjAccountPolicyResolution {
  mode: 'account_pool' | 'env_submitter' | 'env_cookie';
  targetOrigin: string;
  matchedAccounts: OjAccount[];
  envExecutable?: string;
}

export function selectMatchingOjAccounts(
  judge: RemoteJudgeConfig,
  candidates: readonly OjAccount[],
  targetOrigin: string,
): OjAccount[] {
  return candidates.filter(acc => {
    if (acc.platform !== judge.kind || !acc.ready) return false;
    if (effectiveOriginFor(acc) !== targetOrigin) return false;
    if (judge.account_id && acc.id !== judge.account_id) return false;
    if (!judge.account_id && judge.pool && acc.pool !== judge.pool) return false;
    if (judge.handle && acc.handle.toLowerCase() !== judge.handle.toLowerCase()) return false;
    return true;
  });
}

export async function resolveOjAccountPolicy(
  judge: RemoteJudgeConfig,
  ojAccounts?: OjAccounts,
): Promise<OjAccountPolicyResolution> {
  const accounts = ojAccounts ?? new OjAccounts();
  const targetOrigin = judge.base_url
    ? parseOriginSafe(judge.base_url, `${judge.kind} base_url`)
    : defaultOriginFor(judge.kind);
  if (!targetOrigin) {
    throw new Error(`${judge.kind} requires base_url`);
  }

  if (judge.account_id && judge.pool) {
    throw new Error('Contest judge cannot specify both account_id and pool');
  }

  if (judge.account_id) {
    const acc = await accounts.get(judge.account_id);
    if (acc.platform !== judge.kind) {
      throw new Error(`OJ account ${judge.account_id} belongs to ${acc.platform}, expected ${judge.kind}`);
    }
    const bound = effectiveOriginFor(acc);
    if (bound !== targetOrigin) {
      throw new Error(`OJ account ${judge.account_id} origin (${bound ?? 'none'}) does not match ${targetOrigin}`);
    }
    if (judge.handle && acc.handle.toLowerCase() !== judge.handle.toLowerCase()) {
      throw new Error(`OJ account ${judge.account_id} handle (${acc.handle}) does not match ${judge.handle}`);
    }
    if (!acc.ready) {
      throw new Error(`OJ account ${judge.account_id} is not ready (credential or submitter unavailable)`);
    }
    return { mode: 'account_pool', targetOrigin, matchedAccounts: [acc] };
  }

  if (judge.pool) {
    const poolAccounts = await accounts.listPool(judge.kind, judge.pool);
    const matched = selectMatchingOjAccounts(judge, poolAccounts, targetOrigin);
    if (!matched.length) {
      throw new Error(`No ready ${judge.kind} OJ accounts in pool "${judge.pool}"`);
    }
    return { mode: 'account_pool', targetOrigin, matchedAccounts: matched };
  }

  // Neither account_id nor pool: first look for ready stored accounts matching (platform, targetOrigin, optional handle).
  const storedCandidates = await accounts.listPool(judge.kind).catch(() => []);
  const matchedStored = selectMatchingOjAccounts(judge, storedCandidates, targetOrigin);
  if (matchedStored.length > 0) {
    return { mode: 'account_pool', targetOrigin, matchedAccounts: matchedStored };
  }

  // Legacy env fallback is ONLY allowed when judge.handle is explicitly set.
  if (judge.handle) {
    const prefix = OJ_ENV_PREFIX[judge.kind];
    const envExec = process.env[`CR_${prefix}_SUBMITTER`]?.trim();
    if (envExec) {
      if (!isAbsolute(envExec)) throw new Error(`CR_${prefix}_SUBMITTER must be an absolute executable path`);
      const info = await stat(envExec);
      if (!info.isFile()) throw new Error(`CR_${prefix}_SUBMITTER is not a regular file`);
      await access(envExec, constants.X_OK);
      return { mode: 'env_submitter', targetOrigin, matchedAccounts: [], envExecutable: envExec };
    }
    const envCookie = process.env[`CR_${prefix}_COOKIE`]?.trim();
    if (envCookie) {
      const envBaseRaw = process.env[`CR_${prefix}_BASE_URL`]?.trim();
      const approvedOrigin = envBaseRaw
        ? parseOriginSafe(envBaseRaw, `CR_${prefix}_BASE_URL`)
        : defaultOriginFor(judge.kind);
      if (approvedOrigin !== targetOrigin) {
        throw new Error(`CR_${prefix}_BASE_URL origin (${approvedOrigin ?? 'none'}) does not match ${targetOrigin}`);
      }
      return { mode: 'env_cookie', targetOrigin, matchedAccounts: [] };
    }
    if (judge.kind === 'codeforces') {
      throw new Error('Set CR_CODEFORCES_SUBMITTER or CR_CODEFORCES_COOKIE');
    }
  }

  throw new Error(`No ready ${judge.kind} OJ account, cookie, or submitter configured`);
}

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
export type ContestArtifactReader = (
  baseDir: string,
  binding: z.infer<typeof artifact>,
  limit: number,
  role: 'entrypoint' | 'attachment' | 'answers',
) => Promise<{ path: string; bytes: Buffer; hash: string }>;

export type AgentExternalFileReader = (
  refPath: string,
  expectedSha256: string | undefined,
  limit: number,
) => Promise<Buffer>;

async function readArtifact(base: string, binding: z.infer<typeof artifact>, limit: number) {
  const path = resolve(base, binding.path);
  const bytes = await file(path, limit);
  const hash = sha256(bytes);
  if (binding.sha256 && binding.sha256 !== hash) throw new Error(`SHA-256 mismatch: ${path}`);
  return { path, bytes, hash };
}
export async function resolveContest(
  raw: unknown,
  contestPath: string,
  artifactReader: ContestArtifactReader = (baseDir, binding, limit) => readArtifact(baseDir, binding, limit),
) {
  const old = legacyContest.safeParse(raw);
  const v = old.success ? validated(contestSchema, { schema_version: 2, contest_id: old.data.contest_id, data_version: old.data.data_version,
    title: old.data.title, source: old.data.source, materials: { entrypoint: { kind: 'pdf', ...old.data.statement } },
    judge: { kind: 'local', answers: old.data.judge } }, contestPath) : validated(contestSchema, raw, contestPath);
  const base = dirname(contestPath);
  const preset = protocolPresets[resolveProtocolPreset(v.rules)];
  const paper = await artifactReader(base, v.materials.entrypoint, Math.max(40_000_000, preset.pdfMaxBytes), 'entrypoint');
  if (!paper.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`Missing PDF header: ${paper.path}`);
  v.materials.entrypoint.sha256 = paper.hash;
  const attachments = [];
  const names = new Set<string>();
  let attachmentBytes = 0;
  for (const attachment of v.materials.attachments) {
    if (names.has(attachment.name)) throw new Error('Duplicate attachment name');
    names.add(attachment.name);
    const material = await artifactReader(base, attachment, 16_000_000, 'attachment');
    attachmentBytes += material.bytes.length;
    if (attachmentBytes > 32_000_000) throw new Error('Attachments exceed 32 MB');
    attachment.sha256 = material.hash;
    attachments.push({ name: attachment.name, bytes: material.bytes });
  }
  let localJudge: z.infer<typeof judgeSchema> | undefined;
  let judgePath: string | undefined;
  if (v.judge.kind === 'local') {
    const answerFile = await artifactReader(base, v.judge.answers, 4_000_000, 'answers');
    judgePath = answerFile.path;
    v.judge.answers.sha256 = answerFile.hash;
    localJudge = validated(judgeSchema, json(answerFile.bytes, answerFile.path), answerFile.path);
    if (v.problems && (v.problems.length !== localJudge.problems.length || v.problems.some(p =>
      !localJudge!.problems.some(q => q.id === p.id && q.max_points === p.max_points)))) throw new Error('Problem IDs/points do not match local judge');
    v.problems ??= localJudge.problems.map(({ id, max_points }) => ({ id, max_points }));
  } else {
    const remoteJudge = v.judge;
    if (!v.problems || !Object.keys(remoteJudge.languages).length) {
      throw new Error(`${remoteJudge.kind} requires explicit problems and language IDs`);
    }
    const mapping = remoteJudge.problem_map ?? {};
    if (Object.keys(mapping).some(key => !v.problems!.some(p => p.id === key))) {
      throw new Error(`Unknown problem in ${remoteJudge.kind} mapping`);
    }
    const targets = v.problems.map(p =>
      canonicalRemoteTarget(remoteJudge.kind, Object.hasOwn(mapping, p.id) ? mapping[p.id]! : p.id),
    );
    const targetPattern = remoteJudge.kind === 'codeforces' ? /^[A-Za-z0-9]{1,12}$/ : /^[A-Za-z0-9._:/-]{1,128}$/;
    if (new Set(targets).size !== targets.length || targets.some(t => !targetPattern.test(t))) {
      throw new Error(`Invalid or duplicate ${remoteJudge.kind} target`);
    }
  }
  const contest = { ...v, problems: v.problems!, statement: v.materials.entrypoint };
  const judgeDefinition = v.judge.kind === 'local'
    ? { kind: v.judge.kind, sha256: v.judge.answers.sha256 }
    : (() => {
        const remoteJudge = v.judge;
        const mapping = remoteJudge.problem_map ?? {};
        const canonicalContestId = canonicalRemoteContestId(remoteJudge);
        const normalizedDomain = remoteJudge.kind === 'hydro' ? remoteJudge.domain?.trim() : undefined;
        return {
          kind: remoteJudge.kind,
          base_url: normalizedEffectiveBaseUrl(remoteJudge),
          ...(canonicalContestId !== undefined ? { contest_id: canonicalContestId } : {}),
          ...(remoteJudge.kind === 'codeforces' && remoteJudge.gym ? { gym: true } : {}),
          ...(remoteJudge.kind === 'hydro' && normalizedDomain && normalizedDomain !== 'system' ? { domain: normalizedDomain } : {}),
          ...(remoteJudge.kind === 'hydro' && remoteJudge.live_contest ? { live_contest: true } : {}),
          problem_map: v.problems!.map(p => [
            p.id,
            canonicalRemoteTarget(remoteJudge.kind, Object.hasOwn(mapping, p.id) ? mapping[p.id]! : p.id),
          ]),
          languages: Object.entries(remoteJudge.languages)
            .map(([lang, remoteId]) => [lang, String(remoteId)] as const)
            .sort(([a], [b]) => a.localeCompare(b)),
        };
      })();
  const contestRevision = sha256(JSON.stringify({ materials: [paper.hash, ...v.materials.attachments.map(a => [a.name, a.sha256])],
    problems: v.problems, rules: v.rules, judge: judgeDefinition }));
  return { contest, contestPath, contestRevision, contestDigest: sha256(JSON.stringify(v)), pdf: paper.bytes, attachments,
    judge: localJudge ?? { schema_version: 1 as const, problems: [] }, pdfPath: paper.path, judgePath };
}
export async function loadContest(contestFile: string) {
  const contestPath = resolve(contestFile);
  return resolveContest(json(await file(contestPath, 1_000_000), contestPath), contestPath);
}
export function agentToml(raw: unknown) { return serializeDocument(validated(agentSchema, raw, 'Agent'), 'toml'); }
export async function resolveAgentManifest(
  raw: unknown,
  agentPath: string,
  store: Connections,
  readExternal?: AgentExternalFileReader,
) {
  return resolveManifest(raw, store, async (ref, digest) => {
    if (readExternal) {
      return (await readExternal(ref, digest, 64_000)).toString('utf8');
    }
    const data = await readArtifact(dirname(agentPath), { path: ref, sha256: digest, redistribution: 'unknown' }, 64_000);
    return data.bytes.toString('utf8');
  });
}
export function agentDigests(profile: AgentProfile, native?: NativeOverride, nativeText?: string, env?: HarnessEnv) {
  const { model_family_id: _family, api_key_env: _key, id: _id, name: _name, speed_tier: speedTier, ...normalized } = profile;
  const effective = effectiveFor(profile, native);
  const relayServiceTier = profile.harness === 'codex' ? responsesServiceTier(profile.service_tier) : undefined;
  return {
    profileDigest: sha256(canonical({
      ...normalized,
      ...(speedTier && speedTier !== 'standard' ? { speed_tier: speedTier } : {}),
      native: native?.model_verbosity ? native : undefined,
      env: env ?? {},
    })),
    nativeDigest: nativeText === undefined ? undefined : sha256(nativeText),
    effectiveDigest: sha256(canonical({
      config: effective.config,
      ...(relayServiceTier ? { relay_service_tier: relayServiceTier } : {}),
      env: env ?? {},
    })),
  };
}
export async function resolveLoadedAgent(
  parsed: unknown,
  bytes: Buffer,
  agentPath: string,
  store = new Connections(),
  readExternal?: AgentExternalFileReader,
) {
  let raw = parsed;
  let native: NativeOverride | undefined;
  let nativeText: string | undefined;
  let env: HarnessEnv | undefined;
  let vendor: string | undefined;
  let connection: string | undefined;
  let profile: AgentProfile;
  if (raw && typeof raw === 'object' && 'kind' in raw) {
    if (raw.kind !== agentKind) throw new Error('Unsupported Agent manifest kind');
    const resolved = await resolveAgentManifest(raw, agentPath, store, readExternal);
    ({ profile, native, nativeText, env } = resolved);
    vendor = resolved.manifest.vendor;
    connection = manifestProvider(resolved.manifest);
  } else {
    if (raw && typeof raw === 'object' && ('schema_version' in raw || 'agent_id' in raw)) {
      const legacy = validated(legacyAgent, raw, agentPath);
      const contents = readExternal
        ? await readExternal(legacy.config, undefined, 64_000)
        : await file(resolve(dirname(agentPath), legacy.config), 64_000);
      const parsedLegacy = Object(parseDocumentText(contents.toString('utf8'), 'toml')) as Record<string, unknown>;
      const { name: _displayName, ...nativeCore } = parsedLegacy;
      nativeText = canonical(nativeCore);
      raw = { ...parsedLegacy, id: legacy.agent_id, harness: legacy.harness.kind };
    }
    profile = validated(agentSchema, raw, agentPath);
  }
  const agent = { agent_id: profile.id, harness: { kind: profile.harness, version: harnessVersion(profile.harness) } };
  return {
    agent, agentPath, agentDigest: sha256(bytes), ...agentDigests(profile, native, nativeText, env),
    profile, native, env, vendor, connection,
    agentName: profile.name, speedTier: profile.speed_tier ?? 'standard',
  };
}
export async function loadAgent(agentFile: string, store = new Connections()) {
  const agentPath = resolve(agentFile);
  const bytes = await file(agentPath, 1_000_000);
  const raw = parseDocumentText(bytes.toString('utf8'), documentFormat(agentPath));
  return resolveLoadedAgent(raw, bytes, agentPath, store);
}
export async function loadInputs(contestFile: string, agentFile: string, store?: Connections) {
  return { ...await loadContest(contestFile), ...await loadAgent(agentFile, store) };
}
export function revisionFor(profile: AgentProfile, effectiveDigest: string, image: string, protocol: string) {
  return sha256(canonical({
    harness: profile.harness,
    version: harnessVersion(profile.harness),
    model: profile.model,
    endpoint: profile.base_url,
    api: profile.api,
    ...(profile.speed_tier && profile.speed_tier !== 'standard' ? { speed_tier: profile.speed_tier } : {}),
    effective_sha256: effectiveDigest,
    adapter: '0.3.0',
    image,
    protocol,
  }));
}
export function agentRevision(inputs: Pick<Awaited<ReturnType<typeof loadAgent>>, 'profile' | 'effectiveDigest'>, image: string, protocol: string) {
  return revisionFor(inputs.profile, inputs.effectiveDigest, image, protocol);
}
export async function modelKey({profile, connection}: { profile: AgentProfile; connection?: string }, store = new Connections()) {
  if (connection) return store.key(connection, profile);
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
