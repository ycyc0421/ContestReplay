import { z } from 'zod';
import { builtinModel, codexModel, effectiveFor, harness, harnessKind, parseNative } from './harnesses.js';
import { formatSchema } from './serialization.js';
import { connectionId, type Connections } from './connections.js';

export const agentKind = 'contestreplay.dev/agent';
const configRef = { format: formatSchema, schema: z.string().max(128).optional() };
export const nativeConfigSchema = z.union([
  z.strictObject({ ...configRef, content: z.string().max(64_000) }),
  z.strictObject({ ...configRef, path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export const manifestSchema = z.strictObject({ kind: z.literal(agentKind), schema_version: z.literal(1), id: connectionId,
  vendor: connectionId.optional(), model: z.string(), provider: connectionId.optional(), connection: connectionId.optional(),
  harness: z.strictObject({ kind: harnessKind, version: z.string(), options: z.record(z.string(), z.unknown()).default({}), env: z.record(z.string(), z.string()).optional(), native_config: nativeConfigSchema.optional() }),
}).refine(value => Boolean(value.provider) !== Boolean(value.connection), 'Specify exactly one provider (legacy: connection)');
export const manifestProvider = (manifest: z.infer<typeof manifestSchema>) => (manifest.provider ?? manifest.connection)!;
export class FieldError extends Error {
  constructor(readonly path: string[], message: string, readonly status = 400) { super(message); }
}
function fail(path: string[], message: string): never { throw new FieldError(path, message); }
export async function resolveManifest(raw: unknown, store: Connections, readExternal: (path: string, sha: string) => Promise<string>) {
  const manifest = manifestSchema.parse(raw);
  const { kind, version, options, native_config } = manifest.harness;
  const adapter = harness(kind);
  if (version !== adapter.version) fail(['harness', 'version'], `Requires ${adapter.label} ${adapter.version}`);
  let connection;
  try { connection = await store.get(manifestProvider(manifest)); }
  catch { return fail(['connection'], 'Connection is unavailable; select a saved local connection'); }
  const validate = <T>(schema: z.ZodType<T>, value: unknown, path: string[]) => {
    const result = schema.safeParse(value);
    if (!result.success) return fail(path.concat(result.error.issues[0]?.path.map(String) ?? []), 'Value is not supported by this harness');
    return result.data;
  };
  const env = validate(kind === 'codex' ? harness('codex').env : harness('builtin-responses').env, manifest.harness.env ?? {}, ['harness', 'env']);
  const shared = { id: manifest.id, api: connection.protocol, base_url: connection.base_url, api_key_env: 'OPENAI_API_KEY' };
  const profile = kind === 'codex' ? (() => {
    const selected = validate(harness('codex').options, options, ['harness', 'options']);
    const effort = selected.reasoning_effort;
    return { ...shared, harness: kind, model: validate(codexModel, manifest.model, ['model']), reasoning_effort: effort === 'default' ? undefined : effort } as const;
  })() : { ...shared, harness: kind, model: validate(builtinModel, manifest.model, ['model']),
    temperature: validate(harness('builtin-responses').options, options, ['harness', 'options']).temperature } as const;
  let nativeText: string | undefined;
  let native;
  if (native_config) {
    if (!adapter.supports_overrides || native_config.format !== adapter.native_format) fail(['harness', 'native_config', 'format'], 'Native override format not supported by this harness');
    if (native_config.schema && native_config.schema !== `codex@${version}`) fail(['harness', 'native_config', 'schema'], 'Unsupported native config schema');
    try {
      nativeText = 'content' in native_config ? native_config.content : await readExternal(native_config.path, native_config.sha256);
      native = parseNative(kind, nativeText);
    } catch (err) { return fail(['harness', 'native_config'], err instanceof Error ? err.message : 'Invalid native override'); }
  }
  manifest.harness.options = profile.harness === 'codex' ? (profile.reasoning_effort ? { reasoning_effort: profile.reasoning_effort } : {}) : { temperature: profile.temperature };
  return { manifest, profile, native, nativeText, env, connection, effective: effectiveFor(profile, native) };
}
