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
  await page.route('**/api/agents/variants', async route => {
    const body = route.request().postDataJSON();
    variantCalls.push(body);
    if (body.dry_run) await new Promise(resolve => setTimeout(resolve, 150));
    return route.fulfill({ status: body.dry_run ? 200 : 201, json: { dry_run: body.dry_run, variants: [variant] } });
  });
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
  // Choices are locked while Dry-run is in flight so Create can never submit a drifted matrix
  await expect(page.getByRole('checkbox', { name: 'effort high', exact: true })).toBeDisabled();
  await expect(page.getByText('agent-base-high', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /创建 1 个变体/ }).click();
  expect(variantCalls.map(call => call.dry_run)).toEqual([true, false]);
  expect(variantCalls[0].reasoning_efforts).toEqual(['high']);
  expect(variantCalls[1].reasoning_efforts).toEqual(variantCalls[0].reasoning_efforts);
  expect(variantCalls[1].speed_tiers).toEqual(variantCalls[0].speed_tiers);
});

test('preserves external native_config, shows legacy Agent read-only, and clears editor on delete', async ({ page }) => {
  await mockShell(page);
  const legacyAgent = { id: 'demo-codex', path: 'examples/demo/codex.toml', model: 'gpt-5.3-codex', harness: 'codex', provider_available: true, valid: true, issues: [] };
  let agentCatalog = [baseAgent, legacyAgent];
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: agentCatalog } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [] } }));
  const nativeOverride = { format: 'toml', path: 'override.toml', sha256: digest };
  let currentExtDoc: any = {
    kind: 'contestreplay.dev/agent', schema_version: 1, id: 'agent-base', name: 'Base Agent', vendor: 'openai', provider: 'demo', model: 'gpt-test',
    harness: { kind: 'codex', version: '0.170.0', options: { reasoning_effort: 'high' }, native_config: nativeOverride },
  };
  const legacyDoc = { id: 'demo-codex', harness: 'codex', api: 'responses', model: 'gpt-5.3-codex', reasoning_effort: 'medium', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY' };
  let failNextAgentReload = false;
  let delayNextAgentReload = false;
  await page.route('**/api/agents/item?*', async route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (route.request().method() === 'DELETE') {
      agentCatalog = agentCatalog.filter(item => item.path !== path);
      return route.fulfill({ json: { deleted: true, path } });
    }
    if (path === legacyAgent.path) {
      return route.fulfill({ json: { path: legacyAgent.path, format: 'toml', document: legacyDoc, valid: true, issues: [], id: 'demo-codex', model: 'gpt-5.3-codex', harness: 'codex' } });
    }
    if (delayNextAgentReload) {
      delayNextAgentReload = false;
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    if (failNextAgentReload) {
      failNextAgentReload = false;
      return route.fulfill({ status: 500, json: { error: 'reload failed' } });
    }
    return route.fulfill({ json: { path: baseAgent.path, format: 'toml', document: currentExtDoc, valid: true, issues: [], id: 'agent-base', name: currentExtDoc.name, model: 'gpt-test', vendor: 'openai', harness: 'codex', provider: 'demo', speed_tier: 'standard' } });
  });
  let previewReq: any;
  await page.route('**/api/agents/preview', route => {
    previewReq = route.request().postDataJSON();
    return route.fulfill({ json: { format: 'toml', content: 'model_verbosity = "low"\n' } });
  });
  const updates: any[] = [];
  await page.route('**/api/agents/item', route => {
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON();
      updates.push(payload);
      currentExtDoc = payload.document;
      return route.fulfill({ json: { path: baseAgent.path } });
    }
    return route.continue();
  });

  await page.goto('/configs');
  // Legacy Agent renders read-only without a Save button
  await page.getByRole('button', { name: '编辑 demo-codex', exact: true }).click();
  await expect(page.getByText(/此配置使用旧版 Agent 格式/)).toBeVisible();
  await expect(page.getByText('OPENAI_API_KEY', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存修改' })).toHaveCount(0);

  // External native_config { path, sha256, format } is preserved on name-only save and preview sends file: initial.path
  await page.getByRole('button', { name: '编辑 agent-base', exact: true }).click();
  await page.getByRole('tab', { name: '最终预览' }).click();
  await page.getByRole('button', { name: '生成脱敏预览' }).click();
  await expect(page.getByText('model_verbosity = "low"')).toBeVisible();
  expect(previewReq.file).toBe(baseAgent.path);

  await page.getByLabel('展示名称').fill('Base Renamed');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  expect(updates[0].document.harness.native_config).toEqual(nativeOverride);
  expect(updates[0].document.model_family_id).toBeUndefined();

  // Removing external native_config awaits delayed baseline reload (keeping Save disabled)
  // Deleting an unrelated Agent (demo-codex) while agent-base reload is pending must NOT cancel agent-base's reload
  delayNextAgentReload = true;
  await page.getByRole('tab', { name: '原生覆盖' }).click();
  await page.getByLabel('移除已绑定的外部原生覆盖文件').check();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '删除 demo-codex', exact: true }).click();
  await page.getByRole('button', { name: '删除配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
  expect(updates[1].document.harness.native_config).toBeUndefined();
  await page.getByLabel(/TOML 参数覆盖/).fill('model_verbosity = "high"');
  await page.getByLabel(/TOML 参数覆盖/).fill('');
  failNextAgentReload = true;
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  expect(updates[2].document.harness.native_config).toBeUndefined();
  await expect(page.getByText(/刷新编辑器快照失败/)).toBeVisible();
  // Reload failure clears stale edit mode so user cannot save against an obsolete snapshot
  await expect(page.getByRole('tab', { name: '新建 Agent' })).toBeVisible();

  // Re-open and delete currently open Agent clears edit state back to "新建 Agent"
  await page.getByRole('button', { name: '编辑 agent-base', exact: true }).click();
  await page.getByRole('button', { name: '删除 agent-base', exact: true }).click();
  await page.getByRole('button', { name: '删除配置', exact: true }).click();
  await expect(page.getByRole('tab', { name: '新建 Agent' })).toBeVisible();
});

