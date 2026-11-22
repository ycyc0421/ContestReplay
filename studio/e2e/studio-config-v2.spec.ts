import { test, expect } from '@playwright/test';

const digest = 'a'.repeat(64);
const provider = { id: 'demo', label: 'Demo Provider', protocol: 'responses', base_url: 'https://api.openai.com/v1', credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', approved_origin: 'https://api.openai.com', backend: 'file', credential_available: true };
const capabilities = {
  schema_version: 1,
  features: { agent_vendor: true, agent_manifests: true, connections: true, native_overrides: true, contest_authoring: true, contest_upload: true, judge_authoring: true, oj_accounts: true, push_targets: true, variant_builder: true },
  manifest_formats: ['toml', 'yaml', 'json'],
  harnesses: [{ id: 'codex', label: 'Codex', version: '0.170.0', native_format: 'toml', supports_overrides: true, fields: [{ id: 'reasoning_effort', label: '推理强度', kind: 'select', required: false, default: 'default', options: ['default', 'high', 'max'].map(value => ({ value, label: value })) }] }],
  judge_backends: [
    { kind: 'local', label: '本地精确答案', supports_authoring: true },
    { kind: 'codeforces', label: 'Codeforces', supports_authoring: true, supports_gym: true, language_presets: [{ id: 'cpp17', label: 'C++17', remote_id: '54' }] },
    { kind: 'qoj', label: 'QOJ', supports_authoring: true, language_presets: [{ id: 'cpp17', label: 'C++17', remote_id: 'C++17' }] },
    { kind: 'hydro', label: 'Hydro', supports_authoring: true, requires_base_url: true, language_presets: [{ id: 'cpp17', label: 'C++17', remote_id: 'cc.cc17o2' }] },
  ],
  protocol_presets: [{ id: 'short', max_turns: 128, request_timeout_ms: 600000, pdf_max_pages: 64, pdf_max_bytes: 1000, settlement_ms: 120000 }],
};
const baseAgent = { id: 'agent-base', name: 'Base Agent', path: 'agents/agent-base.toml', model: 'gpt-test', vendor: 'openai', harness: 'codex', provider: 'demo', provider_available: true, speed_tier: 'standard', valid: true, issues: [] };
const baseContest = { id: 'contest-demo', path: 'contests/contest-demo.json', title: 'Contest Demo', data_version: 1, judge_kind: 'local', problem_count: 1, time_limit_ms: 900000, valid: true, issues: [] };

async function mockShell(page: import('@playwright/test').Page) {
  await page.route('**/api/capabilities', route => route.fulfill({ json: capabilities }));
  await page.route('**/api/providers', route => route.fulfill({ json: { providers: [provider] } }));
  await page.route('**/api/oj-accounts', route => route.fulfill({ json: { accounts: [] } }));
}

test('edits an Agent and dry-runs then applies a variant matrix', async ({ page }) => {
  await mockShell(page);
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: [baseAgent] } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [] } }));
  const document = { kind: 'contestreplay.dev/agent', schema_version: 1, id: 'agent-base', name: 'Base Agent', vendor: 'openai', provider: 'demo', model: 'gpt-test', speed_tier: 'standard', harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'high' } } };
  await page.route('**/api/agents/item?*', route => route.fulfill({ json: { path: baseAgent.path, format: 'toml', document, valid: true, issues: [], id: 'agent-base', name: 'Base Agent', model: 'gpt-test', vendor: 'openai', harness: 'codex', provider: 'demo', speed_tier: 'standard', digests: { profile_sha256: digest, effective_sha256: digest } } }));
  let updated: any;
  await page.route('**/api/agents/item', route => {
    if (route.request().method() === 'PUT') { updated = route.request().postDataJSON(); return route.fulfill({ json: { path: baseAgent.path } }); }
    return route.continue();
  });
  const variant = { id: 'agent-base-high', path: 'agents/agent-base-high.toml', format: 'toml', manifest: document, revision: digest, digests: { profile_sha256: digest, effective_sha256: digest }, warnings: [] };
  const variantCalls: any[] = [];
  await page.route('**/api/agents/variants', route => { const body = route.request().postDataJSON(); variantCalls.push(body); return route.fulfill({ status: body.dry_run ? 200 : 201, json: { dry_run: body.dry_run, variants: [variant] } }); });
  await page.goto('/configs');
  await page.getByRole('button', { name: '编辑 agent-base', exact: true }).click();
  await expect(page.getByLabel('Agent ID')).toBeDisabled();
  await page.getByLabel('展示名称').fill('Base / Fast');
  await page.getByRole('combobox', { name: '速度档位' }).click();
  await page.getByRole('option', { name: 'Fast', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  expect(updated.path).toBe(baseAgent.path);
  expect(updated.document.name).toBe('Base / Fast');
  expect(updated.document.speed_tier).toBe('fast');
  await page.getByRole('button', { name: '派生 agent-base 变体', exact: true }).click();
  // Toggling default effort on while standard speed is the only speed triggers source collision guard.
  await page.getByRole('checkbox', { name: 'effort default', exact: true }).click();
  await expect(page.getByText(/输出 ID 与源配置或已有文件冲突/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry-run 预览' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'effort default', exact: true }).click();
  await page.getByRole('button', { name: 'Dry-run 预览' }).click();
  await expect(page.getByText('agent-base-high', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /创建 1 个变体/ }).click();
  expect(variantCalls.map(call => call.dry_run)).toEqual([true, false]);
  expect(variantCalls[0].reasoning_efforts).toEqual(['high']);
});

test('preserves external native_config, shows legacy Agent read-only, and clears editor on delete', async ({ page }) => {
  await mockShell(page);
  const legacyAgent = { id: 'demo-codex', path: 'examples/demo/codex.toml', model: 'gpt-5.3-codex', harness: 'codex', provider_available: true, valid: true, issues: [] };
  let agentCatalog = [baseAgent, legacyAgent];
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: agentCatalog } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [] } }));
  const nativeOverride = { format: 'toml', path: 'override.toml', sha256: digest };
  const extDoc = {
    kind: 'contestreplay.dev/agent', schema_version: 1, id: 'agent-base', name: 'Base Agent', vendor: 'openai', provider: 'demo', model: 'gpt-test',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'high' }, native_config: nativeOverride },
  };
  const legacyDoc = { id: 'demo-codex', harness: 'codex', api: 'responses', model: 'gpt-5.3-codex', reasoning_effort: 'medium', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY' };
  await page.route('**/api/agents/item?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (route.request().method() === 'DELETE') {
      agentCatalog = agentCatalog.filter(item => item.path !== path);
      return route.fulfill({ json: { deleted: true, path } });
    }
    if (path === legacyAgent.path) {
      return route.fulfill({ json: { path: legacyAgent.path, format: 'toml', document: legacyDoc, valid: true, issues: [], id: 'demo-codex', model: 'gpt-5.3-codex', harness: 'codex' } });
    }
    return route.fulfill({ json: { path: baseAgent.path, format: 'toml', document: extDoc, valid: true, issues: [], id: 'agent-base', name: 'Base Agent', model: 'gpt-test', vendor: 'openai', harness: 'codex', provider: 'demo', speed_tier: 'standard' } });
  });
  let updated: any;
  await page.route('**/api/agents/item', route => {
    if (route.request().method() === 'PUT') { updated = route.request().postDataJSON(); return route.fulfill({ json: { path: baseAgent.path } }); }
    return route.continue();
  });

  await page.goto('/configs');
  // Legacy Agent renders read-only without a Save button
  await page.getByRole('button', { name: '编辑 demo-codex', exact: true }).click();
  await expect(page.getByText(/此配置使用旧版 Agent 格式/)).toBeVisible();
  await expect(page.getByText('OPENAI_API_KEY', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存修改' })).toHaveCount(0);

  // External native_config { path, sha256, format } is preserved on name-only save
  await page.getByRole('button', { name: '编辑 agent-base', exact: true }).click();
  await page.getByLabel('展示名称').fill('Base Renamed');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  expect(updated.document.harness.native_config).toEqual(nativeOverride);
  expect(updated.document.model_family_id).toBeUndefined();

  // Deleting the currently open Agent clears edit state back to "新建 Agent"
  await page.getByRole('button', { name: '删除 agent-base', exact: true }).click();
  await page.getByRole('button', { name: '删除配置', exact: true }).click();
  await expect(page.getByRole('tab', { name: '新建 Agent' })).toBeVisible();
});

