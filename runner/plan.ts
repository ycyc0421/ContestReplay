import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { createInference } from './model.js';
import {
  agentRevision,
  file as readBoundedFile,
  loadAgent,
  loadContest,
  loadInputs,
  modelKey,
  resolveOjAccountPolicy,
  selectMatchingOjAccounts,
  type Inputs,
  type OjAccountPolicyResolution,
  type RemoteJudgeConfig,
} from './config.js';
import { imageFor, inspectImage } from './docker.js';
import type { Connections } from './connections.js';
import { speedTierSchema } from './harnesses.js';
import { OjAccountPool, OjAccounts } from './oj-accounts.js';
import { protocolDigest, protocolDigestForPreset, protocolForPreset, protocolPresetNames, resolveProtocolPreset } from './protocol.js';
import { runBench } from './run.js';

export { resolveOjAccountPolicy, selectMatchingOjAccounts, type OjAccountPolicyResolution };

const path = z.string().trim().min(1).max(4096);
const absPath = path.refine(isAbsolute, 'expected an absolute path');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const imageRef = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const MAX_PLAN_JOBS = 5000;
const axisSpecSchema = z.strictObject({ schema_version: z.literal(1),
  agents: z.array(path).min(1).max(100), contests: z.array(path).min(1).max(100),
}).refine(s => s.agents.length * s.contests.length <= 1000, 'maximum 1000 jobs');
const cellSchema = z.strictObject({
  agent: path,
  contest: path,
  repeats: z.number().int().min(1).max(20).optional(),
});
const cellsSpecSchema = z.strictObject({
  schema_version: z.literal(2),
  cells: z.array(cellSchema).min(1).max(1000),
})
  .refine(s => new Set(s.cells.map(cell => JSON.stringify([cell.agent, cell.contest]))).size === s.cells.length, 'duplicate matrix cell')
  .refine(s => s.cells.reduce((sum, cell) => sum + (cell.repeats ?? 1), 0) <= MAX_PLAN_JOBS, `maximum ${MAX_PLAN_JOBS} jobs`);
export const specSchema = z.union([axisSpecSchema, cellsSpecSchema]);
export const planJobSchema = z.strictObject({
  image: imageRef, harness: z.enum(['builtin-responses', 'codex']), model_family_id: z.string().optional(),
  agent_path: absPath, agent_id: z.string().min(1), agent_name: z.string().min(1).max(120).optional(),
  speed_tier: speedTierSchema.optional(), credential_source: z.string().min(1).max(256).optional(),
  agent_revision: digest,
  agent_sha256: digest, profile_sha256: digest, native_sha256: digest.optional(), effective_sha256: digest.optional(),
  contest_path: absPath, contest_id: z.string().min(1), data_version: z.number().int().positive(), contest_sha256: digest,
  protocol_preset: z.enum(protocolPresetNames).optional(),
  repeat_index: z.number().int().min(1).max(20).optional(),
  repeat_total: z.number().int().min(1).max(20).optional(),
}).superRefine((job, ctx) => {
  const hasIndex = job.repeat_index !== undefined;
  const hasTotal = job.repeat_total !== undefined;
  if (hasIndex !== hasTotal) {
    ctx.addIssue({
      code: 'custom',
      path: [hasIndex ? 'repeat_total' : 'repeat_index'],
      message: 'repeat_index and repeat_total must be present together',
    });
  } else if (hasIndex && hasTotal && job.repeat_index! > job.repeat_total!) {
    ctx.addIssue({
      code: 'custom',
      path: ['repeat_index'],
      message: 'repeat_index cannot exceed repeat_total',
    });
  }
});

