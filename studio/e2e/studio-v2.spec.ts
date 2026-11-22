import { test, expect } from '@playwright/test';

const runA = '11111111-1111-4111-8111-111111111111';
const runB = '22222222-2222-4222-8222-222222222222';
const batchId = '8bd084e4-96b2-4b4b-8d8d-985c17b84c46';
const digest = 'a'.repeat(64);

const progress = {
  run_id: runA, status: 'running', agent_id: 'agent-a', agent_name: 'Agent A', contest_id: 'demo', contest_title: 'Demo Final', data_version: 1,
  scoring_mode: 'icpc', started_at: '2025-01-01T08:00:00.000Z', elapsed_ms: 125000, time_limit_ms: 7200000, remaining_ms: 7075000,
  submissions_used: 3, max_submissions: 100, model_turns: 4, last_activity_ms: 124000, last_activity_type: 'submission_judged', score: 1, max_score: 2,
  solved_count: 1, problem_count: 2,
  problems: [
    { id: 'A', max_points: 1, attempts: 1, status: 'accepted', best_score: 1, first_ac_ms: 60000, last_verdict: 'AC', last_elapsed_ms: 60000 },
    { id: 'B', max_points: 1, attempts: 2, status: 'wrong', best_score: 0, last_verdict: 'WA', last_elapsed_ms: 124000 },
  ],
  recent_activity: [{ seq: 4, elapsed_ms: 124000, type: 'submission_judged', summary: 'B 判定 WA', problem_id: 'B', verdict: 'WA', score: 0 }],
  telemetry: { model_turns: 4, total_model_wait_ms: 40000, total_input_tokens: 1200, total_output_tokens: 500 },
};

const replay = {
  run_id: runA, status: 'completed', agent_id: 'agent-a', agent_name: 'Agent A', contest_id: 'demo', contest_title: 'Demo Final', data_version: 1,
  contest_revision: digest, protocol_id: 'short', protocol_version: 1, protocol_sha256: digest, scoring_mode: 'icpc', started_at: '2025-01-01T08:00:00.000Z',
  time_limit_ms: 7200000, duration_ms: 125000, problems: [{ id: 'A', max_points: 1 }, { id: 'B', max_points: 1 }],
  submissions: [
    { submission_id: 's1', problem_id: 'A', received_ms: 55000, judged_ms: 60000, verdict: 'AC', score: 1, max_points: 1, language: 'cpp17' },
    { submission_id: 's2', problem_id: 'A', received_ms: 80000, judged_ms: 90000, verdict: 'already_accepted', score: 0, max_points: 1, language: 'cpp17' },
  ],
  frames: [
    { seq: 0, elapsed_ms: 0, kind: 'run_started', summary: '运行开始', cumulative_score: 0, solved_count: 0 },
    { seq: 1, elapsed_ms: 55000, kind: 'submission_received', summary: '提交 A', problem_id: 'A', submission_id: 's1', language: 'cpp17', cumulative_score: 0, solved_count: 0 },
    { seq: 2, elapsed_ms: 60000, kind: 'submission_judged', summary: 'A 判定 AC', problem_id: 'A', submission_id: 's1', verdict: 'AC', score: 1, cumulative_score: 1, solved_count: 1 },
    { seq: 3, elapsed_ms: 90000, kind: 'submission_judged', summary: 'A 重复提交', problem_id: 'A', submission_id: 's2', verdict: 'already_accepted', score: 0, cumulative_score: 1, solved_count: 1 },
    { seq: 4, elapsed_ms: 125000, kind: 'run_ended', summary: '有效完赛', status: 'completed', cumulative_score: 1, solved_count: 1 },
  ],
  telemetry: progress.telemetry,
  session_summaries: [{ file: 'session.jsonl', entries: [{ index: 0, role: 'assistant', summary: '分析题目 A' }], truncated: false }],
};

function rankedEntry(runId: string, agentId: string, rank: number) {
  return {
    rank,
    result: {
      run_id: runId, contest_id: 'demo', contest_title: 'Demo Final', data_version: 1, contest_revision: digest,
      protocol_id: 'short', protocol_version: 1, protocol_sha256: digest, protocol_preset: 'short', scoring_mode: 'icpc', points_known: true,
      agent_id: agentId, agent_name: `Agent ${agentId.at(-1)!.toUpperCase()}`, agent_revision: digest,
      harness: { kind: 'codex', version: '0.170.0' },
      model: { requested: 'gpt-test', observed: ['gpt-test'], vendor: 'openai', reasoning_effort: 'high', speed_tier: 'standard' },
      score: rank === 1 ? 2 : 1, max_score: 2,
      telemetry: { model_turns: 5, model_wait_ms: 40000, total_input_tokens: 1200, total_output_tokens: 500, wall_ms: 125000 },
      submissions: [],
    },
    finish_ms: 125000,
    scoring: { mode: 'icpc', primary: rank === 1 ? 2 : 1, secondary: rank === 1 ? 20 : 40, solved: rank === 1 ? 2 : 1, penalty_minutes: rank === 1 ? 20 : 40, tie_break_ms: 60000, last_ac_ms: 60000, per_problem: {} },
  };
}

