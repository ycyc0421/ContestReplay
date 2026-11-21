import { createInference } from './model.js';
import { agentRevision, file as readBoundedFile, loadAgent, loadContest, loadInputs, modelKey, type Inputs } from './config.js';
import { imageFor, inspectImage } from './docker.js';
import { checkCodeforces } from './codeforces.js';
import type { Connections } from './connections.js';
import { speedTierSchema } from './harnesses.js';
import { protocolDigest, protocolDigestForPreset, protocolForPreset, protocolPresetNames, resolveProtocolPreset } from './protocol.js';
import { runBench } from './run.js';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const path = z.string().trim().min(1).max(4096);
const absPath = path.refine(isAbsolute, 'expected an absolute path');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const imageRef = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const axisSpecSchema = z.strictObject({ schema_version: z.literal(1),
  agents: z.array(path).min(1).max(100), contests: z.array(path).min(1).max(100),
}).refine(s => s.agents.length * s.contests.length <= 1000, 'maximum 1000 jobs');
const cellsSpecSchema = z.strictObject({ schema_version: z.literal(2),
  cells: z.array(z.strictObject({ agent: path, contest: path })).min(1).max(1000),
}).refine(s => new Set(s.cells.map(cell => JSON.stringify(cell))).size === s.cells.length, 'duplicate matrix cell');
export const specSchema = z.union([axisSpecSchema, cellsSpecSchema]);
export const planSchema = z.strictObject({ schema_version: z.literal(2), protocol_sha256: digest,
  jobs: z.array(z.strictObject({
    image: imageRef, harness: z.enum(['builtin-responses', 'codex']), model_family_id: z.string().optional(),
    agent_path: absPath, agent_id: z.string().min(1), agent_name: z.string().min(1).max(120).optional(),
    speed_tier: speedTierSchema.optional(), credential_source: z.string().min(1).max(256).optional(),
    agent_revision: digest,
    agent_sha256: digest, profile_sha256: digest, native_sha256: digest.optional(), effective_sha256: digest.optional(),
    contest_path: absPath, contest_id: z.string().min(1), data_version: z.number().int().positive(), contest_sha256: digest,
    protocol_preset: z.enum(protocolPresetNames).optional(),
  })).min(1).max(1000),
});
export type Plan = z.infer<typeof planSchema>;
export type PlanJob = Plan['jobs'][number];
export async function readJson(path: string) {
  return JSON.parse((await readBoundedFile(path, 16 * 1024 * 1024)).toString('utf8')) as unknown;
}

