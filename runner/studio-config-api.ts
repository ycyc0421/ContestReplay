import { mkdir, readdir } from 'node:fs/promises';
import { persistAgentManifest } from './author.js';
import { join, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { agentKind, FieldError, manifestProvider, nativeConfigSchema } from './agent-manifest.js';
import { agentDigests, file, resolveAgentManifest, revisionFor, sha256 } from './config.js';
import { connectionId, ConnectionError, createConnectionSchema, patchConnectionSchema, rotateConnectionSchema, type Connections } from './connections.js';
import { createContestDocument, outputPath } from './contest-author.js';
import { imageFor, inspectImage } from './docker.js';
import { harnessCapabilities } from './harnesses.js';
import { uploadMaterial } from './materials.js';
import { protocolDigest } from './protocol.js';
import { capabilitiesSchema, effectiveConfigSchema, providerResponseSchema, providersResponseSchema } from './studio-contract.js';
import { agentCatalog, contestCatalog, evaluateMatrix } from './catalog.js';
import { documentFormat, formatSchema, parseDocumentText, serializeDocument } from './serialization.js';

const agentRequest = z.strictObject({ document: z.unknown(), format: formatSchema.optional(), file: z.string().min(1).max(4096).optional(), native_config: nativeConfigSchema.optional() });
const capabilities = capabilitiesSchema.parse({
  schema_version: 1,
  features: { agent_vendor: true, agent_manifests: true, connections: true, native_overrides: true, contest_authoring: true, contest_upload: true, judge_authoring: true },
  manifest_formats: formatSchema.options, harnesses: harnessCapabilities(),
  judge_backends: [{ kind: 'local', label: '本地精确答案', supports_authoring: true }, { kind: 'codeforces', label: 'Codeforces', supports_authoring: false }],
});

export function configError(error: unknown) {
  if (error instanceof ZodError) return { status: 400, error: 'Invalid configuration', issues: error.issues.map(issue => ({
    path: issue.path.map(String), code: issue.code, message: safeIssue(issue.code),
  })) };
  if (error instanceof FieldError) return { status: error.status, error: error.message, issues: [{ path: error.path, code: 'invalid_field', message: error.message }] };
  if (error instanceof ConnectionError) return { status: error.status, error: error.message, issues: [] };
  if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return { status: 409, error: 'Output already exists', issues: [{ path: ['file'], code: 'conflict', message: 'Output already exists' }] };
  return { status: 400, error: 'Could not process configuration', issues: [] };
}
const ZodError = z.ZodError;
const safeIssue = (code: string) => code === 'unrecognized_keys' ? 'Contains unsupported fields' : 'Invalid or missing value';

async function workspaceReferences(base: string, id: string) {
  const dirs = [base];
  let scanned = 0;
  while (dirs.length) for (const entry of await readdir(dirs.pop()!, { withFileTypes: true })) {
    if (++scanned > 10000) throw new ConnectionError('Workspace too large to verify connection references', 409);
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'coverage', 'runs'].includes(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) { dirs.push(path); continue; }
    if (!entry.isFile() || !/\.(toml|yaml|yml|json)$/i.test(entry.name)) continue;
    const raw = await file(path, 1_000_000).then(bytes => parseDocumentText(bytes.toString('utf8'), documentFormat(path))).catch(() => undefined);
    if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === agentKind && (('provider' in raw && raw.provider === id) || ('connection' in raw && raw.connection === id))) return true;
  }
  return false;
}