export function validatePlanRepeatGroups(jobs: ReadonlyArray<z.infer<typeof planJobSchema>>): string | undefined {
  const groups = new Map<string, Array<z.infer<typeof planJobSchema>>>();
  for (const job of jobs) {
    const key = JSON.stringify([job.agent_path, job.contest_path]);
    const list = groups.get(key) ?? [];
    list.push(job);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const withRepeats = list.filter(j => j.repeat_index !== undefined || j.repeat_total !== undefined);
    if (withRepeats.length === 0) {
      if (list.length > 1) return 'Duplicate non-repeated cell in plan';
      continue;
    }
    if (withRepeats.length !== list.length) {
      return 'Mixed repeated and non-repeated jobs for the same matrix cell';
    }
    const expectedTotal = list[0]!.repeat_total!;
    if (list.some(j => j.repeat_total !== expectedTotal)) {
      return 'Inconsistent repeat_total within a matrix cell repeat group';
    }
    if (list.length !== expectedTotal) {
      return `Incomplete repeat group: expected ${expectedTotal} jobs, found ${list.length}`;
    }
    const seen = new Set<number>();
    for (const j of list) {
      const idx = j.repeat_index!;
      if (idx < 1 || idx > expectedTotal || seen.has(idx)) {
        return `Duplicate or out-of-range repeat_index ${idx} in repeat group`;
      }
      seen.add(idx);
    }
  }
  return undefined;
}

export const planSchema = z.strictObject({
  schema_version: z.literal(2),
  protocol_sha256: digest,
  jobs: z.array(planJobSchema).min(1).max(MAX_PLAN_JOBS),
}).superRefine((plan, ctx) => {
  const repeatError = validatePlanRepeatGroups(plan.jobs);
  if (repeatError) {
    ctx.addIssue({
      code: 'custom',
      path: ['jobs'],
      message: repeatError,
    });
  }
});
export type Plan = z.infer<typeof planSchema>;
export type PlanJob = Plan['jobs'][number];
export async function readJson(path: string, limit = 16 * 1024 * 1024) {
  return JSON.parse((await readBoundedFile(path, limit)).toString('utf8')) as unknown;
}

export type PlanInputLoaders = {
  loadAgent: typeof loadAgent;
  loadContest: typeof loadContest;
  loadInputs: typeof loadInputs;
};

