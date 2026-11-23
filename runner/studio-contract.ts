import { z } from 'zod';

export const manifestFormatSchema = z.enum(['toml', 'yaml', 'json']);
export const harnessFieldSchema = z.strictObject({
  id: z.string(), label: z.string(), kind: z.enum(['select', 'text', 'number', 'boolean']),
  required: z.boolean(), default: z.string().optional(), description: z.string().optional(), placeholder: z.string().optional(),
  options: z.array(z.strictObject({ value: z.string(), label: z.string() })).optional(),
});
export const languagePresetSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  remote_id: z.string(),
  family: z.string().optional(),
});
export const protocolPresetInfoSchema = z.strictObject({
  id: z.enum(['short', 'cf-2h', 'icpc-5h']),
  max_turns: z.number().int().positive(),
  request_timeout_ms: z.number().int().positive(),
  pdf_max_pages: z.number().int().positive(),
  pdf_max_bytes: z.number().int().positive(),
  settlement_ms: z.number().int().positive(),
});
export const capabilitiesSchema = z.strictObject({
  schema_version: z.literal(1),
  features: z.strictObject({
    agent_vendor: z.boolean(),
    agent_manifests: z.boolean(),
    connections: z.boolean(),
    native_overrides: z.boolean(),
    contest_authoring: z.boolean(),
    contest_upload: z.boolean(),
    judge_authoring: z.boolean(),
    oj_accounts: z.boolean().optional(),
    push_targets: z.boolean().optional(),
    live_progress: z.boolean().optional(),
    replay: z.boolean().optional(),
    preflight_doctor: z.boolean().optional(),
    variant_builder: z.boolean().optional(),
    parallel_batches: z.boolean().optional(),
  }),
  manifest_formats: z.array(manifestFormatSchema).min(1),
  harnesses: z.array(z.strictObject({ id: z.string(), label: z.string(), version: z.string(), native_format: manifestFormatSchema,
    supports_overrides: z.boolean(), fields: z.array(harnessFieldSchema),
    environment: z.array(z.strictObject({ name: z.string(), options: z.array(z.strictObject({ value: z.string(), label: z.string() })) })).optional() })).min(1),
  judge_backends: z.array(z.strictObject({
    kind: z.string(),
    label: z.string(),
    supports_authoring: z.boolean(),
    default_settlement_ms: z.number().int().positive().optional(),
    supports_partial_score: z.boolean().optional(),
    requires_base_url: z.boolean().optional(),
    supports_gym: z.boolean().optional(),
    supports_mixed_upstream: z.boolean().optional(),
    language_presets: z.array(languagePresetSchema).optional(),
  })).min(1),
  protocol_presets: z.array(protocolPresetInfoSchema).optional(),
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

export const liveSummarySchema = z.strictObject({
  solved_count: z.number().int().nonnegative(),
  problem_count: z.number().int().nonnegative(),
  score: z.number().nonnegative(),
  max_score: z.number().nonnegative(),
  remaining_ms: z.number().int().nonnegative(),
  last_submission: z.strictObject({
    problem_id: z.string().min(1),
    verdict: z.string().min(1),
    elapsed_ms: z.number().int().nonnegative(),
  }).optional(),
  active: z.boolean(),
});

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
  repeat_index: z.number().int().min(1).max(20).optional(),
  repeat_total: z.number().int().min(1).max(20).optional(),
  live_summary: liveSummarySchema.optional(),
});
export const batchSummarySchema = z.strictObject({
  id: z.uuid(),
  created_at: z.iso.datetime(),
  concurrency: z.number().int().min(1).max(8).optional(),
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
    repeat_index: z.number().int().min(1).max(20).optional(),
    repeat_total: z.number().int().min(1).max(20).optional(),
  })),
});
export const logsResponseSchema = z.strictObject({ stdout: z.string(), stderr: z.string() });
export const idResponseSchema = z.strictObject({ id: z.uuid() });
export const pathResponseSchema = z.strictObject({ path: z.string() });
export const cancelResponseSchema = z.strictObject({ requested: z.boolean() });

