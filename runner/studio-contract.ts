import { z } from 'zod';

export const manifestFormatSchema = z.enum(['toml', 'yaml', 'json']);
export const harnessFieldSchema = z.strictObject({
  id: z.string(), label: z.string(), kind: z.enum(['select', 'text', 'number', 'boolean']),
  required: z.boolean(), default: z.string().optional(), description: z.string().optional(), placeholder: z.string().optional(),
  options: z.array(z.strictObject({ value: z.string(), label: z.string() })).optional(),
});
export const capabilitiesSchema = z.strictObject({
  schema_version: z.literal(1),
  features: z.strictObject({ agent_vendor: z.boolean(), agent_manifests: z.boolean(), connections: z.boolean(),
    native_overrides: z.boolean(), contest_authoring: z.boolean(), contest_upload: z.boolean(), judge_authoring: z.boolean() }),
  manifest_formats: z.array(manifestFormatSchema).min(1),
  harnesses: z.array(z.strictObject({ id: z.string(), label: z.string(), version: z.string(), native_format: manifestFormatSchema,
    supports_overrides: z.boolean(), fields: z.array(harnessFieldSchema),
    environment: z.array(z.strictObject({ name: z.string(), options: z.array(z.strictObject({ value: z.string(), label: z.string() })) })).optional() })).min(1),
  judge_backends: z.array(z.strictObject({ kind: z.string(), label: z.string(), supports_authoring: z.boolean() })).min(1),
});
export const connectionResponseSchema = z.looseObject({
  id: z.string(), label: z.string(), protocol: z.string(), base_url: z.string(), credential_ref: z.string(), approved_origin: z.string(),
  supports_fast: z.boolean().optional(), supports_ultrafast: z.boolean().optional(),
});
export const providerResponseSchema = connectionResponseSchema.extend({
  backend: z.enum(['secret-service', 'file']), credential_available: z.boolean(),
});
export const providersResponseSchema = z.strictObject({ providers: z.array(providerResponseSchema) });
export const materialResponseSchema = z.strictObject({ path: z.string(), name: z.string(), size: z.number(), sha256: z.string(), kind: z.enum(['entrypoint', 'attachment']) });
export const effectiveConfigSchema = z.looseObject({ content: z.string(), format: manifestFormatSchema, revision: z.string().optional() });

export const speedTierResponseSchema = z.enum(['standard', 'fast', 'ultrafast']);
export const protocolPresetResponseSchema = z.enum(['short', 'cf-2h', 'icpc-5h']);
export const scoringModeResponseSchema = z.enum(['icpc', 'cf', 'ioi', 'last_ac']);

export const catalogAgentSchema = z.strictObject({
  id: z.string(), name: z.string().optional(), path: z.string(), model: z.string(), vendor: z.string().optional(),
  speed_tier: speedTierResponseSchema.optional(),
  harness: z.string(), provider: z.string().optional(), provider_available: z.boolean(), valid: z.boolean(), issues: z.array(z.string()),
});
export const catalogContestSchema = z.strictObject({
  id: z.string(), path: z.string(), title: z.string(), data_version: z.number(),
  judge_kind: z.string(), problem_count: z.number().int().nonnegative(), time_limit_ms: z.number().int().positive(),
  protocol_preset: protocolPresetResponseSchema.optional(), scoring_mode: scoringModeResponseSchema.optional(),
  valid: z.boolean(), issues: z.array(z.string()),
});
export const matrixResponseSchema = z.strictObject({ cells: z.array(z.strictObject({ agent: z.string(), contest: z.string(), compatible: z.boolean(), reason: z.string().optional() })) });
export type CatalogAgent = z.infer<typeof catalogAgentSchema>;
export type CatalogContest = z.infer<typeof catalogContestSchema>;

export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'void', 'cancelled', 'interrupted']);
export const studioJobSchema = z.strictObject({
  status: runStatusSchema,
  run_id: z.uuid().optional(),
  reason: z.string().optional(),
  agent_id: z.string(),
  agent_name: z.string().optional(),
  agent_revision: z.string(),
  contest_id: z.string(),
  data_version: z.number().int().positive(),
  harness: z.enum(['builtin-responses', 'codex']),
  model_family_id: z.string().optional(),
  speed_tier: speedTierResponseSchema.optional(),
});
export const batchSummarySchema = z.strictObject({
  id: z.uuid(),
  created_at: z.iso.datetime(),
  jobs: z.array(studioJobSchema),
});
export const batchesResponseSchema = z.strictObject({
  batches: z.array(batchSummarySchema),
  error: z.string().nullable(),
  busy: z.boolean(),
});
export const planResponseSchema = z.strictObject({
  token: z.uuid(),
  jobs: z.array(z.strictObject({
    agent_id: z.string(),
    agent_name: z.string().optional(),
    agent_revision: z.string(),
    contest_id: z.string(),
    data_version: z.number().int().positive(),
    speed_tier: speedTierResponseSchema.optional(),
  })),
});
export const logsResponseSchema = z.strictObject({ stdout: z.string(), stderr: z.string() });
export const idResponseSchema = z.strictObject({ id: z.uuid() });
export const pathResponseSchema = z.strictObject({ path: z.string() });
export const cancelResponseSchema = z.strictObject({ requested: z.boolean() });

export type RunStatus = z.infer<typeof runStatusSchema>;
export type StudioJob = z.infer<typeof studioJobSchema>;
export type BatchSummary = z.infer<typeof batchSummarySchema>;
export type BatchesResponse = z.infer<typeof batchesResponseSchema>;
export type PlanResponse = z.infer<typeof planResponseSchema>;
export type LogsResponse = z.infer<typeof logsResponseSchema>;