test('preserves sub-minute time limit, PDF digest and local judge binding on metadata-only Contest edit and saves QOJ explicit problems', async ({ page }) => {
  await mockShell(page);
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [baseContest] } }));
  const localDoc = {
    kind: 'contestreplay.dev/contest', schema_version: 2, contest_id: 'contest-demo', data_version: 1, title: 'Contest Demo', source: { name: 'Local' },
    materials: { entrypoint: { kind: 'pdf', path: 'contests/contest-demo/problems.pdf', sha256: digest, redistribution: 'restricted' }, attachments: [] },
    problems: [{ id: '1', max_points: 10 }],
    rules: { time_limit_ms: 90_000, max_submissions: 100 },
    judge: { kind: 'local', answers: { path: 'contests/contest-demo/judge.json', sha256: digest, redistribution: 'restricted' } },
  };
  await page.route('**/api/contests/item?*', route => route.fulfill({ json: {
    path: baseContest.path, document: localDoc, valid: true, issues: [], contest_id: 'contest-demo', contest_revision: digest, judge_kind: 'local',
    judge: { schema_version: 1, problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] },
  } }));
  let updated: any;
  await page.route('**/api/contests/item', route => {
    if (route.request().method() === 'PUT') { updated = route.request().postDataJSON(); return route.fulfill({ json: { path: baseContest.path } }); }
    return route.continue();
  });
  let createdQoj: any;
  await page.route('**/api/contests', route => {
    createdQoj = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { path: 'contests/qoj-1.json' } });
  });

  await page.goto('/configs');
  await page.getByRole('tab', { name: /Contests/ }).click();
  await page.getByRole('button', { name: '编辑 contest-demo', exact: true }).click();
  await page.getByLabel('赛事标题').fill('Contest Demo Renamed');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  expect(updated.document.title).toBe('Contest Demo Renamed');
  expect(updated.document.rules.time_limit_ms).toBe(90_000);
  expect(updated.document.materials.entrypoint.sha256).toBe(digest);
  expect(updated.document.judge).toEqual(localDoc.judge);

  // Create QOJ Contest with explicit problems and string language IDs
  await page.getByRole('button', { name: '新建 Contest', exact: true }).click();
  await page.getByLabel('Contest ID').fill('qoj-1');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('tab', { name: '引用本机路径' }).click();
  await page.getByLabel('题面 PDF').fill('contests/qoj-1/problems.pdf');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('combobox', { name: '判题后端' }).click();
  await page.getByRole('option', { name: 'QOJ', exact: true }).click();
  await page.getByLabel('远程题目 1 题号').fill('A');
  await page.getByLabel('远程题目 1 分值').fill('100');
  await page.getByLabel('题号映射 problem_map').fill('{"A": "1001"}');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '仅保存', exact: true }).click();
  expect(createdQoj.document.problems).toEqual([{ id: 'A', max_points: 100 }]);
  expect(createdQoj.document.judge.kind).toBe('qoj');
  expect(createdQoj.document.judge.languages).toEqual({ cpp17: 'C++17' });
  expect(createdQoj.document.judge.problem_map).toEqual({ A: '1001' });
});