export async function makePlan(
  raw: unknown,
  base: string,
  getImage = inspectImage,
  store?: Connections,
  loaders: Partial<PlanInputLoaders> = {},
): Promise<Plan> {
  const loadAgentImpl = loaders.loadAgent ?? loadAgent;
  const loadContestImpl = loaders.loadContest ?? loadContest;
  const spec = specSchema.parse(raw);
  const axes = 'cells' in spec ? { agents: [...new Set(spec.cells.map(cell => cell.agent))],
    contests: [...new Set(spec.cells.map(cell => cell.contest))] } : spec;
  const images = new Map<string, string>();
  const paths = (entries: string[]) => {
    const result = entries.map(entry => resolve(base, entry));
    if (new Set(result).size !== result.length) throw new Error('Duplicate input paths in a matrix axis');
    return result;
  };
  const agents: {
    input: AgentInput;
    entry: Omit<Pick<PlanJob, 'agent_path' | 'agent_id' | 'agent_name' | 'speed_tier' | 'credential_source' | 'agent_revision' | 'agent_sha256' | 'profile_sha256' | 'native_sha256' | 'effective_sha256' | 'image' | 'harness' | 'model_family_id'>, 'agent_revision'>;
    baseRevision: string;
  }[] = [];
  for (const file of paths(axes.agents)) {
    const input = await loadAgentImpl(file, store);
    assertHarnessProtocolCompatible(input.profile);
    const { harness, model_family_id } = input.profile;
    let image: string | undefined = images.get(harness);
    if (!image) { image = await getImage(imageFor(harness)); images.set(harness, image); }
    agents.push({
      input,
      baseRevision: agentRevision(input, image, protocolDigest),
      entry: {
        agent_path: file, agent_id: input.agent.agent_id,
        ...(input.agentName ? { agent_name: input.agentName } : {}),
        speed_tier: input.speedTier,
        credential_source: credentialSourceFor(input),
        image, harness, ...(model_family_id ? { model_family_id } : {}),
        agent_sha256: input.agentDigest, profile_sha256: input.profileDigest, effective_sha256: input.effectiveDigest,
        ...(input.nativeDigest ? { native_sha256: input.nativeDigest } : {}),
      },
    });
  }
  const contests: Pick<PlanJob, 'contest_path' | 'contest_id' | 'data_version' | 'contest_sha256' | 'protocol_preset'>[] = [];
  const compatibility = new Map<string, Inputs['contest']>();
  for (const file of paths(axes.contests)) {
    const input = await loadContestImpl(file);
    compatibility.set(file, input.contest);
    contests.push({
      contest_path: file, contest_id: input.contest.contest_id, data_version: input.contest.data_version,
      contest_sha256: input.contestDigest, protocol_preset: resolveProtocolPreset(input.contest.rules),
    });
  }
  if (new Set(agents.map(a => JSON.stringify([a.entry.agent_id, a.baseRevision, a.entry.speed_tier ?? 'standard']))).size !== agents.length ||
      new Set(contests.map(c => JSON.stringify([c.contest_id, c.data_version, c.contest_sha256]))).size !== contests.length) {
    throw new Error('Duplicate Agent or Contest revision in a matrix axis');
  }
  const buildJob = (
    agent: typeof agents[number],
    contest: typeof contests[number],
    repeat?: { index: number; total: number },
  ): PlanJob => {
    const preset = contest.protocol_preset ?? 'short';
    assertCompatible(agent.entry.harness, compatibility.get(contest.contest_path)!, agent.entry.agent_id);
    return {
      ...agent.entry,
      agent_revision: agentRevision(agent.input, agent.entry.image, protocolDigestForPreset(preset)),
      ...contest,
      ...(repeat ? { repeat_index: repeat.index, repeat_total: repeat.total } : {}),
    };
  };
  const jobs = 'cells' in spec ? spec.cells.flatMap(cell => {
    const agent = agents.find(item => item.entry.agent_path === resolve(base, cell.agent));
    const contest = contests.find(item => item.contest_path === resolve(base, cell.contest));
    if (!agent || !contest) throw new Error('Matrix cell references an unknown input');
    const total = cell.repeats ?? 1;
    if (cell.repeats === undefined) return [buildJob(agent, contest)];
    return Array.from({ length: total }, (_, idx) => buildJob(agent, contest, { index: idx + 1, total }));
  }) : agents.flatMap(agent => contests.map(contest => buildJob(agent, contest)));
  return planSchema.parse({ schema_version: 2, protocol_sha256: protocolDigest, jobs });
}
export async function planFromFile(file: string) {
  return makePlan(await readJson(file), dirname(resolve(file)));
}
type AgentInput = Awaited<ReturnType<typeof loadAgent>>;
type ContestInput = Omit<Awaited<ReturnType<typeof loadContest>>, 'pdf' | 'judge' | 'attachments'>;
export function assertCompatible(harness: Inputs['profile']['harness'], contest: Inputs['contest'], agentId: string) {
  if (harness === 'builtin-responses' && (contest.judge.kind !== 'local' || contest.materials.attachments.length > 0)) {
    throw new Error(`Incompatible cell ${agentId} × ${contest.contest_id}: built-in Responses supports PDF and local answers only`);
  }
}
function credentialSourceFor(input: Pick<AgentInput, 'connection' | 'profile'>) {
  return input.connection ? `provider:${input.connection}` : `env:${input.profile.api_key_env}`;
}
export function assertHarnessProtocolCompatible(profile: Inputs['profile']) {
  if (profile.api !== 'responses' && profile.api !== 'passthrough') {
    throw new Error(`Harness ${profile.harness} requires a responses or passthrough provider (got ${profile.api})`);
  }
}

export async function checkOjReadiness(
  judge: RemoteJudgeConfig,
  ojAccounts?: OjAccounts,
): Promise<void> {
  await resolveOjAccountPolicy(judge, ojAccounts);
}