export type StudioConfigOptions = { root: string; base: string; store: Connections; signal: AbortSignal; getImage?: typeof inspectImage };
export function isConfigRoute(path: string) {
  return /^\/api\/(?:capabilities|agents|providers|connections|contests|catalog|matrix)(?:\/|$)/.test(path);
}
export async function configRoute(path: string, req: IncomingMessage, opts: StudioConfigOptions, body: () => Promise<unknown>) {
  const { root, base, store, signal } = opts;
  const method = req.method;
  if (method === 'GET' && path === '/api/capabilities') return { data: capabilities };
  if (method === 'GET' && path === '/api/catalog/agents') return { data: { agents: await agentCatalog(base, store) } };
  if (method === 'GET' && path === '/api/catalog/contests') return { data: { contests: await contestCatalog(base) } };
  if (method === 'POST' && path === '/api/matrix') return { data: await evaluateMatrix(await body(), base, store) };
  const match = path.match(/^\/api\/(providers|connections)(?:\/([^/]+)(\/rotate)?)?$/);
  if (match) {
    const modern = match[1] === 'providers';
    const describe = async (value: Awaited<ReturnType<Connections['get']>>) => modern
      ? providerResponseSchema.parse(await store.provider(value.id)) : value;
    if (!match[2]) {
      if (method === 'GET') return { data: modern ? providersResponseSchema.parse({ providers: await store.listProviders() }) : { connections: await store.list() } };
      if (modern && method === 'POST') return { status: 201, data: await describe(await store.create(createConnectionSchema.parse(await body()))) };
    } else {
      const id = connectionId.parse(match[2]);
      if (match[3]) {
        if (modern && method === 'POST') return { data: await describe(await store.rotate(id, rotateConnectionSchema.parse(await body()).secret)) };
      } else {
        if (method === 'PATCH') return { data: await describe(await store.patch(id, patchConnectionSchema.parse(await body()))) };
        if (method === 'DELETE') {
          await store.remove(id, key => workspaceReferences(base, key));
          return { data: { deleted: true } };
        }
      }
    }
  }
  if (method === 'POST' && ['/api/agents', '/api/agents/preview', '/api/agents/validate'].includes(path)) {
    const input = agentRequest.parse(await body());
    const saving = path === '/api/agents';
    const validating = path.endsWith('/validate');
    const raw = z.record(z.string(), z.unknown()).parse(input.document);
    const managed = saving && !input.file;
    if (managed) { connectionId.parse(raw.id); await mkdir(join(base, 'agents'), { recursive: true }); }
    const file = input.file ?? (managed ? `agents/${String(raw.id)}.toml` : undefined);
    const format = input.format ?? (managed ? 'toml' as const : undefined);
    if (saving && (!file || !format)) throw new FieldError(['file'], 'File and manifest format are required');
    const target = file ? await outputPath(base, file) : resolve(base, 'agent.toml');
    if (file) {
      let detected;
      try { detected = documentFormat(target); } catch { throw new FieldError(['file'], 'Unsupported manifest extension'); }
      if (format && detected !== format) throw new FieldError(['file'], 'File extension does not match selected manifest format');
    }
    if (input.native_config) {
      const h = z.record(z.string(), z.unknown()).parse(raw.harness);
      if (h.native_config) throw new FieldError(['harness', 'native_config'], 'Only one native override may be supplied');
      raw.harness = { ...h, native_config: input.native_config };
    }
    const override = raw.harness && typeof raw.harness === 'object' && 'native_config' in raw.harness
      ? nativeConfigSchema.safeParse(raw.harness.native_config).data : undefined;
    if (!file && override && 'path' in override) {
      throw new FieldError(['file'], 'Manifest path is required to resolve an external override');
    }
    const agent = await resolveAgentManifest(raw, target, store);
    const { profileDigest, nativeDigest, effectiveDigest } = agentDigests(agent.profile, agent.native, agent.nativeText, agent.env);
    const warnings: string[] = [];
    const image = validating ? undefined : await (opts.getImage ?? inspectImage)(imageFor(agent.profile.harness)).catch(() => {
      warnings.push('Harness image unavailable; the exact run revision will be computed when planning'); return undefined;
    });
    const revision = image ? revisionFor(agent.profile, effectiveDigest, image, protocolDigest) : undefined;
    const manifest = agent.manifest;
    const serialized = format ? serializeDocument(manifest, format) : undefined;
    const digests = { source_sha256: serialized === undefined ? undefined : sha256(serialized),
      profile_sha256: profileDigest, native_sha256: nativeDigest, effective_sha256: effectiveDigest };
    if (saving) {
      await persistAgentManifest(target, manifestProvider(manifest), serialized!, store);
      return { status: 201, data: { path: target, format, manifest, revision, digests, warnings } };
    }
    if (validating) return { data: { valid: true, issues: [], warnings, manifest, digests } };
    // Preview only the validated override semantics, not arbitrary file comments.
    const native = manifest.harness.native_config;
    const normalized = native && 'content' in native ? { ...manifest, harness: { ...manifest.harness,
      native_config: { ...native, content: serializeDocument(agent.native ?? {}, native.format) } } } : manifest;
    return { data: effectiveConfigSchema.parse({ content: agent.effective.content, format: agent.effective.format,
      manifest: normalized, connection: agent.connection, revision, digests, warnings, env: agent.env, rejected_overrides: [] }) };
  }
  if (method === 'POST' && path === '/api/contests/materials') return { status: 201, data: await uploadMaterial(root, req) };
  if (method === 'POST' && path === '/api/contests') return { status: 201, data: await createContestDocument(root, base, await body(), signal) };
  return { status: 404, data: { error: 'Not found', issues: [] } };
}
