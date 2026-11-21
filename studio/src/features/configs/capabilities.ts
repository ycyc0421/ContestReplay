import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { capabilitiesSchema, harnessFieldSchema, manifestFormatSchema } from '@studio-api';

export type ConfigFormat = z.infer<typeof manifestFormatSchema>;
export type HarnessField = z.infer<typeof harnessFieldSchema>;
export type StudioCapabilities = z.infer<typeof capabilitiesSchema>;
export type HarnessCapability = StudioCapabilities['harnesses'][number];

// Isolated compatibility description for the pre-capabilities runner. None of
// these legacy details are imported by the form components themselves.
const legacyCapabilities: StudioCapabilities = {
  schema_version: 1,
  features: { agent_vendor: false, agent_manifests: false, connections: false, native_overrides: false, contest_authoring: false, contest_upload: false, judge_authoring: false },
  manifest_formats: ['toml'],
  harnesses: [
    { id: 'codex', label: 'Codex', version: '0.170.0', native_format: 'toml', supports_overrides: false, fields: [{
      id: 'reasoning_effort', label: '推理强度', kind: 'select', required: false, default: 'default',
      options: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(value => ({ value, label: value === 'default' ? '使用模型默认值' : value })),
    }] },
    { id: 'builtin-responses', label: '内置 Responses', version: '0.1.0', native_format: 'toml', supports_overrides: false, fields: [] },
  ],
  judge_backends: [{ kind: 'local', label: '本地精确答案', supports_authoring: false }, { kind: 'codeforces', label: 'Codeforces', supports_authoring: false }],
};

async function loadCapabilities(): Promise<StudioCapabilities> {
  const response = await fetch('/api/capabilities');
  if (response.status === 404) return { ...legacyCapabilities, harnesses: legacyCapabilities.harnesses.map(h => ({ ...h, fields: [...h.fields] })) };
  if (!response.ok) throw new Error('无法读取 Studio 能力描述');
  return capabilitiesSchema.parse(await response.json());
}
export function useCapabilities() {
  return useQuery({ queryKey: ['capabilities'], queryFn: loadCapabilities, staleTime: Infinity, retry: false });
}
export const formatLabel = (format: ConfigFormat) => ({ toml: 'TOML', yaml: 'YAML', json: 'JSON' })[format];
export const formatExtension = (format: ConfigFormat) => ({ toml: '.toml', yaml: '.yaml', json: '.json' })[format];