export async function makePlan(raw: unknown, base: string, getImage = inspectImage, store?: Connections): Promise<Plan> {
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
    const input = await loadAgent(file, store);
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
    const input = await loadContest(file);
    compatibility.set(file, input.contest);
    contests.push({
      contest_path: file, contest_id: input.contest.contest_id, data_version: input.contest.data_version,
      contest_sha256: input.contestDigest, protocol_preset: resolveProtocolPreset(input.contest.rules),
    });
  }
  if (new Set(agents.map(a => JSON.stringify([a.entry.agent_id, a.baseRevision]))).size !== agents.length ||
      new Set(contests.map(c => JSON.stringify([c.contest_id, c.data_version, c.contest_sha256]))).size !== contests.length) {
    throw new Error('Duplicate Agent or Contest revision in a matrix axis');
  }
  const buildJob = (agent: typeof agents[number], contest: typeof contests[number]): PlanJob => {
    const preset = contest.protocol_preset ?? 'short';
    assertCompatible(agent.entry.harness, compatibility.get(contest.contest_path)!, agent.entry.agent_id);
    return {
      ...agent.entry,
      agent_revision: agentRevision(agent.input, agent.entry.image, protocolDigestForPreset(preset)),
      ...contest,
    };
  };
  const jobs = 'cells' in spec ? spec.cells.map(cell => {
    const agent = agents.find(item => item.entry.agent_path === resolve(base, cell.agent));
    const contest = contests.find(item => item.contest_path === resolve(base, cell.contest));
    if (!agent || !contest) throw new Error('Matrix cell references an unknown input');
    return buildJob(agent, contest);
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
function assertHarnessProtocolCompatible(profile: Inputs['profile']) {
  if (profile.api !== 'responses' && profile.api !== 'passthrough') {
    throw new Error(`Harness ${profile.harness} requires a responses or passthrough provider (got ${profile.api})`);
  }
}
function verifyAgent(job: PlanJob, input: AgentInput, contest: ContestInput['contest']) {
  assertHarnessProtocolCompatible(input.profile);
  const expectedPreset = resolveProtocolPreset(contest.rules);
  if (job.protocol_preset !== undefined && job.protocol_preset !== expectedPreset) {
    throw new Error('Plan protocol preset does not match contest rules; regenerate the plan');
  }
  // Display metadata such as `name` may change without invalidating an existing plan;
  // verify execution-affecting identity, credential source, speed_tier, and digests.
  if (input.agent.agent_id !== job.agent_id ||
      input.profile.harness !== job.harness || input.profile.model_family_id !== job.model_family_id ||
      (job.speed_tier ?? 'standard') !== (input.speedTier ?? 'standard') ||
      (job.credential_source !== undefined && job.credential_source !== credentialSourceFor(input)) ||
      input.profileDigest !== job.profile_sha256 || input.nativeDigest !== job.native_sha256 || input.effectiveDigest !== job.effective_sha256 ||
      agentRevision(input, job.image, protocolDigestForPreset(expectedPreset)) !== job.agent_revision) {
    throw new Error('Agent inputs changed; regenerate the plan');
  }
}
function verifyContest(job: PlanJob, input: ContestInput) {
  if (input.contestDigest !== job.contest_sha256 || input.contest.contest_id !== job.contest_id ||
      input.contest.data_version !== job.data_version) throw new Error('Contest inputs changed; regenerate the plan');
}
export async function verifyJob(plan: Plan, job: PlanJob, store?: Connections) {
  if (plan.protocol_sha256 !== protocolDigest) throw new Error('Evaluation protocol changed; regenerate the plan');
  const inputs = await loadInputs(job.contest_path, job.agent_path, store);
  verifyContest(job, inputs);
  verifyAgent(job, inputs, inputs.contest);
  assertCompatible(job.harness, inputs.contest, job.agent_id);
  return inputs;
}
export async function verifyPlan(plan: Plan, runtime = false, store?: Connections) {
  const agents = new Map<string, AgentInput>();
  const contests = new Map<string, ContestInput>();
  for (const job of plan.jobs) {
    let agent = agents.get(job.agent_path);
    if (!agent) { agent = await loadAgent(job.agent_path, store); agents.set(job.agent_path, agent); }
    let contest = contests.get(job.contest_path);
    if (!contest) {
      const { pdf: _pdf, judge: _judge, attachments: _attachments, ...meta } = await loadContest(job.contest_path);
      contest = meta;
      contests.set(job.contest_path, contest);
    }
    if (runtime) await modelKey(agent, store);
    verifyContest(job, contest);
    verifyAgent(job, agent, contest.contest);
    assertCompatible(job.harness, contest.contest, job.agent_id);
    if (runtime && contest.contest.judge.kind === 'codeforces') await checkCodeforces();
  }
}
export async function checkRuntime(plan: Plan) {
  if (plan.protocol_sha256 !== protocolDigest) throw new Error('Evaluation protocol changed; regenerate the plan');
  for (const image of new Set(plan.jobs.map(job => job.image))) await inspectImage(image);
}
export async function executeJob(plan: Plan, job: PlanJob, opts: { out: string; runId: string; signal: AbortSignal; store?: Connections }) {
  const inputs = await verifyJob(plan, job, opts.store);
  const key = await modelKey(inputs, opts.store);
  opts.signal.throwIfAborted();
  const preset = protocolForPreset(resolveProtocolPreset(inputs.contest.rules));
  const infer = inputs.profile.harness === 'builtin-responses'
    ? createInference(key, inputs.profile, { requestTimeoutMs: preset.requestTimeoutMs, maxOutputTokens: preset.maxOutputTokens })
    : undefined;
  return runBench(inputs, { ...opts, image: job.image, infer, key });
}