test('updates Contest data and local judge atomically', async ({ page }) => {
  await mockShell(page);
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [baseContest] } }));
  const document = {
    kind: 'contestreplay.dev/contest', schema_version: 2, contest_id: 'contest-demo', data_version: 1, title: 'Contest Demo', source: { name: 'Local' },
    materials: { entrypoint: { kind: 'pdf', path: 'contests/contest-demo/problems.pdf', redistribution: 'restricted' }, attachments: [{ kind: 'text', path: 'contests/contest-demo/note.txt', name: 'note.txt', redistribution: 'restricted' }] },
    rules: { time_limit_ms: 900000, max_submissions: 100 }, judge: { kind: 'local', answers: { path: 'contests/contest-demo/judge.json' } },
  };
  await page.route('**/api/contests/item?*', route => route.fulfill({ json: { path: baseContest.path, document, valid: true, issues: [], contest_id: 'contest-demo', contest_revision: digest, judge_kind: 'local', judge: { schema_version: 1, problems: [{ id: '1', max_points: 10, accepted_answers: ['42'] }] } } }));
  let updated: any;
  await page.route('**/api/contests/item', route => { if (route.request().method() === 'PUT') { updated = route.request().postDataJSON(); return route.fulfill({ json: { path: baseContest.path } }); } return route.continue(); });
  await page.goto('/configs');
  await page.getByRole('tab', { name: /Contests/ }).click();
  await page.getByRole('button', { name: '编辑 contest-demo', exact: true }).click();
  await expect(page.getByLabel('Contest ID')).toBeDisabled();
  await page.getByLabel('数据版本').fill('2');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByLabel('题面 PDF')).toHaveValue('contests/contest-demo/problems.pdf');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByLabel('题目 1 可接受答案').fill('99');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  expect(updated.path).toBe(baseContest.path);
  expect(updated.document.data_version).toBe(2);
  expect(updated.document.judge.problems[0].accepted_answers).toEqual(['99']);
  expect(updated.document.materials.attachments).toHaveLength(1);
});

