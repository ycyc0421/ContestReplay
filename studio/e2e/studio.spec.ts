import { test, expect } from '@playwright/test';

const batchId = '8bd084e4-96b2-4b4b-8d8d-985c17b84c46';
const token = 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15';
const nextCapabilities = {
  schema_version: 1,
  features: { agent_vendor: true, agent_manifests: true, connections: true, native_overrides: true, contest_authoring: true, contest_upload: true, judge_authoring: true },
  manifest_formats: ['toml', 'yaml', 'json'],
  harnesses: [{ id: 'codex', label: 'Codex', version: '0.170.0', native_format: 'toml', supports_overrides: true, fields: [{
    id: 'reasoning_effort', label: '推理强度', kind: 'select', required: false, default: 'default',
    options: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value === 'default' ? '使用模型默认值' : value })),
  }], environment: ['LANG', 'LC_ALL'].map(name => ({ name, options: [{ value: 'C', label: 'C' }, { value: 'C.UTF-8', label: 'C.UTF-8' }] })) }],
  judge_backends: [{ kind: 'local', label: '本地精确答案', supports_authoring: true }, { kind: 'codeforces', label: 'Codeforces', supports_authoring: false }],
};

test('loads the production app and completes a planned batch launch', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '运行总览' })).toBeVisible();
  await expect(page.getByText('赛道待命')).toBeVisible();
  await page.getByRole('link', { name: '新建批次', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '新建评测批次' })).toBeVisible();
  await page.getByRole('checkbox', { name: /demo-codex/ }).click();
  await page.getByRole('checkbox', { name: /cr-demo-final/ }).click();
  await page.getByRole('button', { name: '调整矩阵', exact: true }).click();
  await expect(page.getByRole('button', { name: /demo-codex ×/ })).toHaveAttribute('aria-pressed', 'true');
  await page.route('**/api/plan', route => route.fulfill({ json: { token, jobs: [{
    agent_id: 'codex-demo', agent_revision: 'a'.repeat(64), contest_id: 'demo', data_version: 1,
  }] } }));
  await page.route('**/api/batches', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 202, json: { id: batchId } }) : route.continue());
  await page.getByRole('button', { name: '核对执行计划' }).click();
  await expect(page.getByText(/执行计划 ·/)).toBeVisible();
  await expect(page.getByText('codex-demo')).toBeVisible();
  await page.getByRole('button', { name: '确认并启动批次' }).click();
  await expect(page.getByRole('heading', { name: '运行总览' })).toBeVisible();
  await expect(page.getByText('批次已启动', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('selects sparse cells and restores the matrix draft', async ({ page }) => {
  const agent = (id: string, vendor = 'openai') => ({ id, path: `agents/${id}.toml`, model: 'gpt-test', vendor, harness: 'codex', provider: 'demo', provider_available: true, valid: true, issues: [] });
  const contest = (id: string, title: string) => ({ id, path: `contests/${id}.json`, title, data_version: 1, judge_kind: 'local', problem_count: 2, time_limit_ms: 900000, valid: true, issues: [] });
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: [agent('agent-a'), agent('agent-b', 'anthropic')] } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [contest('contest-a', 'Contest A'), contest('contest-b', 'Contest B')] } }));
  await page.route('**/api/matrix', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { cells: body.agents.flatMap((a: string) => body.contests.map((c: string) => ({ agent: a, contest: c, compatible: true }))) } });
  });
  let planned: any;
  await page.route('**/api/plan', route => {
    planned = route.request().postDataJSON();
    return route.fulfill({ json: { token, jobs: planned.cells.map((cell: any) => ({ agent_id: cell.agent.split('/').at(-1), agent_revision: 'a'.repeat(64), contest_id: cell.contest.split('/').at(-1), data_version: 1 })) } });
  });
  await page.goto('/batches/new');
  await page.getByLabel('搜索 Agent').fill('agent-b');
  await expect(page.getByRole('checkbox', { name: /agent-b/ })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /agent-a/ })).toHaveCount(0);
  await page.getByLabel('搜索 Agent').fill('');
  await page.getByRole('button', { name: '筛选', exact: true }).first().click();
  await page.getByRole('combobox', { name: '模型厂商' }).click();
  await page.getByRole('option', { name: 'anthropic', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /agent-a/ })).toHaveCount(0);
  await page.getByRole('button', { name: '重置' }).click();
  await page.keyboard.press('Escape');
  await page.getByLabel('搜索 Contest').fill('Contest B');
  await expect(page.getByRole('checkbox', { name: /contest-a/ })).toHaveCount(0);
  await page.getByLabel('搜索 Contest').fill('');
  for (const name of ['agent-a', 'agent-b', 'contest-a']) await page.getByRole('checkbox', { name: new RegExp(name, 'i') }).click();
  await page.getByRole('checkbox', { name: /contest-b/ }).click();
  await page.getByRole('button', { name: '调整矩阵', exact: true }).click();
  await expect(page.getByText('4 个任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'agent-a × Contest B', exact: true }).click();
  await expect(page.getByText('3 个任务', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '调整矩阵', exact: true }).click();
  await expect(page.getByText('3 个任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核对执行计划' }).click();
  await expect(page.getByText('执行计划 · 3 个任务')).toBeVisible();
  expect(planned.schema_version).toBe(2);
  expect(planned.cells).toHaveLength(3);
});