test('save-and-add-to-batch waits for catalog refetch and disables batch add on invalid configs', async ({ page }) => {
  await mockShell(page);
  const invalidAgent = { ...baseAgent, id: 'agent-bad', path: 'agents/agent-bad.toml', valid: false, issues: ['invalid model'] };
  const newAgent = { ...baseAgent, id: 'agent-fresh', name: 'Fresh Agent', path: 'agents/agent-fresh.toml' };
  let catalogAgents = [baseAgent, invalidAgent];
  let createdNew = false;
  await page.route('**/api/catalog/agents', async route => {
    if (createdNew) await new Promise(resolve => setTimeout(resolve, 150));
    return route.fulfill({ json: { agents: catalogAgents } });
  });
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [baseContest] } }));
  await page.route('**/api/agents', route => {
    createdNew = true;
    catalogAgents = [baseAgent, invalidAgent, newAgent];
    return route.fulfill({ status: 201, json: { path: newAgent.path } });
  });

  await page.goto('/configs');
  await expect(page.getByRole('button', { name: '将 agent-bad 加入批次', exact: true })).toBeDisabled();
  await page.getByLabel('Agent ID').fill('agent-fresh');
  await page.getByLabel('模型标识').fill('gpt-test');
  await page.getByRole('combobox', { name: 'Provider' }).click();
  await page.getByRole('option', { name: /Demo Provider/ }).click();
  await page.getByRole('button', { name: '保存并加入批次', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建评测批次' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Fresh Agent/ })).toHaveAttribute('aria-checked', 'true');

  // If the fresh catalog refetch marks a previously cached valid Agent invalid, pending must NOT select it
  let refetchCount = 0;
  await page.route('**/api/catalog/agents', async route => {
    refetchCount += 1;
    if (refetchCount >= 2) {
      await new Promise(resolve => setTimeout(resolve, 120));
      return route.fulfill({ json: { agents: [{ ...baseAgent, valid: false, issues: ['now invalid'] }] } });
    }
    return route.fulfill({ json: { agents: [baseAgent] } });
  });
  await page.goto('/configs');
  await expect(page.getByRole('button', { name: '将 agent-base 加入批次', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '将 agent-base 加入批次', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建评测批次' })).toBeVisible();
  await expect(page.getByText('0 Agents · 0 Contests')).toBeVisible();
});

test('merges partial remote preview mappings, carries points_known=false for incomplete CF weights, and renders Push Target load errors', async ({ page }) => {
  await mockShell(page);
  const existingCf = { id: 'cf-partial', path: 'contests/cf-partial.json', title: 'CF Partial', data_version: 1, judge_kind: 'codeforces', problem_count: 2, time_limit_ms: 900000, valid: true, issues: [] };
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [existingCf] } }));
  const cfDoc = {
    kind: 'contestreplay.dev/contest', schema_version: 2, contest_id: 'cf-partial', data_version: 1, title: 'CF Partial', source: { name: 'CF' },
    materials: { entrypoint: { kind: 'pdf', path: 'paper.pdf', sha256: digest, redistribution: 'restricted' }, attachments: [] },
    problems: [{ id: 'A', max_points: 1 }, { id: 'B', max_points: 1000 }],
    rules: { time_limit_ms: 7_200_000, max_submissions: 100 },
    judge: { kind: 'codeforces', contest_id: 1999, handle: 'cf_bot', languages: { cpp17: '54' }, problem_map: { A: 'C' } },
  };
  await page.route('**/api/contests/item?*', route => route.fulfill({ json: { path: existingCf.path, document: cfDoc, valid: true, issues: [], contest_id: 'cf-partial', contest_revision: digest, judge_kind: 'codeforces' } }));
  let previewReq: any;
  await page.route('**/api/contests/preview', route => {
    previewReq = route.request().postDataJSON();
    return route.fulfill({ json: {
      preview: {
        platform: 'codeforces', contest_ref: '1999', title: 'Codeforces 1999', status: 'finished',
        problems: [{ remote_id: 'A', title: 'Alpha', max_points: 500 }, { remote_id: 'C', title: 'Gamma', max_points: 500 }],
        suggested_languages: [],
      },
      language_presets: [{ id: 'cpp17', label: 'C++17', remote_id: '54' }],
      pdf_info: {
        path: 'contests/paper.pdf', size_bytes: 1024, sha256: digest, page_count: 2,
        problems: [{ id: 'A', title: 'Alpha' }, { id: 'B', title: 'Beta' }],
        problem_ids: ['A', 'B'], text_length: 100, text_truncated: false, extractor: 'fallback',
      },
      problem_map_suggestion: {
        problem_map: { A: 'A' }, confirmed_map: { A: 'A' }, suggested_map: {},
        matches: [{ local_id: 'A', remote_id: 'A', strategy: 'exact', confidence: 'exact' }],
        unmapped_local: ['B'], unmapped_remote: ['C'],
      },
    } });
  });
  let savedCf: any;
  await page.route('**/api/contests/item', route => {
    if (route.request().method() === 'PUT') { savedCf = route.request().postDataJSON(); return route.fulfill({ json: { path: existingCf.path } }); }
    return route.continue();
  });

  await page.goto('/configs');
  await page.getByRole('tab', { name: /Contests/ }).click();
  await page.getByRole('button', { name: '编辑 cf-partial', exact: true }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '拉取赛事信息' }).click();
  await expect(page.getByText(/未自动映射的本地题号/)).toBeVisible();
  // Saved weight A=1 does NOT match upstream C=500 -> points_known MUST remain false until user confirms
  await expect(page.getByText(/points_known = false/)).toBeVisible();
  expect(previewReq.manifest_path).toBe('contests/cf-partial.json');
  expect(previewReq.manifest_contest_id).toBe('cf-partial');
  expect(previewReq.pdf_path).toBe('paper.pdf');
  // Existing problem B must NOT be dropped, and explicit mapping A->C must NOT be overwritten by suggestion A->A
  await expect(page.getByLabel('远程题目 1 题号')).toHaveValue('A');
  await expect(page.getByLabel('远程题目 2 题号')).toHaveValue('B');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  expect(savedCf.document.problems).toEqual([{ id: 'A', max_points: 1 }, { id: 'B', max_points: 1000 }]);
  expect(savedCf.document.judge.problem_map).toEqual({ A: 'C' });
  expect(savedCf.document.judge.points_known).toBe(false);

  // Creating a fresh CF contest: preview verifies A=500, but editing A to 1 MUST drop points_known to false;
  // manual confirmation only binds the confirmed weights and invalidates on subsequent edits.
  let createdCf: any;
  await page.route('**/api/contests', route => { createdCf = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { path: 'contests/cf-new.json' } }); });
  await page.route('**/api/contests/preview', route => route.fulfill({ json: {
    preview: { platform: 'codeforces', contest_ref: '2000', title: 'Codeforces 2000', status: 'finished', problems: [{ remote_id: 'A', title: 'Alpha', max_points: 500 }], suggested_languages: [] },
    language_presets: [{ id: 'cpp17', label: 'C++17', remote_id: '54' }],
  } }));
  await page.getByRole('button', { name: '新建 Contest', exact: true }).click();
  await page.getByLabel('Contest ID').fill('cf-new');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('tab', { name: '引用本机路径' }).click();
  await page.getByLabel('题面 PDF').fill('contests/cf-new/problems.pdf');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('combobox', { name: '判题后端' }).click();
  await page.getByRole('option', { name: 'Codeforces', exact: true }).click();
  await page.getByLabel('Codeforces 赛事 ID').fill('2000');
  await page.getByLabel('专用账号名').fill('cf_bot');
  await page.getByRole('button', { name: '拉取赛事信息' }).click();
  await expect(page.getByLabel('远程题目 1 分值')).toHaveValue('500');
  // Override verified 500 with unverified 1 -> notice appears, points_known becomes false
  await page.getByLabel('远程题目 1 分值').fill('1');
  await expect(page.getByText(/points_known = false/)).toBeVisible();
  // Confirming binds to weight=1, then changing weight to 2 invalidates confirmation back to false
  await page.getByLabel(/我已手工核对并确认当前全部题目真实满分/).check();
  await expect(page.getByText(/如再修改题号或分值需重新确认/)).toBeVisible();
  await page.getByLabel('远程题目 1 分值').fill('2');
  await expect(page.getByText(/points_known = false/)).toBeVisible();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '仅保存', exact: true }).click();
  expect(createdCf.document.problems).toEqual([{ id: 'A', max_points: 2 }]);
  expect(createdCf.document.judge.points_known).toBe(false);

  // PushTargetsPanel surfaces load errors cleanly instead of empty state
  await page.route('**/api/push-targets', route => route.fulfill({ status: 500, json: { error: 'push store unavailable' } }));
  await page.route('**/api/push-deliveries?*', route => route.fulfill({ json: { deliveries: [] } }));
  await page.goto('/providers');
  await page.getByRole('tab', { name: 'Push Targets' }).click();
  await expect(page.getByText('无法读取 Push Targets')).toBeVisible();
  await expect(page.getByText('push store unavailable')).toBeVisible();
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
