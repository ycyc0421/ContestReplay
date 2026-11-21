import { createHash } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export const protocolPresetNames = ['short', 'cf-2h', 'icpc-5h'] as const;
export type ProtocolPresetName = (typeof protocolPresetNames)[number];

export const scoringModes = ['icpc', 'cf', 'ioi', 'last_ac'] as const;
export type ScoringMode = (typeof scoringModes)[number];

export type SandboxResources = {
  readonly memory: string;
  readonly cpus: string;
  readonly pids: number;
  readonly workspace: string;
};

export type ProtocolPreset = {
  readonly maxTurns: number;
  readonly requestTimeoutMs: number;
  readonly pdfMaxPages: number;
  readonly pdfMaxBytes: number;
  readonly diagnosticMaxBytes: number;
  readonly settlementMs: number;
  readonly sandbox: SandboxResources;
};

export const protocolPresets: Readonly<Record<ProtocolPresetName, ProtocolPreset>> = Object.freeze({
  short: Object.freeze({
    maxTurns: 64,
    requestTimeoutMs: 360_000,
    pdfMaxPages: 64,
    pdfMaxBytes: 32_000_000,
    diagnosticMaxBytes: 8 * 1024 * 1024,
    settlementMs: 120_000,
    sandbox: Object.freeze({ memory: '4g', cpus: '2', pids: 256, workspace: '512m' }),
  }),
  'cf-2h': Object.freeze({
    maxTurns: 192,
    requestTimeoutMs: 600_000,
    pdfMaxPages: 96,
    pdfMaxBytes: 64_000_000,
    diagnosticMaxBytes: 16 * 1024 * 1024,
    settlementMs: 240_000,
    sandbox: Object.freeze({ memory: '4g', cpus: '2', pids: 256, workspace: '512m' }),
  }),
  'icpc-5h': Object.freeze({
    maxTurns: 512,
    requestTimeoutMs: 600_000,
    pdfMaxPages: 128,
    pdfMaxBytes: 64_000_000,
    diagnosticMaxBytes: 16 * 1024 * 1024,
    settlementMs: 300_000,
    sandbox: Object.freeze({ memory: '4g', cpus: '2', pids: 256, workspace: '1g' }),
  }),
});

const baseProtocol = Object.freeze({
  id: 'responses-pdf-mcp',
  version: 1,
  timeLimitMs: 15 * 60_000,
  maxSubmissions: 100,
  maxOutputTokens: 4096,
  pdfInput: 'native-inline-pdf',
  parallelToolCalls: false,
  instructions: 'You are competing in this contest. Read the complete attached PDF, including its diagrams. Choose the problems and order yourself. Use submit with the exact problem ID as printed and your final answer. Only submissions are scored. Use finish when done. No external resources are allowed.',
  tools: ['submit', 'status', 'finish'] as const,
});

export function resolveProtocolPreset(rules?: { time_limit_ms?: number; protocol_preset?: ProtocolPresetName }): ProtocolPresetName {
  if (rules?.protocol_preset) return rules.protocol_preset;
  const limitMs = rules?.time_limit_ms ?? baseProtocol.timeLimitMs;
  if (limitMs <= 30 * 60_000) return 'short';
  if (limitMs <= 180 * 60_000) return 'cf-2h';
  return 'icpc-5h';
}

export function resolveScoringMode(rules?: { scoring_mode?: ScoringMode }): ScoringMode {
  return rules?.scoring_mode ?? 'last_ac';
}

export function protocolForPreset(name: ProtocolPresetName = 'short') {
  const preset = protocolPresets[name];
  return Object.freeze({
    ...baseProtocol,
    preset: name,
    requestTimeoutMs: preset.requestTimeoutMs,
    maxTurns: preset.maxTurns,
    pdfMaxPages: preset.pdfMaxPages,
    pdfMaxBytes: preset.pdfMaxBytes,
    diagnosticMaxBytes: preset.diagnosticMaxBytes,
    settlementMs: preset.settlementMs,
    sandbox: preset.sandbox,
    codex: Object.freeze({
      id: 'codex-pdf-pages-mcp',
      renderer: `Poppler PNG, long edge 1600; 1–${preset.pdfMaxPages} pages`,
      tools: ['submit', 'status', 'finish'] as const,
      settlementMs: preset.settlementMs,
    }),
  });
}

export const protocol = protocolForPreset('short');

export const toolDefinitions = [
  { type: 'function', name: 'submit', description: 'Submit a final answer for one problem.', strict: true,
    parameters: { type: 'object', properties: { problem_id: { type: 'string' }, answer: { type: 'string' } }, required: ['problem_id', 'answer'], additionalProperties: false } },
  { type: 'function', name: 'status', description: 'Read a submission verdict or remaining time and accepted problems.', strict: true,
    parameters: { type: 'object', properties: { submission_id: { type: ['string', 'null'] } }, required: ['submission_id'], additionalProperties: false } },
  { type: 'function', name: 'finish', description: 'End the contest and close submissions.', strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
] as const;

const digestCache = new Map<ProtocolPresetName, string>();
export function protocolDigestForPreset(name: ProtocolPresetName = 'short') {
  let cached = digestCache.get(name);
  if (!cached) {
    cached = digest(JSON.stringify({ protocol: protocolForPreset(name), toolDefinitions }));
    digestCache.set(name, cached);
  }
  return cached;
}

export const protocolDigest = protocolDigestForPreset('short');