test('creates OJ account and Push Target without echoing secrets', async ({ page }) => {
  let accounts: any[] = [];
  let targets: any[] = [];
  await page.route('**/api/providers', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/oj-accounts', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { accounts } });
    const input = route.request().postDataJSON();
    expect(input.secret).toBe('oj-cookie-secret');
    accounts = [{ id: 'cf-main', label: input.label, platform: 'codeforces', handle: input.handle, pool: 'default', transport: 'cookie', credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', backend: 'file', ready: true, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' }];
    return route.fulfill({ status: 201, json: accounts[0] });
  });
  await page.route('**/api/push-targets', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { targets } });
    const input = route.request().postDataJSON();
    expect(input.secret).toBe('push-secret');
    targets = [{ id: 'local-hook', instance_id: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', label: input.label, url: input.url, approved_origin: 'https://hooks.example.com', enabled: true, events: input.events, auth_mode: 'bearer', credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', backend: 'file', credential_available: true, timeout_ms: 10000, max_retries: 3, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' }];
    return route.fulfill({ status: 201, json: targets[0] });
  });
  await page.route('**/api/push-deliveries?*', route => route.fulfill({ json: { deliveries: [] } }));
  await page.goto('/providers');
  await page.getByRole('tab', { name: 'OJ 账号池' }).click();
  await page.getByRole('button', { name: '登记第一个账号' }).click();
  await page.getByLabel('显示名称').fill('CF Main');
  await page.getByLabel('Handle').fill('cf_handle');
  await page.getByLabel('Cookie / Session', { exact: true }).fill('oj-cookie-secret');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByText('CF Main', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('oj-cookie-secret');
  await page.getByRole('tab', { name: 'Push Targets' }).click();
  await page.getByRole('button', { name: '创建第一个 Target' }).click();
  await page.getByLabel('显示名称').fill('Local Hook');
  await page.getByLabel('Webhook URL').fill('https://hooks.example.com/contestreplay');
  await page.getByRole('combobox', { name: '认证方式' }).click();
  await page.getByRole('option', { name: 'Bearer Token' }).click();
  await page.getByLabel('Webhook Secret', { exact: true }).fill('push-secret');
  await page.getByRole('button', { name: '创建 Target', exact: true }).click();
  await expect(page.getByText('Local Hook', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('push-secret');
});

test('does not leak cancelled rotation secrets across OJ accounts or Push Targets', async ({ page }) => {
  const accounts = [
    { id: 'cf-a', label: 'CF A', platform: 'codeforces', handle: 'bot_a', pool: 'default', transport: 'cookie', credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', backend: 'file', ready: true, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' },
    { id: 'cf-b', label: 'CF B', platform: 'codeforces', handle: 'bot_b', pool: 'default', transport: 'cookie', credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', backend: 'file', ready: true, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' },
  ];
  const targets = [
    { id: 'hook-a', instance_id: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', label: 'Hook A', url: 'https://a.example.com/hook', approved_origin: 'https://a.example.com', enabled: true, events: ['run.completed'], auth_mode: 'bearer', credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', backend: 'file', credential_available: true, timeout_ms: 10000, max_retries: 3, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' },
    { id: 'hook-b', instance_id: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', label: 'Hook B', url: 'https://b.example.com/hook', approved_origin: 'https://b.example.com', enabled: true, events: ['run.completed'], auth_mode: 'bearer', credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', backend: 'file', credential_available: true, timeout_ms: 10000, max_retries: 3, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' },
  ];
  await page.route('**/api/providers', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/oj-accounts', route => route.fulfill({ json: { accounts } }));
  await page.route('**/api/push-targets', route => route.fulfill({ json: { targets } }));
  await page.route('**/api/push-deliveries?*', route => route.fulfill({ json: { deliveries: [] } }));

  await page.goto('/providers');
  await page.getByRole('tab', { name: 'OJ 账号池' }).click();
  await page.getByRole('button', { name: '轮换 OJ 账号 CF A', exact: true }).click();
  await page.getByLabel('新 Cookie / Session', { exact: true }).fill('secret-for-cf-a');
  await page.getByRole('button', { name: '显示秘密' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '轮换 OJ 账号 CF B', exact: true }).click();
  const ojInput = page.getByLabel('新 Cookie / Session', { exact: true });
  await expect(ojInput).toHaveValue('');
  await expect(ojInput).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByRole('tab', { name: 'Push Targets' }).click();
  await page.getByRole('button', { name: '轮换 Push Target Hook A', exact: true }).click();
  await page.getByLabel('新 Webhook Secret', { exact: true }).fill('secret-for-hook-a');
  await page.getByRole('button', { name: '显示秘密' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '轮换 Push Target Hook B', exact: true }).click();
  const hookInput = page.getByLabel('新 Webhook Secret', { exact: true });
  await expect(hookInput).toHaveValue('');
  await expect(hookInput).toHaveAttribute('type', 'password');
});