export const preflightImageCheckSchema = z.strictObject({
  harness: z.string(),
  image: z.string(),
  ok: z.boolean(),
  digest: z.string().optional(),
  error: z.string().optional(),
});
export const preflightAgentCheckSchema = z.strictObject({
  path: z.string(),
  id: z.string().optional(),
  harness: z.string().optional(),
  ok: z.boolean(),
  credential_ok: z.boolean(),
  issues: z.array(z.string()),
});
export const preflightContestCheckSchema = z.strictObject({
  path: z.string(),
  id: z.string().optional(),
  judge_kind: z.string().optional(),
  protocol_preset: protocolPresetResponseSchema.optional(),
  ok: z.boolean(),
  oj_ready: z.boolean(),
  pdf: z.strictObject({
    page_count: z.number().int().nonnegative(),
    size_bytes: z.number().int().nonnegative(),
    ok: z.boolean(),
    issues: z.array(z.string()),
  }).optional(),
  issues: z.array(z.string()),
});
export const preflightCompatibilityCheckSchema = z.strictObject({
  agent: z.string(),
  contest: z.string(),
  compatible: z.boolean(),
  reason: z.string().optional(),
});
export const preflightReportSchema = z.strictObject({
  ok: z.boolean(),
  checked_at: z.iso.datetime(),
  images: z.array(preflightImageCheckSchema),
  agents: z.array(preflightAgentCheckSchema),
  contests: z.array(preflightContestCheckSchema),
  compatibility: z.array(preflightCompatibilityCheckSchema),
});

export const coverageCellSchema = z.strictObject({
  agent_id: z.string(),
  agent_revision: z.string(),
  contest_id: z.string(),
  data_version: z.number().int().positive(),
  completed_count: z.number().int().nonnegative(),
  void_count: z.number().int().nonnegative(),
  latest_status: runStatusSchema,
  latest_run_id: z.uuid().optional(),
  best_score: z.number().nonnegative().optional(),
  max_score: z.number().nonnegative().optional(),
});
export const coverageResponseSchema = z.strictObject({
  cells: z.array(coverageCellSchema),
});

// ---------------------------------------------------------------------------
// Studio V2 Contracts: OJ Accounts, Push Targets, Progress/Replay/Race,
// Ranked Results, Contest Preview, Agent/Contest Item CRUD & Variant Builder
// (100% browser-safe: ZERO node:* imports)
// ---------------------------------------------------------------------------

const nonNegInt = z.number().int().nonnegative();
const nonNegNum = z.number().nonnegative();
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);
const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(4096);

// --- OJ Accounts ---
export const ojPlatformSchema = z.enum(['codeforces', 'qoj', 'vjudge', 'hydro']);
export const ojTransportSchema = z.enum(['cookie', 'submitter']);
export const ojBackendSchema = z.enum(['secret-service', 'file', 'executable']);
export const ojAccountIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const ojPoolNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const ojHandleSchema = z.string().trim().min(1).max(80).regex(/^[^\r\n\t]+$/);

export const ojAccountSchema = z.strictObject({
  id: ojAccountIdSchema,
  label: z.string(),
  platform: ojPlatformSchema,
  handle: ojHandleSchema,
  pool: ojPoolNameSchema,
  transport: ojTransportSchema,
  base_url: httpUrlSchema.optional(),
  executable_path: z.string().min(1).max(4096).optional(),
  credential_ref: z.uuid().optional(),
  backend: ojBackendSchema,
  ready: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export const ojAccountsResponseSchema = z.strictObject({
  accounts: z.array(ojAccountSchema),
});

const createOjAccountBase = {
  id: ojAccountIdSchema.optional(),
  label: z.string().trim().min(1).max(120),
  platform: ojPlatformSchema,
  handle: ojHandleSchema,
  pool: ojPoolNameSchema.optional(),
  base_url: httpUrlSchema.optional(),
};
export const createOjAccountRequestSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    ...createOjAccountBase,
    transport: z.literal('cookie'),
    secret: z.string().trim().min(1).max(16_384),
  }),
  z.strictObject({
    ...createOjAccountBase,
    transport: z.literal('submitter'),
    executable_path: z.string().trim().min(1).max(4096),
  }),
]);
export const patchOjAccountRequestSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  handle: ojHandleSchema.optional(),
  pool: ojPoolNameSchema.optional(),
  base_url: httpUrlSchema.optional(),
  executable_path: z.string().trim().min(1).max(4096).optional(),
});
export const rotateOjAccountRequestSchema = z.strictObject({
  secret: z.string().trim().min(1).max(16_384),
});
export const ojAccountProbeRequestSchema = z.strictObject({
  platform: ojPlatformSchema,
  base_url: httpUrlSchema.optional(),
  secret: z.string().trim().min(1).max(16_384),
});
export const ojAccountProbeResponseSchema = z.strictObject({
  ok: z.boolean(),
  authenticated: z.boolean(),
  origin: z.string(),
  detected_handle: z.string().optional(),
  message: z.string(),
});

