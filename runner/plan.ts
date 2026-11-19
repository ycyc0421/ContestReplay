import { createInference } from './model.js';
import { agentRevision, file as readBoundedFile, loadAgent, loadContest, loadInputs, modelKey, type Inputs } from './config.js';
import { imageFor, inspectImage } from './docker.js';
import { checkCodeforces } from './codeforces.js';
import { protocolDigest } from './protocol.js';
import { runBench } from './run.js';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const path = z.string().trim().min(1).max(4096);
const absPath = path.refine(isAbsolute, 'expected an absolute path');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const imageRef = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const specSchema = z.strictObject({ schema_version: z.literal(1),
  agents: z.array(path).min(1).max(100), contests: z.array(path).min(1).max(100),
}).refine(s => s.agents.length * s.contests.length <= 1000, 'maximum 1000 jobs');
export const planSchema = z.strictObject({ schema_version: z.literal(2), protocol_sha256: digest,
  jobs: z.array(z.strictObject({
    image: imageRef, harness: z.enum(['builtin-responses', 'codex']), model_family_id: z.string().optional(),
    agent_path: absPath, agent_id: z.string().min(1), agent_revision: digest,
    agent_sha256: digest, profile_sha256: digest,
    contest_path: absPath, contest_id: z.string().min(1), data_version: z.number().int().positive(), contest_sha256: digest,
  })).min(1).max(1000),
});
export type Plan = z.infer<typeof planSchema>;
export type PlanJob = Plan['jobs'][number];
export async function readJson(path: string) {
  return JSON.parse((await readBoundedFile(path, 16 * 1024 * 1024)).toString('utf8')) as unknown;
}

export async function makePlan(raw: unknown, base: string, getImage = inspectImage): Promise<Plan> {
  const spec = specSchema.parse(raw);
  const images = new Map<string, string>();
  const paths = (entries: string[]) => {
    const result = entries.map(entry => resolve(base, entry));
    if (new Set(result).size !== result.length) throw new Error('Duplicate input paths in a matrix axis');
    return result;
  };
  const agents = [] as (Pick<PlanJob, 'agent_path' | 'agent_id' | 'agent_revision' | 'agent_sha256' | 'profile_sha256' | 'image' | 'harness' | 'model_family_id'>)[];
  for (const file of paths(spec.agents)) {
    const input = await loadAgent(file);
    const { harness, model_family_id } = input.profile;
    let image: string | undefined = images.get(harness);
    if (!image) { image = await getImage(imageFor(harness)); images.set(harness, image); }
    agents.push({ agent_path: file, agent_id: input.agent.agent_id, agent_revision: agentRevision(input, image), image, harness, ...(model_family_id ? { model_family_id } : {}),
      agent_sha256: input.agentDigest, profile_sha256: input.profileDigest });
  }
  const contests: Pick<PlanJob, 'contest_path' | 'contest_id' | 'data_version' | 'contest_sha256'>[] = [];
  for (const file of paths(spec.contests)) {
    const input = await loadContest(file);
    for (const agent of agents) assertCompatible(agent.harness, input.contest, agent.agent_id);
    contests.push({ contest_path: file, contest_id: input.contest.contest_id, data_version: input.contest.data_version,
      contest_sha256: input.contestDigest });
  }
  if (new Set(agents.map(a => JSON.stringify([a.agent_id, a.agent_revision]))).size !== agents.length ||
      new Set(contests.map(c => JSON.stringify([c.contest_id, c.data_version, c.contest_sha256]))).size !== contests.length) {
    throw new Error('Duplicate Agent or Contest revision in a matrix axis');
  }
  return planSchema.parse({ schema_version: 2, protocol_sha256: protocolDigest,
    jobs: agents.flatMap(agent => contests.map(contest => ({ ...agent, ...contest }))) });
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
function verifyAgent(job: PlanJob, input: AgentInput) {
  if (input.agent.agent_id !== job.agent_id || input.agentDigest !== job.agent_sha256 ||
      input.profile.harness !== job.harness || input.profile.model_family_id !== job.model_family_id ||
      input.profileDigest !== job.profile_sha256 || agentRevision(input, job.image) !== job.agent_revision) {
    throw new Error('Agent inputs changed; regenerate the plan');
  }
}
function verifyContest(job: PlanJob, input: ContestInput) {
  if (input.contestDigest !== job.contest_sha256 || input.contest.contest_id !== job.contest_id ||
      input.contest.data_version !== job.data_version) throw new Error('Contest inputs changed; regenerate the plan');
}
export async function verifyJob(plan: Plan, job: PlanJob) {
  if (plan.protocol_sha256 !== protocolDigest) throw new Error('Evaluation protocol changed; regenerate the plan');
  const inputs = await loadInputs(job.contest_path, job.agent_path);
  verifyAgent(job, inputs);
  verifyContest(job, inputs);
  assertCompatible(job.harness, inputs.contest, job.agent_id);
  return inputs;
}
export async function verifyPlan(plan: Plan, runtime = false) {
  const agents = new Map<string, AgentInput>();
  const contests = new Map<string, ContestInput>();
  for (const job of plan.jobs) {
    let agent = agents.get(job.agent_path);
    if (!agent) { agent = await loadAgent(job.agent_path); agents.set(job.agent_path, agent); }
    let contest = contests.get(job.contest_path);
    if (!contest) {
      const { pdf: _pdf, judge: _judge, attachments: _attachments, ...meta } = await loadContest(job.contest_path);
      contest = meta;
      contests.set(job.contest_path, contest);
    }
    if (runtime) modelKey(agent.profile);
    verifyAgent(job, agent);
    verifyContest(job, contest);
    assertCompatible(job.harness, contest.contest, job.agent_id);
    if (runtime && contest.contest.judge.kind === 'codeforces') await checkCodeforces();
  }
}
export async function checkRuntime(plan: Plan) {
  if (plan.protocol_sha256 !== protocolDigest) throw new Error('Evaluation protocol changed; regenerate the plan');
  for (const image of new Set(plan.jobs.map(job => job.image))) await inspectImage(image);
}
export async function executeJob(plan: Plan, job: PlanJob, opts: { out: string; runId: string; signal: AbortSignal }) {
  const inputs = await verifyJob(plan, job);
  const key = modelKey(inputs.profile);
  opts.signal.throwIfAborted();
  const infer = inputs.profile.harness === 'builtin-responses' ? createInference(key, inputs.profile) : undefined;
  return runBench(inputs, { ...opts, image: job.image, infer, key });
}