test('keeps queue controls usable with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/batches', route => route.fulfill({ json: { busy: false, error: null, batches: [{
    id: batchId, created_at: '2025-01-01T08:00:00.000Z', jobs: [{
      status: 'completed', run_id: 'f2cb5714-c0f1-4bfa-8be3-7c4825750985', agent_id: 'codex-high',
      agent_revision: 'a'.repeat(64), contest_id: 'demo-final', data_version: 1, harness: 'codex',
    }],
  }] } }));
  await page.goto('/');
  await expect(page.getByText('codex-high')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '1 / 1 有效完赛' })).toBeVisible();
  await page.getByRole('button', { expanded: true }).click();
  await expect(page.getByText('codex-high')).not.toBeVisible();
});

test('supports configuration and theme navigation', async ({ page }) => {
  await page.goto('/configs');
  await expect(page.getByRole('heading', { name: '配置工具' })).toBeVisible();
  await page.getByRole('tab', { name: '新建 Contest' }).click();
  await page.getByLabel('Contest ID').fill('e2e-contest');
  await page.getByRole('button', { name: '继续' }).click();
  await page.getByRole('tab', { name: '引用本机路径' }).click();
  await page.getByLabel('题面 PDF').fill('examples/demo/problems.pdf');
  await page.getByRole('button', { name: '继续' }).click();
  await page.getByRole('combobox', { name: '判题后端' }).click();
  await page.getByRole('option', { name: 'Codeforces' }).click();
  await expect(page.getByLabel('Codeforces 赛事 ID')).toBeVisible();
  await page.getByRole('tab', { name: '新建 Agent' }).click();
  await expect(page.getByText('模型系列')).toHaveCount(0);
  await expect(page.getByText('LANG', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Manifest 格式')).toHaveCount(0);
  await page.getByRole('tab', { name: '新建 Contest' }).click();
  await expect(page.getByLabel('Codeforces 赛事 ID')).toBeVisible();
  await page.getByRole('button', { name: /基本信息/ }).click();
  await expect(page.getByLabel('Contest ID')).toHaveValue('e2e-contest');
  await page.getByRole('button', { name: '切换深色主题' }).click();
  await expect(page.locator('html')).toHaveClass('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveClass('dark');
});

test('uses backend capabilities for vendor, provider, max effort and native overrides', async ({ page }) => {
  await page.route('**/api/capabilities', route => route.fulfill({ json: nextCapabilities }));
  await page.route('**/api/providers', route => route.fulfill({ json: { providers: [{ id: 'demo', label: 'OpenAI 测试', protocol: 'responses', base_url: 'https://api.openai.com/v1', credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', approved_origin: 'https://api.openai.com' }] } }));
  let saved: any;
  await page.route('**/api/agents', route => { saved = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { path: '/tmp/anthropic.yaml' } }); });
  await page.goto('/configs');
  await page.getByLabel('Agent ID').fill('claude-max');
  await page.getByLabel('模型标识').fill('claude-sonnet-4-5');
  await page.getByRole('combobox', { name: 'Provider' }).click();
  await page.getByRole('option', { name: /OpenAI 测试/ }).click();
  await page.getByRole('combobox', { name: '模型厂商' }).click();
  await page.getByRole('option', { name: 'Anthropic' }).click();
  await page.getByRole('combobox', { name: '推理强度' }).click();
  await page.getByRole('option', { name: 'max', exact: true }).click();
  await page.getByRole('tab', { name: '原生覆盖' }).click();
  await page.getByLabel(/TOML 参数覆盖/).fill('model_verbosity = "high"');
  await page.getByRole('button', { name: '仅保存' }).click();
  await expect(page.getByText('Agent 配置已保存', { exact: true })).toBeVisible();
  expect(saved.file).toBeUndefined();
  expect(saved.format).toBeUndefined();
  expect(saved.document.vendor).toBe('anthropic');
  expect(saved.document.provider).toBe('demo');
  expect(saved.document.harness.options.reasoning_effort).toBe('max');
  expect(saved.document.harness.env).toBeUndefined();
  expect(saved.document.harness.native_config).toEqual({ format: 'toml', content: 'model_verbosity = "high"' });
});

test('uploads contest materials and authors local judge data', async ({ page }) => {
  await page.route('**/api/capabilities', route => route.fulfill({ json: nextCapabilities }));
  await page.route('**/api/contests/materials', route => route.fulfill({ status: 201, json: {
    path: 'contests/upload-demo/problems.pdf', name: 'paper.pdf', size: 1234, sha256: 'a'.repeat(64), kind: 'entrypoint',
  } }));
  let saved: any;
  await page.route('**/api/contests', route => { saved = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { path: '/tmp/upload-demo.json' } }); });
  await page.goto('/configs');
  await page.getByRole('tab', { name: '新建 Contest' }).click();
  await page.getByLabel('Contest ID').fill('upload-demo');
  await page.getByRole('button', { name: '继续' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-demo') });
  await expect(page.getByText('paper.pdf')).toBeVisible();
  await page.getByRole('button', { name: '继续' }).click();
  await page.getByLabel('题目 1 可接受答案').fill('3\nthree');
  await page.getByRole('button', { name: '继续' }).click();
  await page.getByRole('button', { name: '仅保存' }).click();
  await expect(page.getByText('/tmp/upload-demo.json', { exact: true })).toBeVisible();
  expect(saved.document.materials.entrypoint.path).toBe('contests/upload-demo/problems.pdf');
  expect(saved.document.judge.problems[0].accepted_answers).toEqual(['3', 'three']);
  expect(saved.document.rules).toEqual({ time_limit_ms: 900000, max_submissions: 100 });
});

test('creates, edits, rotates and deletes Providers without echoing secrets', async ({ page }) => {
  let providers: any[] = [];
  const publicProvider = { id: 'demo', label: 'OpenAI 测试', protocol: 'responses', base_url: 'https://api.openai.com/v1', credential_ref: token, approved_origin: 'https://api.openai.com' };
  await page.route('**/api/providers', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { providers } });
    const input = route.request().postDataJSON();
    expect(input.secret).toBe('fixture-secret');
    providers = [publicProvider];
    return route.fulfill({ status: 201, json: publicProvider });
  });
  await page.route('**/api/providers/demo', route => {
    if (route.request().method() === 'PATCH') { providers = [{ ...publicProvider, label: 'OpenAI 生产' }]; return route.fulfill({ json: providers[0] }); }
    providers = []; return route.fulfill({ json: { deleted: true } });
  });
  await page.route('**/api/providers/demo/rotate', route => {
    expect(route.request().postDataJSON().secret).toBe('rotated-secret');
    return route.fulfill({ json: publicProvider });
  });
  await page.goto('/providers');
  await page.getByRole('button', { name: '创建第一个 Provider' }).click();
  const dialogBox = await page.getByRole('dialog').boundingBox();
  expect(dialogBox!.x).toBeGreaterThan(400);
  expect(dialogBox!.y).toBeGreaterThan(0);
  await page.getByLabel('显示名称').fill('OpenAI 测试');
  await page.getByLabel('API Key', { exact: true }).fill('fixture-secret');
  await page.getByRole('button', { name: '创建 Provider', exact: true }).click();
  await expect(page.getByText('OpenAI 测试', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('fixture-secret');
  await page.getByRole('button', { name: '编辑 OpenAI 测试' }).click();
  await page.getByLabel('显示名称').fill('OpenAI 生产');
  await page.getByRole('button', { name: '保存修改' }).click();
  await page.getByRole('button', { name: '轮换 OpenAI 生产 凭据' }).click();
  await page.getByLabel('新 API Key').fill('rotated-secret');
  await page.getByRole('button', { name: '确认轮换' }).click();
  await expect(page.locator('body')).not.toContainText('rotated-secret');
  await page.getByRole('button', { name: '删除 OpenAI 生产' }).click();
  await page.getByRole('button', { name: '删除 Provider', exact: true }).click();
  await expect(page.getByText('尚未登记 Provider')).toBeVisible();
});