// --- Push Targets & Deliveries ---
export const pushTargetIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const pushEventTypeSchema = z.enum(['run.completed', 'run.progress', 'batch.completed']);
export const pushDeliveryEventSchema = z.enum(['run.completed', 'run.progress', 'batch.completed', 'ping']);
export const pushAuthModeSchema = z.enum(['none', 'bearer', 'hmac-sha256']);
export const pushBackendSchema = z.enum(['secret-service', 'file']);

export const pushTargetSchema = z.strictObject({
  id: pushTargetIdSchema,
  instance_id: z.uuid().optional(),
  label: z.string().trim().min(1).max(120),
  url: z.string().min(1),
  approved_origin: z.string().min(1),
  enabled: z.boolean(),
  events: z.array(pushEventTypeSchema).min(1).max(3),
  auth_mode: pushAuthModeSchema,
  credential_ref: z.uuid().optional(),
  backend: pushBackendSchema.optional(),
  credential_available: z.boolean().optional(),
  timeout_ms: z.number().int().min(100).max(30_000),
  max_retries: z.number().int().min(0).max(5),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export const pushTargetsResponseSchema = z.strictObject({
  targets: z.array(pushTargetSchema),
});
export const pushDeliverySchema = z.strictObject({
  delivery_id: z.uuid(),
  target_id: pushTargetIdSchema,
  event: pushDeliveryEventSchema,
  status: z.enum(['delivered', 'failed']),
  http_status: z.number().int().min(100).max(599).optional(),
  attempts: z.number().int().positive(),
  duration_ms: nonNegInt,
  error: z.string().max(500).optional(),
  timestamp: z.iso.datetime(),
});
export const pushDeliveriesResponseSchema = z.strictObject({
  deliveries: z.array(pushDeliverySchema),
});
export const createPushTargetRequestSchema = z.strictObject({
  id: pushTargetIdSchema.optional(),
  label: z.string().trim().min(1).max(120),
  url: httpUrlSchema,
  enabled: z.boolean().default(true),
  events: z.array(pushEventTypeSchema).min(1).max(3),
  auth_mode: pushAuthModeSchema.default('none'),
  secret: z.string().trim().min(8).max(8192).optional(),
  timeout_ms: z.number().int().min(100).max(30_000).default(10_000),
  max_retries: z.number().int().min(0).max(5).default(3),
});
export const patchPushTargetRequestSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  url: httpUrlSchema.optional(),
  enabled: z.boolean().optional(),
  events: z.array(pushEventTypeSchema).min(1).max(3).optional(),
  timeout_ms: z.number().int().min(100).max(30_000).optional(),
  max_retries: z.number().int().min(0).max(5).optional(),
});
export const rotatePushTargetRequestSchema = z.strictObject({
  secret: z.string().trim().min(8).max(8192),
  auth_mode: z.enum(['bearer', 'hmac-sha256']).optional(),
});

