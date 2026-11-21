import { z } from 'zod';
import { parseDocumentText, serializeDocument } from './serialization.js';

export const harnessKind = z.enum(['codex', 'builtin-responses']);
export type HarnessKind = z.infer<typeof harnessKind>;
export const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const effortSchema = z.enum(efforts);
const codexOptions = z.strictObject({ reasoning_effort: z.union([effortSchema, z.literal('default')]).optional() });
const temperature = z.number().min(0).max(2);
const builtinOptions = z.strictObject({ temperature: z.preprocess(value => typeof value === 'string' && value.trim() ? Number(value) : value, temperature.default(0)) });
const locale = z.enum(['C', 'C.UTF-8', 'POSIX']);
const localeOptions = locale.options.map(value => ({ value, label: value }));
const codexEnv = z.strictObject({ LANG: locale.optional(), LC_ALL: locale.optional() });
const emptyEnv = z.strictObject({});
export type HarnessEnv = z.infer<typeof codexEnv>;
const override = z.strictObject({ model_verbosity: z.enum(['low', 'medium', 'high']).optional() });
export type NativeOverride = z.infer<typeof override>;
export const builtinModel = z.literal('gpt-4.1-2025-04-14');
export const codexModel = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/);

const adapters = {
  codex: {
    label: 'Codex', version: '0.170.0', image: 'cr-codex:0.170.0', native_format: 'toml', supports_overrides: true,
    fields: [{ id: 'reasoning_effort', label: '推理强度', kind: 'select', required: false, default: 'default',
      options: ['default', ...efforts].map(value => ({ value, label: value === 'default' ? '使用模型默认值' : value })) }],
    options: codexOptions, model: codexModel, env: codexEnv,
  },
  'builtin-responses': {
    label: '内置 Responses', version: '0.1.0', image: 'cr-bench:0.1.0', native_format: 'json', supports_overrides: false,
    fields: [{ id: 'temperature', label: 'Temperature', kind: 'number', required: false, default: '0', description: '0–2' }],
    options: builtinOptions, model: builtinModel, env: emptyEnv,
  },
} as const;
export function harness<K extends HarnessKind>(kind: K): (typeof adapters)[K] { return adapters[kind]; }
export function harnessCapabilities() {
  return harnessKind.options.map(id => {
    const { label, version, native_format, supports_overrides, fields } = harness(id);
    const environment = Object.keys(harness(id).env.shape).map(name => ({ name, options: localeOptions }));
    return { id, label, version, native_format, supports_overrides, fields, environment };
  });
}
export function parseNative(kind: HarnessKind, content: string): NativeOverride {
  if (kind !== 'codex') throw new Error('This harness does not support native overrides');
  const raw = parseDocumentText(content, 'toml');
  // Intentionally allow only documented non-executable fields. A denylist would
  // miss new Codex features that can introduce external commands or credentials.
  const result = override.safeParse(raw);
  if (!result.success) throw new Error('Only model_verbosity (low, medium, high) may be overridden; safety, provider, MCP and environment settings are runner-managed');
  return result.data;
}
export function codexEffective(model: string, reasoning?: string, native?: NativeOverride) {
  return {
    ...(native?.model_verbosity ? { model_verbosity: native.model_verbosity } : {}),
    model, model_provider: 'cr', ...(reasoning ? { model_reasoning_effort: reasoning } : {}),
    approval_policy: 'never', sandbox_mode: 'danger-full-access', web_search: 'disabled', analytics: { enabled: false },
    model_providers: { cr: { name: 'ContestReplay relay', base_url: 'http://127.0.0.1:8745/v1', wire_api: 'responses', request_max_retries: 0, stream_max_retries: 0 } },
    mcp_servers: { contest: { command: 'node', args: ['/app/bridge.js', 'mcp'], required: true } },
  };
}
export function effectiveFor(profile: { harness: HarnessKind; model: string; reasoning_effort?: string; temperature?: number }, native?: NativeOverride) {
  const format = harness(profile.harness).native_format;
  const config = profile.harness === 'codex' ? codexEffective(profile.model, profile.reasoning_effort, native)
    : { model: profile.model, temperature: profile.temperature ?? 0 };
  return { format, config, content: serializeDocument(config, format) };
}