function verifyAgent(job: PlanJob, input: AgentInput, contest: ContestInput['contest']) {
  assertHarnessProtocolCompatible(input.profile);
  const expectedPreset = resolveProtocolPreset(contest.rules);
  if (job.protocol_preset !== undefined && job.protocol_preset !== expectedPreset) {
    throw new Error('Plan protocol preset does not match contest rules; regenerate the plan');
  }
  if (!job.credential_source) {
    throw new Error('Plan predates credential source pinning; regenerate the plan');
  }
  // Display metadata such as `name` may change without invalidating an existing plan;
  // verify execution-affecting identity, credential source, speed_tier, and digests.
  if (input.agent.agent_id !== job.agent_id ||
      input.profile.harness !== job.harness || input.profile.model_family_id !== job.model_family_id ||
      (job.speed_tier ?? 'standard') !== (input.speedTier ?? 'standard') ||
      job.credential_source !== credentialSourceFor(input) ||
      input.profileDigest !== job.profile_sha256 || input.nativeDigest !== job.native_sha256 || input.effectiveDigest !== job.effective_sha256 ||
      agentRevision(input, job.image, protocolDigestForPreset(expectedPreset)) !== job.agent_revision) {
    throw new Error('Agent inputs changed; regenerate the plan');
  }
}
function verifyContest(job: PlanJob, input: ContestInput) {
  if (input.contestDigest !== job.contest_sha256 || input.contest.contest_id !== job.contest_id ||
      input.contest.data_version !== job.data_version) throw new Error('Contest inputs changed; regenerate the plan');
}
export async function verifyJob(plan: Plan, job: PlanJob, store?: Connections, loadInputsImpl = loadInputs) {
  if (plan.protocol_sha256 !== protocolDigest) throw new Error('Evaluation protocol changed; regenerate the plan');
  const inputs = await loadInputsImpl(job.contest_path, job.agent_path, store);
  verifyContest(job, inputs);
  verifyAgent(job, inputs, inputs.contest);
  assertCompatible(job.harness, inputs.contest, job.agent_id);
  return inputs;
}
export async function verifyPlan(
  plan: Plan,
  runtime = false,
  store?: Connections,
  ojAccounts?: OjAccounts,
  loaders: Partial<PlanInputLoaders> = {},
) {
  const loadAgentImpl = loaders.loadAgent ?? loadAgent;
  const loadContestImpl = loaders.loadContest ?? loadContest;
  const agents = new Map<string, AgentInput>();
  const contests = new Map<string, ContestInput>();
  for (const job of plan.jobs) {
    let agent = agents.get(job.agent_path);
    if (!agent) { agent = await loadAgentImpl(job.agent_path, store); agents.set(job.agent_path, agent); }
    let contest = contests.get(job.contest_path);
    if (!contest) {
      const { pdf: _pdf, judge: _judge, attachments: _attachments, ...meta } = await loadContestImpl(job.contest_path);
      contest = meta;
      contests.set(job.contest_path, contest);
    }
    if (runtime) await modelKey(agent, store);
    verifyContest(job, contest);
    verifyAgent(job, agent, contest.contest);
    assertCompatible(job.harness, contest.contest, job.agent_id);
    if (runtime && contest.contest.judge.kind !== 'local') {
      await checkOjReadiness(contest.contest.judge, ojAccounts);
    }
  }
}
export async function checkRuntime(plan: Plan) {
  if (plan.protocol_sha256 !== protocolDigest) throw new Error('Evaluation protocol changed; regenerate the plan');
  for (const image of new Set(plan.jobs.map(job => job.image))) await inspectImage(image);
}
export async function executeJob(
  plan: Plan,
  job: PlanJob,
  opts: {
    out: string;
    runId: string;
    signal: AbortSignal;
    store?: Connections;
    ojAccounts?: OjAccounts;
    ojPool?: OjAccountPool;
    loadInputs?: PlanInputLoaders['loadInputs'];
  },
) {
  const inputs = await verifyJob(plan, job, opts.store, opts.loadInputs ?? loadInputs);
  const key = await modelKey(inputs, opts.store);
  opts.signal.throwIfAborted();
  const preset = protocolForPreset(resolveProtocolPreset(inputs.contest.rules));
  const infer = inputs.profile.harness === 'builtin-responses'
    ? createInference(key, inputs.profile, { requestTimeoutMs: preset.requestTimeoutMs, maxOutputTokens: preset.maxOutputTokens })
    : undefined;
  return runBench(inputs, {
    ...opts,
    image: job.image,
    infer,
    key,
    ojAccounts: opts.ojAccounts,
    ojPool: opts.ojPool,
  });
}
