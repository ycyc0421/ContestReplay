import type { OjAccount, OjAccountPool, OjAccounts, OjPlatform } from '../oj-accounts.js';
import {
  CODEFORCES_DEFAULT_SETTLEMENT_MS,
  CODEFORCES_LANGUAGE_PRESETS,
  type CodeforcesJudgeConfig,
  createCodeforcesJudge,
  previewCodeforcesContest,
} from './codeforces.js';
import {
  HYDRO_DEFAULT_SETTLEMENT_MS,
  HYDRO_LANGUAGE_PRESETS,
  type HydroJudgeConfig,
  createHydroJudge,
  previewHydroContest,
} from './hydro.js';
import {
  QOJ_DEFAULT_SETTLEMENT_MS,
  QOJ_LANGUAGE_PRESETS,
  type QojJudgeConfig,
  createQojJudge,
  previewQojContest,
} from './qoj.js';
import {
  VJUDGE_DEFAULT_SETTLEMENT_MS,
  VJUDGE_LANGUAGE_PRESETS,
  type VjudgeJudgeConfig,
  createVjudgeJudge,
  previewVjudgeContest,
} from './vjudge.js';
import type {
  ContestPreview,
  ExecFileLike,
  FetchLike,
  LanguagePreset,
  ProgramJudge,
} from './types.js';

export * from './types.js';
export * from './problem-map.js';
export * from './codeforces.js';
export * from './qoj.js';
export * from './vjudge.js';
export * from './hydro.js';
export * from './probe.js';
export {
  OjAccounts,
  OjAccountPool,
  OjAccountError,
  defaultOriginFor,
  effectiveOriginFor,
  submissionQueueKey,
  ojPlatformSchema,
  ojTransportSchema,
  ojBackendSchema,
  ojAccountId,
  createOjAccountSchema,
  patchOjAccountSchema,
  rotateOjAccountSchema,
  ojAccountResponseSchema,
  ojAccountsResponseSchema,
  type OjPlatform,
  type OjTransport,
  type OjBackend,
  type OjAccount,
  type OjAccountLease,
  type OjAccountSelector,
  type OjAccountPoolStatus,
  type ExpectedAccountBinding,
  type ResolvedAccountTransport,
  type CreateOjAccountInput,
  type PatchOjAccountInput,
  type RotateOjAccountInput,
} from '../oj-accounts.js';

export type JudgeBackendConfig =
  | ({ kind: 'codeforces' } & CodeforcesJudgeConfig)
  | ({ kind: 'qoj' } & QojJudgeConfig)
  | ({ kind: 'vjudge' } & VjudgeJudgeConfig)
  | ({ kind: 'hydro' } & HydroJudgeConfig);

export interface JudgeBackendDescriptor {
  kind: OjPlatform;
  label: string;
  default_settlement_ms: number;
  supports_partial_score: boolean;
  requires_base_url: boolean;
  supports_gym?: boolean;
  supports_mixed_upstream?: boolean;
}

export interface CreateProgramJudgeDeps {
  accounts?: OjAccounts;
  pool?: OjAccountPool;
  account?: OjAccount;
  cookie?: string;
  executable?: string;
  fetchImpl?: FetchLike;
  execImpl?: ExecFileLike;
  delayImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  skipContestCheck?: boolean;
}

export function listJudgeBackends(): JudgeBackendDescriptor[] {
  return [
    {
      kind: 'codeforces',
      label: 'Codeforces (Regular & Gym)',
      default_settlement_ms: CODEFORCES_DEFAULT_SETTLEMENT_MS,
      supports_partial_score: false,
      requires_base_url: false,
      supports_gym: true,
    },
    {
      kind: 'qoj',
      label: 'QOJ (UOJ / ICPC & IOI)',
      default_settlement_ms: QOJ_DEFAULT_SETTLEMENT_MS,
      supports_partial_score: true,
      requires_base_url: false,
    },
    {
      kind: 'vjudge',
      label: 'VJudge (Multi-OJ Aggregator)',
      default_settlement_ms: VJUDGE_DEFAULT_SETTLEMENT_MS,
      supports_partial_score: true,
      requires_base_url: false,
      supports_mixed_upstream: true,
    },
    {
      kind: 'hydro',
      label: 'Hydro OJ (Self-Hosted)',
      default_settlement_ms: HYDRO_DEFAULT_SETTLEMENT_MS,
      supports_partial_score: true,
      requires_base_url: true,
    },
  ];
}

export function languagePresetsFor(platform: OjPlatform): LanguagePreset[] {
  switch (platform) {
    case 'codeforces':
      return [...CODEFORCES_LANGUAGE_PRESETS];
    case 'qoj':
      return [...QOJ_LANGUAGE_PRESETS];
    case 'vjudge':
      return [...VJUDGE_LANGUAGE_PRESETS];
    case 'hydro':
      return [...HYDRO_LANGUAGE_PRESETS];
  }
}

export function createProgramJudge(
  config: JudgeBackendConfig,
  deps: CreateProgramJudgeDeps = {},
): ProgramJudge {
  switch (config.kind) {
    case 'codeforces':
      return createCodeforcesJudge(config, deps);
    case 'qoj':
      return createQojJudge(config, deps);
    case 'vjudge':
      return createVjudgeJudge(config, deps);
    case 'hydro':
      return createHydroJudge(config, deps);
  }
}

export async function previewContest(
  platform: OjPlatform,
  contestId: number | string,
  opts?: {
    gym?: boolean;
    baseUrl?: string;
    domain?: string;
    cookie?: string;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
  },
): Promise<ContestPreview> {
  switch (platform) {
    case 'codeforces':
      return previewCodeforcesContest(contestId, opts);
    case 'qoj':
      return previewQojContest(contestId, opts);
    case 'vjudge':
      return previewVjudgeContest(contestId, opts);
    case 'hydro':
      if (!opts?.baseUrl) {
        throw new Error('Hydro contest preview requires opts.baseUrl');
      }
      return previewHydroContest(String(contestId), {
        baseUrl: opts.baseUrl,
        domain: opts.domain,
        cookie: opts.cookie,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
      });
  }
}