// --- Run Progress, SSE Status, Incremental Log Slice, Replay, Ghost Race ---
export const problemStatusSchema = z.enum(['unattempted', 'pending', 'accepted', 'partial', 'wrong']);
export const runProgressProblemSchema = z.strictObject({
  id: z.string().min(1),
  max_points: nonNegNum,
  attempts: nonNegInt,
  status: problemStatusSchema,
  best_score: nonNegNum,
  first_ac_ms: nonNegInt.optional(),
  last_verdict: z.string().optional(),
  last_elapsed_ms: nonNegInt.optional(),
});
export const runProgressActivitySchema = z.strictObject({
  seq: nonNegInt,
  elapsed_ms: nonNegInt,
  type: z.string().min(1),
  summary: z.string(),
  problem_id: z.string().optional(),
  submission_id: z.string().optional(),
  language: z.string().optional(),
  verdict: z.string().optional(),
  score: nonNegNum.optional(),
  turn: nonNegInt.optional(),
});
export const runProgressTelemetrySchema = z.strictObject({
  model_turns: nonNegInt,
  total_model_wait_ms: nonNegInt,
  total_input_tokens: nonNegInt,
  total_output_tokens: nonNegInt,
});
export const runProgressSchema = z.strictObject({
  run_id: z.uuid(),
  status: z.enum(['running', 'completed', 'void', 'unknown']),
  reason: z.string().optional(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  contest_id: z.string().min(1),
  contest_title: z.string().optional(),
  data_version: nonNegInt,
  scoring_mode: scoringModeResponseSchema.optional(),
  started_at: z.string().optional(),
  elapsed_ms: nonNegInt,
  time_limit_ms: nonNegInt,
  remaining_ms: nonNegInt,
  submissions_used: nonNegInt,
  max_submissions: nonNegInt,
  model_turns: nonNegInt,
  last_activity_ms: nonNegInt,
  last_activity_type: z.string().optional(),
  score: nonNegNum,
  max_score: nonNegNum,
  solved_count: nonNegInt,
  problem_count: nonNegInt,
  problem_breakdown_unavailable: z.boolean().optional(),
  problems: z.array(runProgressProblemSchema),
  recent_activity: z.array(runProgressActivitySchema),
  telemetry: runProgressTelemetrySchema,
});
export const runStatusEventSchema = z.strictObject({
  run_id: z.uuid(),
  status: runStatusSchema,
  reason: z.string().optional(),
});
export const runLogSliceSchema = z.strictObject({
  stream: z.enum(['stdout', 'stderr']),
  offset: nonNegInt,
  next_offset: nonNegInt,
  total_bytes: nonNegInt,
  has_more: z.boolean(),
  chunk: z.string(),
});
export const replaySubmissionSchema = z.strictObject({
  submission_id: z.string().min(1),
  problem_id: z.string().min(1),
  received_ms: nonNegInt,
  judged_ms: nonNegInt.optional(),
  verdict: z.string().min(1),
  score: nonNegNum.optional(),
  max_points: nonNegNum.optional(),
  language: z.string().optional(),
});
export const replayFrameKindSchema = z.enum([
  'run_started',
  'submission_received',
  'submission_judged',
  'model_turn',
  'settling',
  'judge_error',
  'finish',
  'run_ended',
]);
export const replayFrameSchema = z.strictObject({
  seq: nonNegInt,
  elapsed_ms: nonNegInt,
  kind: replayFrameKindSchema,
  summary: z.string(),
  problem_id: z.string().optional(),
  submission_id: z.string().optional(),
  language: z.string().optional(),
  verdict: z.string().optional(),
  score: nonNegNum.optional(),
  points_awarded: nonNegNum.optional(),
  turn: nonNegInt.optional(),
  duration_ms: nonNegInt.optional(),
  input_tokens: nonNegInt.optional(),
  output_tokens: nonNegInt.optional(),
  source: z.string().optional(),
  diff: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  cumulative_score: nonNegNum,
  solved_count: nonNegInt,
});
export const sessionSummarySchema = z.strictObject({
  file: z.string().min(1),
  entries: z.array(z.strictObject({
    index: nonNegInt,
    role: z.string().optional(),
    type: z.string().optional(),
    timestamp: z.string().optional(),
    summary: z.string(),
  })),
  truncated: z.boolean(),
});
export const problemMetaSchema = z.strictObject({
  id: z.string().min(1),
  max_points: nonNegNum,
});
export const runReplaySchema = z.strictObject({
  run_id: z.uuid(),
  status: z.enum(['running', 'completed', 'void', 'unknown']),
  reason: z.string().optional(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  contest_id: z.string().min(1),
  contest_title: z.string().optional(),
  data_version: nonNegInt,
  contest_revision: sha256Digest.optional(),
  protocol_id: z.string().min(1).optional(),
  protocol_version: nonNegInt.optional(),
  protocol_sha256: sha256Digest.optional(),
  scoring_mode: scoringModeResponseSchema,
  started_at: z.string().optional(),
  time_limit_ms: nonNegInt,
  duration_ms: nonNegInt,
  problem_breakdown_unavailable: z.boolean().optional(),
  problems: z.array(problemMetaSchema),
  submissions: z.array(replaySubmissionSchema),
  frames: z.array(replayFrameSchema),
  telemetry: runProgressTelemetrySchema,
  session_summaries: z.array(sessionSummarySchema).optional(),
});
export const projectedProblemSchema = z.strictObject({
  id: z.string().min(1),
  status: problemStatusSchema,
  attempts: nonNegInt,
  wrong_attempts: nonNegInt,
  score: nonNegNum,
  max_points: nonNegNum,
  first_ac_ms: nonNegInt.optional(),
  last_verdict: z.string().optional(),
});
export const ghostRaceParticipantSchema = z.strictObject({
  run_id: z.uuid(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  status: z.enum(['running', 'completed', 'void', 'unknown']),
  time_limit_ms: nonNegInt,
  duration_ms: nonNegInt,
  final_score: nonNegNum,
  final_solved_count: nonNegInt,
  final_penalty: nonNegInt,
  submissions: z.array(replaySubmissionSchema),
});
export const ghostRaceMilestoneSchema = z.strictObject({
  elapsed_ms: nonNegInt,
  run_id: z.uuid(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  seq: nonNegInt,
  kind: z.enum(['submission_received', 'submission_judged', 'finish', 'run_ended']),
  problem_id: z.string().optional(),
  submission_id: z.string().optional(),
  language: z.string().optional(),
  verdict: z.string().optional(),
  score: nonNegNum.optional(),
  summary: z.string(),
});
export const ghostRaceStandingSchema = z.strictObject({
  rank: z.number().int().positive().nullable(),
  status: z.enum(['running', 'completed', 'void', 'unknown']),
  provisional: z.boolean(),
  unranked: z.boolean(),
  run_id: z.uuid(),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  score: nonNegNum,
  max_score: nonNegNum,
  solved_count: nonNegInt,
  penalty: nonNegInt,
  penalty_ms: nonNegInt,
  last_ac_ms: nonNegInt,
  submissions_used: nonNegInt,
  finished: z.boolean(),
  problems: z.array(projectedProblemSchema),
});
export const ghostRaceSnapshotSchema = z.strictObject({
  at_elapsed_ms: nonNegInt,
  scoring_mode: scoringModeResponseSchema,
  standings: z.array(ghostRaceStandingSchema),
});
export const ghostRaceSchema = z.strictObject({
  contest_id: z.string().min(1),
  contest_title: z.string().optional(),
  data_version: nonNegInt,
  contest_revision: sha256Digest,
  protocol_id: z.string().min(1),
  protocol_version: nonNegInt,
  protocol_sha256: sha256Digest,
  time_limit_ms: nonNegInt,
  timeline_end_ms: nonNegInt,
  scoring_mode: scoringModeResponseSchema,
  problems: z.array(problemMetaSchema).min(1),
  participants: z.array(ghostRaceParticipantSchema).min(1).max(8),
  milestones: z.array(ghostRaceMilestoneSchema),
  samples: z.array(ghostRaceSnapshotSchema).optional(),
});
export const ghostRaceRequestSchema = z.strictObject({
  run_ids: z.array(z.uuid()).min(1).max(8),
  scoring_mode: scoringModeResponseSchema.optional(),
  sample_step_ms: z.number().int().positive().max(3_600_000).optional(),
});

// --- Ranked Results ---
export const rankedOmittedReasonSchema = z.enum([
  'missing_run_file',
  'invalid_run_metadata',
  'invalid_event_log',
  'export_failed',
]);
export const rankedOmittedRunSchema = z.strictObject({
  run_id: z.uuid(),
  reason: rankedOmittedReasonSchema,
});
export const rankedProblemScoreSchema = z.strictObject({
  solved: z.boolean(),
  attempts_before_ac: nonNegInt,
  first_ac_ms: nonNegInt.optional(),
  penalty_minutes: nonNegInt.optional(),
  points: nonNegNum,
});
export const scoredResultSchema = z.strictObject({
  mode: scoringModeResponseSchema,
  primary: z.number(),
  secondary: z.number(),
  solved: nonNegInt,
  penalty_minutes: nonNegInt.optional(),
  points: nonNegNum.optional(),
  tie_break_ms: nonNegInt,
  last_ac_ms: nonNegInt.optional(),
  scoring_unavailable: z.boolean().optional(),
  per_problem: z.record(z.string(), rankedProblemScoreSchema),
});
export const rankedResultSubmissionSchema = z.strictObject({
  id: z.string(),
  problem_id: z.string(),
  elapsed_ms: nonNegInt,
  verdict: z.string(),
  language: z.string().optional(),
  score: nonNegNum.optional(),
  max_points: nonNegInt.optional(),
  remote_submission_id: z.union([z.string(), z.number().int()]).optional(),
});
export const rankedResultTelemetrySchema = z.strictObject({
  model_turns: nonNegInt,
  model_wait_ms: nonNegInt,
  total_input_tokens: nonNegInt.optional(),
  total_output_tokens: nonNegInt.optional(),
  wall_ms: nonNegInt.optional(),
});
export const rankedResultModelSchema = z.strictObject({
  requested: z.string(),
  observed: z.array(z.string()),
  family: z.string().optional(),
  vendor: z.string().optional(),
  reasoning_effort: z.string().optional(),
  speed_tier: speedTierResponseSchema.optional(),
  service_tier: z.string().optional(),
});
export const rankedResultSchema = z.strictObject({
  run_id: z.uuid(),
  contest_id: z.string(),
  contest_title: z.string().optional(),
  data_version: nonNegInt,
  contest_revision: sha256Digest,
  protocol_id: z.string(),
  protocol_version: nonNegInt,
  protocol_sha256: sha256Digest,
  protocol_preset: z.string().optional(),
  scoring_mode: scoringModeResponseSchema.optional(),
  points_known: z.boolean().optional(),
  agent_id: z.string(),
  agent_name: z.string().optional(),
  agent_revision: sha256Digest,
  harness: z.strictObject({ kind: z.string(), version: z.string() }),
  model: rankedResultModelSchema,
  score: nonNegNum,
  max_score: nonNegInt,
  telemetry: rankedResultTelemetrySchema.optional(),
  submissions: z.array(rankedResultSubmissionSchema),
});
export const rankedEntrySchema = z.strictObject({
  result: rankedResultSchema,
  finish_ms: nonNegInt,
  scoring: scoredResultSchema,
});
export const rankedRowSchema = rankedEntrySchema.extend({
  rank: z.number().int().positive().nullable(),
  variants: z.array(rankedEntrySchema).optional(),
});
export const rankedResultsResponseSchema = z.strictObject({
  scoring_mode: scoringModeResponseSchema.nullable(),
  group_by: z.enum(['revision', 'model']),
  groups: z.array(z.array(rankedRowSchema)),
  omitted_runs: z.array(rankedOmittedRunSchema),
});

// --- Contest Preview ---
export const contestPreviewProblemSchema = z.strictObject({
  remote_id: z.string(),
  title: z.string().optional(),
  max_points: nonNegNum.optional(),
  upstream_oj: z.string().optional(),
  upstream_problem: z.string().optional(),
});
export const contestPreviewSchema = z.strictObject({
  platform: ojPlatformSchema,
  contest_ref: z.string(),
  title: z.string(),
  status: z.enum(['finished', 'active', 'unknown']),
  problems: z.array(contestPreviewProblemSchema),
  suggested_languages: z.array(languagePresetSchema),
  statement_pdf_url: z.string().optional(),
});
export const problemMapMatchSchema = z.strictObject({
  local_id: z.string(),
  remote_id: z.string(),
  strategy: z.enum(['exact', 'normalized', 'numeric_to_alpha', 'alpha_to_numeric', 'positional']),
  confidence: z.enum(['exact', 'high', 'medium', 'low']),
});
export const problemMapInferenceSchema = z.strictObject({
  problem_map: z.record(z.string(), z.string()),
  confirmed_map: z.record(z.string(), z.string()),
  suggested_map: z.record(z.string(), z.string()),
  matches: z.array(problemMapMatchSchema),
  unmapped_local: z.array(z.string()),
  unmapped_remote: z.array(z.string()),
});
export const pdfInfoSchema = z.strictObject({
  path: z.string().min(1),
  size_bytes: nonNegInt,
  sha256: sha256Digest,
  page_count: nonNegInt,
  problems: z.array(z.strictObject({ id: z.string().min(1), title: z.string() })),
  problem_ids: z.array(z.string().min(1)),
  text_length: nonNegInt,
  text_truncated: z.boolean(),
  extractor: z.enum(['poppler', 'fallback']),
});
export const contestPreviewResponseSchema = z.strictObject({
  preview: contestPreviewSchema,
  language_presets: z.array(languagePresetSchema),
  problem_map_suggestion: problemMapInferenceSchema.optional(),
  pdf_info: pdfInfoSchema.optional(),
});

// --- Agent / Contest Item CRUD & Variant Builder ---
export const agentDigestsSchema = z.strictObject({
  source_sha256: sha256Digest.optional(),
  profile_sha256: sha256Digest,
  native_sha256: sha256Digest.optional(),
  effective_sha256: sha256Digest,
});
export const agentItemResponseSchema = z.strictObject({
  path: z.string(),
  format: manifestFormatSchema,
  document: z.unknown(),
  valid: z.boolean(),
  issues: z.array(z.string()),
  id: z.string().optional(),
  name: z.string().optional(),
  model: z.string().optional(),
  vendor: z.string().optional(),
  harness: z.string().optional(),
  provider: z.string().optional(),
  speed_tier: speedTierResponseSchema.optional(),
  digests: agentDigestsSchema.optional(),
});
export const agentVariantItemSchema = z.strictObject({
  id: z.string(),
  path: z.string(),
  format: manifestFormatSchema,
  manifest: z.unknown(),
  revision: z.string().optional(),
  digests: agentDigestsSchema,
  warnings: z.array(z.string()),
});
export const agentVariantsResponseSchema = z.strictObject({
  dry_run: z.boolean(),
  variants: z.array(agentVariantItemSchema),
});
export const contestItemResponseSchema = z.strictObject({
  path: z.string(),
  document: z.unknown(),
  valid: z.boolean(),
  issues: z.array(z.string()),
  contest_id: z.string().optional(),
  contest_revision: sha256Digest.optional(),
  judge_kind: z.string().optional(),
  protocol_preset: protocolPresetResponseSchema.optional(),
  scoring_mode: scoringModeResponseSchema.optional(),
  judge: z.unknown().optional(),
});

export type RunStatus = z.infer<typeof runStatusSchema>;
export type StudioJob = z.infer<typeof studioJobSchema>;
export type BatchSummary = z.infer<typeof batchSummarySchema>;
export type BatchesResponse = z.infer<typeof batchesResponseSchema>;
export type PlanResponse = z.infer<typeof planResponseSchema>;
export type LogsResponse = z.infer<typeof logsResponseSchema>;
export type PreflightReport = z.infer<typeof preflightReportSchema>;
export type CoverageCell = z.infer<typeof coverageCellSchema>;
export type CoverageResponse = z.infer<typeof coverageResponseSchema>;

export type OjPlatformContract = z.infer<typeof ojPlatformSchema>;
export type OjAccountContract = z.infer<typeof ojAccountSchema>;
export type OjAccountsResponse = z.infer<typeof ojAccountsResponseSchema>;
export type CreateOjAccountRequest = z.input<typeof createOjAccountRequestSchema>;
export type PatchOjAccountRequest = z.input<typeof patchOjAccountRequestSchema>;
export type RotateOjAccountRequest = z.input<typeof rotateOjAccountRequestSchema>;

export type PushTargetContract = z.infer<typeof pushTargetSchema>;
export type PushTargetsResponse = z.infer<typeof pushTargetsResponseSchema>;
export type PushDeliveryContract = z.infer<typeof pushDeliverySchema>;
export type PushDeliveriesResponse = z.infer<typeof pushDeliveriesResponseSchema>;
export type CreatePushTargetRequest = z.input<typeof createPushTargetRequestSchema>;
export type PatchPushTargetRequest = z.input<typeof patchPushTargetRequestSchema>;
export type RotatePushTargetRequest = z.input<typeof rotatePushTargetRequestSchema>;

export type RunProgressContract = z.infer<typeof runProgressSchema>;
export type RunStatusEvent = z.infer<typeof runStatusEventSchema>;
export type RunLogSliceContract = z.infer<typeof runLogSliceSchema>;
export type RunReplayContract = z.infer<typeof runReplaySchema>;
export type GhostRaceContract = z.infer<typeof ghostRaceSchema>;
export type GhostRaceRequest = z.input<typeof ghostRaceRequestSchema>;

export type RankedOmittedRun = z.infer<typeof rankedOmittedRunSchema>;
export type RankedResultsResponse = z.infer<typeof rankedResultsResponseSchema>;
export type ContestPreviewResponse = z.infer<typeof contestPreviewResponseSchema>;
export type AgentItemResponse = z.infer<typeof agentItemResponseSchema>;
export type ContestItemResponse = z.infer<typeof contestItemResponseSchema>;
export type AgentVariantsResponse = z.infer<typeof agentVariantsResponseSchema>;