const standing = (runId: string, agentId: string, score: number, rank: number) => ({
  rank, status: 'completed', provisional: false, unranked: false, run_id: runId, agent_id: agentId, agent_name: `Agent ${agentId.at(-1)!.toUpperCase()}`,
  score, max_score: 2, solved_count: score, penalty: score * 20, penalty_ms: 60000, last_ac_ms: 60000, submissions_used: 2, finished: true,
  problems: [{ id: 'A', status: 'accepted', attempts: 1, wrong_attempts: 0, score: 1, max_points: 1, first_ac_ms: 60000 }, { id: 'B', status: score === 2 ? 'accepted' : 'wrong', attempts: 1, wrong_attempts: score === 2 ? 0 : 1, score: score === 2 ? 1 : 0, max_points: 1, ...(score === 2 ? { first_ac_ms: 90000 } : {}) }],
});
const participant = (runId: string, agentId: string, score: number) => ({ run_id: runId, agent_id: agentId, agent_name: `Agent ${agentId.at(-1)!.toUpperCase()}`, status: 'completed', time_limit_ms: 7200000, duration_ms: 125000, final_score: score, final_solved_count: score, final_penalty: score * 20, submissions: [] });
const race = {
  contest_id: 'demo', contest_title: 'Demo Final', data_version: 1, contest_revision: digest, protocol_id: 'short', protocol_version: 1, protocol_sha256: digest,
  time_limit_ms: 7200000, timeline_end_ms: 125000, scoring_mode: 'icpc', problems: [{ id: 'A', max_points: 1 }, { id: 'B', max_points: 1 }],
  participants: [participant(runA, 'agent-a', 2), participant(runB, 'agent-b', 1)],
  milestones: [{ elapsed_ms: 60000, run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A', seq: 2, kind: 'submission_judged', problem_id: 'A', verdict: 'AC', score: 1, summary: 'Agent A 通过 A' }],
  samples: [
    { at_elapsed_ms: 0, scoring_mode: 'icpc', standings: [standing(runA, 'agent-a', 0, 1), standing(runB, 'agent-b', 0, 1)] },
    { at_elapsed_ms: 125000, scoring_mode: 'icpc', standings: [standing(runA, 'agent-a', 2, 1), standing(runB, 'agent-b', 1, 2)] },
  ],
};

test('shows live progress, incremental logs and a scrubbable replay', async ({ page }) => {
  await page.route('**/api/batches', route => route.fulfill({ json: { busy: true, error: null, batches: [{ id: batchId, created_at: '2025-01-01T08:00:00.000Z', concurrency: 2, jobs: [{ status: 'running', run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A', agent_revision: digest, contest_id: 'demo', data_version: 1, harness: 'codex' }] }] } }));
  await page.route(`**/api/runs/${runA}/progress`, route => route.fulfill({ json: progress }));
  await page.route(`**/api/runs/${runA}/events`, route => route.abort());
  await page.route(`**/api/runs/${runA}/logs?*`, route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    const chunk = offset === 0 ? 'first line\n' : 'second line\n';
    return route.fulfill({ json: { stream: 'stdout', offset, next_offset: offset + chunk.length, total_bytes: 24, has_more: offset === 0, chunk } });
  });
  await page.route(`**/api/runs/${runA}/replay?*`, route => route.fulfill({ json: replay }));
  await page.goto(`/runs/${runA}`);
  await expect(page.getByText('Agent A', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '赛时进度' })).toBeVisible();
  await expect(page.getByText('1 / 2', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('B 判定 WA')).toBeVisible();
  await page.getByRole('tab', { name: '原始日志' }).click();
  await expect(page.getByText('first line second line')).toBeVisible();
  await page.getByRole('tab', { name: '时间轴回放' }).click();
  await expect(page.getByText('帧详情')).toBeVisible();
  await page.getByRole('button', { name: '跳到终态' }).click();
  await expect(page.getByText('accepted', { exact: true })).toBeVisible();
  await expect(page.getByText('AC 00:55')).toBeVisible();
  // Clicking an earlier event in 事件序列 syncs cursor and projected status/score
  await page.getByRole('button', { name: /#1 · submission received/ }).click();
  await expect(page.getByText('pending', { exact: true })).toBeVisible();
  await expect(page.getByText('Session 留存')).toBeVisible();
});

test('treats terminal SSE status as authoritative when progress GET still says running and resets log offsets on stream switch', async ({ page }) => {
  const stderrOffsets: number[] = [];
  let stdoutPhase = 0;
  await page.route('**/api/batches', route => route.fulfill({ json: {
    busy: true, error: null,
    batches: [{ id: batchId, created_at: '2025-01-01T08:00:00.000Z', concurrency: 1, jobs: [{ status: 'running', run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A', agent_revision: digest, contest_id: 'demo', data_version: 1, harness: 'codex' }] }],
  } }));
  // Follow-up GET still reports status: 'running' even after SSE sends terminal status: 'interrupted'
  await page.route(`**/api/runs/${runA}/progress`, route => route.fulfill({ json: progress }));
  await page.route(`**/api/runs/${runA}/events`, route => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    body: `event: progress\ndata: ${JSON.stringify(progress)}\n\nevent: status\ndata: ${JSON.stringify({ run_id: runA, status: 'interrupted', reason: 'cancelled' })}\n\n`,
  }));
  await page.route(`**/api/runs/${runA}/logs?*`, route => {
    const url = new URL(route.request().url());
    const stream = url.searchParams.get('stream');
    const offset = Number(url.searchParams.get('offset'));
    if (stream === 'stderr') {
      stderrOffsets.push(offset);
      const chunk = offset === 0 ? 'err start\n' : '';
      return route.fulfill({ json: { stream: 'stderr', offset, next_offset: offset + chunk.length, total_bytes: 10, has_more: false, chunk } });
    }
    if (offset === 0) {
      const chunk = 'stdout-0123456789\n';
      return route.fulfill({ json: { stream: 'stdout', offset: 0, next_offset: chunk.length, total_bytes: chunk.length, has_more: false, chunk } });
    }
    if (stdoutPhase === 0) {
      stdoutPhase = 1;
      const chunk = 'tail-after-interrupt\n';
      return route.fulfill({ json: { stream: 'stdout', offset, next_offset: offset + chunk.length, total_bytes: offset + chunk.length, has_more: false, chunk } });
    }
    return route.fulfill({ json: { stream: 'stdout', offset, next_offset: offset, total_bytes: offset, has_more: false, chunk: '' } });
  });

  await page.goto(`/runs/${runA}`);
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止任务' })).toHaveCount(0);

  await page.getByRole('tab', { name: '原始日志' }).click();
  await expect(page.getByText('stdout-0123456789 tail-after-interrupt')).toBeVisible();
  await page.getByRole('tab', { name: 'stderr' }).click();
  await expect(page.getByText('err start')).toBeVisible();
  // Switching from stdout (offset > 0) to stderr must start stderr from offset 0, never stdout's offset
  expect(stderrOffsets[0]).toBe(0);
  await page.getByRole('tab', { name: 'stdout' }).click();
  await expect(page.getByText('stdout-0123456789')).toBeVisible();
});

test('keeps terminal SSE progress against slower GET and stops polling', async ({ page }) => {
  let progressGets = 0;
  const terminalProgress = { ...progress, status: 'completed', score: 2, solved_count: 2 };
  await page.route('**/api/batches', route => route.fulfill({ json: {
    busy: true, error: null,
    batches: [{ id: batchId, created_at: '2025-01-01T08:00:00.000Z', concurrency: 1, jobs: [{ status: 'running', run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A', agent_revision: digest, contest_id: 'demo', data_version: 1, harness: 'codex' }] }],
  } }));
  await page.route(`**/api/runs/${runA}/progress`, async route => {
    progressGets += 1;
    // Delay the first running GET so the terminal SSE event lands first.
    await new Promise(resolve => setTimeout(resolve, 250));
    return route.fulfill({ json: progress });
  });
  await page.route(`**/api/runs/${runA}/events`, route => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    body: `event: progress\ndata: ${JSON.stringify(terminalProgress)}\n\n`,
  }));

  await page.goto(`/runs/${runA}`);
  await expect(page.getByText('运行已结束')).toBeVisible();
  await expect(page.getByText('已完赛', { exact: true })).toBeVisible();
  await expect(page.getByText('运行中', { exact: true })).toHaveCount(0);
  await expect(page.getByText('2 / 2', { exact: true }).first()).toBeVisible();
  // Wait past the delayed GET to ensure it never rolls back the terminal SSE snapshot.
  await page.waitForTimeout(450);
  await expect(page.getByText('2 / 2', { exact: true }).first()).toBeVisible();
  expect(progressGets).toBeLessThanOrEqual(1);
});

test('drains final log bytes appended between last live poll and completion', async ({ page }) => {
  let runStatus: 'running' | 'completed' = 'running';
  let sawEmptyLiveSlice = false;
  await page.route('**/api/batches', route => route.fulfill({ json: {
    busy: runStatus === 'running', error: null,
    batches: [{ id: batchId, created_at: '2025-01-01T08:00:00.000Z', concurrency: 1, jobs: [{ status: runStatus, run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A', agent_revision: digest, contest_id: 'demo', data_version: 1, harness: 'codex' }] }],
  } }));
  await page.route(`**/api/runs/${runA}/progress`, route => route.fulfill({ json: runStatus === 'completed' ? { ...progress, status: 'completed' } : progress }));
  await page.route(`**/api/runs/${runA}/events`, route => route.abort());
  await page.route(`**/api/runs/${runA}/logs?*`, route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    if (offset === 0) {
      const chunk = 'live line\n';
      return route.fulfill({ json: { stream: 'stdout', offset: 0, next_offset: chunk.length, total_bytes: chunk.length, has_more: false, chunk } });
    }
    if (!sawEmptyLiveSlice) {
      sawEmptyLiveSlice = true;
      runStatus = 'completed';
      return route.fulfill({ json: { stream: 'stdout', offset, next_offset: offset, total_bytes: offset, has_more: false, chunk: '' } });
    }
    if (offset === 10) {
      const chunk = 'final line\n';
      return route.fulfill({ json: { stream: 'stdout', offset, next_offset: offset + chunk.length, total_bytes: offset + chunk.length, has_more: false, chunk } });
    }
    return route.fulfill({ json: { stream: 'stdout', offset, next_offset: offset, total_bytes: offset, has_more: false, chunk: '' } });
  });

  await page.goto(`/runs/${runA}`);
  await page.getByRole('tab', { name: '原始日志' }).click();
  await expect(page.getByText('live line final line')).toBeVisible();
});

test('ranks results, starts Ghost Racing and reads coverage', async ({ page }) => {
  await page.route('**/api/results/ranked?*', route => route.fulfill({ json: { scoring_mode: null, group_by: 'revision', groups: [[rankedEntry(runA, 'agent-a', 1), rankedEntry(runB, 'agent-b', 2)]], omitted_runs: [] } }));
  await page.route('**/api/runs/race', route => {
    expect(route.request().postDataJSON().run_ids).toEqual([runA, runB]);
    return route.fulfill({ json: race });
  });
  await page.route('**/api/coverage', route => route.fulfill({ json: { cells: [{ agent_id: 'agent-a', agent_revision: digest, contest_id: 'demo', data_version: 1, completed_count: 1, void_count: 0, latest_status: 'completed', latest_run_id: runA, best_score: 2, max_score: 2 }] } }));
  await page.goto('/results');
  await expect(page.getByText('Demo Final', { exact: true }).first()).toBeVisible();
  await page.getByRole('checkbox', { name: '加入竞速 Agent A', exact: true }).click();
  await page.getByRole('checkbox', { name: '加入竞速 Agent B', exact: true }).click();
  await page.getByRole('button', { name: '开始 Ghost Racing' }).click();
  await expect(page.getByText('Score trajectories')).toBeVisible();
  await page.getByRole('button', { name: '竞速回到起点' }).click();
  await expect(page.getByText('SAMPLE')).toBeVisible();
  await expect(page.getByText('Agent A 通过 A')).toHaveCount(0);
  await page.getByRole('slider', { name: '竞速时间轴' }).focus();
  await page.getByRole('slider', { name: '竞速时间轴' }).press('End');
  await expect(page.getByText('Agent A 通过 A')).toBeVisible();
  await page.getByRole('tab', { name: '覆盖率' }).click();
  await expect(page.getByText('执行覆盖档案')).toBeVisible();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
});

test('plans repeated cells with parallel workers and preflight', async ({ page }) => {
  const agent = { id: 'agent-a', path: 'agents/agent-a.toml', model: 'gpt-test', harness: 'codex', provider_available: true, valid: true, issues: [] };
  const contest = { id: 'demo', path: 'contests/demo.json', title: 'Demo Final', data_version: 1, judge_kind: 'local', problem_count: 2, time_limit_ms: 900000, valid: true, issues: [] };
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: [agent] } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [contest] } }));
  await page.route('**/api/matrix', route => route.fulfill({ json: { cells: [{ agent: agent.path, contest: contest.path, compatible: true }] } }));
  let planned: any;
  await page.route('**/api/plan', route => {
    planned = route.request().postDataJSON();
    return route.fulfill({ json: { token: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', jobs: [1, 2].map(index => ({ agent_id: 'agent-a', agent_revision: digest, contest_id: 'demo', data_version: 1, repeat_index: index, repeat_total: 2 })) } });
  });
  let preflightPayload: any;
  await page.route('**/api/preflight', route => {
    preflightPayload = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, checked_at: '2025-01-01T08:00:00.000Z', images: [], agents: [{ path: agent.path, id: agent.id, harness: 'codex', ok: true, credential_ok: true, issues: [] }], contests: [{ path: contest.path, id: contest.id, judge_kind: 'local', ok: true, oj_ready: true, issues: [] }], compatibility: [{ agent: agent.path, contest: contest.path, compatible: true }] } });
  });
  let launched: any;
  await page.route('**/api/batches', route => {
    if (route.request().method() === 'POST') { launched = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { id: batchId } }); }
    return route.continue();
  });
  await page.goto('/batches/new');
  await page.getByRole('checkbox', { name: /agent-a/ }).click();
  await page.getByRole('checkbox', { name: /Demo Final/ }).click();
  await page.getByRole('button', { name: '调整矩阵', exact: true }).click();
  await page.getByRole('combobox', { name: '每格重复' }).click();
  await page.getByRole('option', { name: '2 次' }).click();
  await expect(page.getByText('1 Cells · 2 个任务')).toBeVisible();
  await page.getByRole('button', { name: '核对执行计划' }).click();
  expect(planned.cells[0].repeats).toBe(2);
  await page.getByRole('combobox', { name: '执行并发' }).click();
  await page.getByRole('option', { name: '4 路并行' }).click();
  await page.getByRole('button', { name: '运行 Preflight' }).click();
  await expect(page.getByText('Preflight 全部通过')).toBeVisible();
  expect(preflightPayload).toEqual({ cells: [{ agent: agent.path, contest: contest.path }] });
  await page.getByRole('button', { name: '确认并启动批次' }).click();
  expect(launched.concurrency).toBe(4);
});

test('prunes deleted and invalid configs from sessionStorage batch draft before calling matrix', async ({ page }) => {
  const validAgent = { id: 'agent-live', path: 'agents/agent-live.toml', model: 'gpt-test', harness: 'codex', provider_available: true, valid: true, issues: [] };
  const invalidAgent = { id: 'agent-broken', path: 'agents/agent-broken.toml', model: 'gpt-test', harness: 'codex', provider_available: false, valid: false, issues: ['broken'] };
  const validContest = { id: 'demo', path: 'contests/demo.json', title: 'Demo Final', data_version: 1, judge_kind: 'local', problem_count: 2, time_limit_ms: 900000, valid: true, issues: [] };
  await page.route('**/api/catalog/agents', route => route.fulfill({ json: { agents: [validAgent, invalidAgent] } }));
  await page.route('**/api/catalog/contests', route => route.fulfill({ json: { contests: [validContest] } }));
  let matrixReq: any;
  await page.route('**/api/matrix', route => {
    matrixReq = route.request().postDataJSON();
    return route.fulfill({ json: { cells: [{ agent: validAgent.path, contest: validContest.path, compatible: true }] } });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('cr.batch.draft', JSON.stringify({
      agents: ['agents/deleted.toml', 'agents/agent-broken.toml', 'agents/agent-live.toml'],
      contests: ['contests/deleted.json', 'contests/demo.json'],
      cells: [
        JSON.stringify(['agents/deleted.toml', 'contests/deleted.json']),
        JSON.stringify(['agents/agent-live.toml', 'contests/demo.json']),
      ],
    }));
  });
  await page.goto('/batches/new');
  await expect(page.getByText('1 Agents · 1 Contests')).toBeVisible();
  await page.getByRole('button', { name: '调整矩阵', exact: true }).click();
  await expect(page.getByText('1 个任务', { exact: true })).toBeVisible();
  expect(matrixReq).toEqual({ agents: ['agents/agent-live.toml'], contests: ['contests/demo.json'] });
});
