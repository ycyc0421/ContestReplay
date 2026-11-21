export const page = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ContestReplay Studio</title>
<style>
:root{color-scheme:light dark}body{font:15px/1.55 system-ui,sans-serif;max-width:1000px;margin:36px auto;padding:0 16px}h1,h2{line-height:1.2}section{border:1px solid GrayText;border-radius:8px;padding:16px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}label{display:block}textarea{display:block;box-sizing:border-box;width:100%;margin:4px 0}button{margin:4px 5px 4px 0}pre{overflow:auto;max-height:26rem;white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;text-align:left}td,th{border-bottom:1px solid GrayText;padding:5px;overflow-wrap:anywhere}details{margin-bottom:12px}code{overflow-wrap:anywhere}#notice{min-height:1.6em}summary{cursor:pointer}
</style>
<h1>ContestReplay Studio</h1><p>本机跑分控制台 · 不包含公开榜单</p>
<section><h2>创建配置</h2><div class="grid">
<details><summary>新建 Agent</summary><label>保存为 <input id="agent-file" placeholder="codex.toml"></label><label>ID <input id="agent-id"></label>
<label>Harness <select id="harness"><option value="codex">Codex</option><option value="builtin-responses">内置 Responses</option></select></label>
<label>模型 <input id="model" placeholder="gpt-5.3-codex"></label><label>模型族（可选） <input id="family"></label>
<label>API <select id="api"><option>responses</option></select></label><label>Base URL <input id="base-url" placeholder="https://api.openai.com/v1"></label>
<label>凭据环境变量名 <input id="key-env" placeholder="OPENAI_API_KEY"></label>
<label id="effort-label">推理强度 <select id="effort"><option value="">默认</option><option>none</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label>
<button id="save-agent">保存并加入批次</button></details>
<details><summary>新建 Contest</summary><label>保存为 <input id="contest-file" placeholder="contest.json"></label><label>ID <input id="contest-id"></label>
<label>PDF（相对于清单） <input id="pdf"></label><label>判题 <select id="judge"><option value="local">本地答案</option><option value="codeforces">Codeforces 导入</option></select></label>
<div id="local-fields"><label>答案 JSON（相对于清单） <input id="answers"></label><label>标题 <input id="contest-title"></label></div>
<div id="cf-fields" hidden><label>Codeforces 赛事 ID <input id="cf-id" type="number" min="1"></label><label>专用账号名 <input id="cf-handle"></label>
<label>语言映射 JSON <input id="cf-languages" placeholder='{ "cpp17": 54 }'></label></div><button id="save-contest">保存并加入批次</button></details>
</div></section>
<section><h2>准备批次</h2><p>每行一个配置文件路径。相对路径以启动 Studio 的目录为准。</p>
<div class="grid"><label>Agent 配置<textarea id="agents" rows="4" placeholder="examples/demo/agent.json"></textarea></label>
<label>Contest 配置<textarea id="contests" rows="4" placeholder="examples/demo/contest.json"></textarea></label></div>
<button id="preview">生成计划</button><button id="start" disabled>启动批次</button>
<div id="notice" role="status"></div><div id="plan"></div></section>
<section><h2>批次队列</h2><div id="batches"></div></section>
<section><h2>运行日志</h2><div id="run">从队列中选择一条运行。</div><div class="grid"><div><h3>stdout</h3><pre id="stdout"></pre></div><div><h3>stderr</h3><pre id="stderr"></pre></div></div></section>
<script src="/studio.js" defer></script></html>`;

export const browserCode = String.raw`
'use strict';
const $ = name => document.getElementById(name);
const node = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };
const button = (text, fn) => { const el = node('button', text); el.onclick = fn; return el; };
const notice = text => { $('notice').textContent = text; };
let token = null, busy = false, previewing = false, selected = null, previous = '';
async function api(path, payload) {
  const res = await fetch(path, payload === undefined ? undefined : { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-CR-Studio': '1',
  }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
function action(fn) { return async () => { try { await fn(); } catch (error) { notice(error.message); } }; }
function table(headers, rows) {
  const result = node('table'), head = result.createTHead().insertRow(), body = result.createTBody();
  headers.forEach(value => head.append(node('th', value)));
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) { const cell = tr.insertCell(); if (value instanceof Node) cell.append(value); else cell.textContent = value; }
  }
  return result;
}
const revision = job => job.agent_id + ' · ' + job.agent_revision.slice(0, 8);
const contest = job => job.contest_id + ' · v' + job.data_version;
function updateButtons() { $('start').disabled = !token || busy || previewing; $('preview').disabled = previewing; }
const fields = ['agents', 'contests'];
const readFields = () => Object.fromEntries(fields.map(key => [key, $(key).value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)]));
for (const key of fields) $(key).oninput = () => { token = null; $('plan').replaceChildren(); updateButtons(); };
const val = key => $(key).value.trim();
const addConfig = (axis, path) => { $(axis).value += ($(axis).value.trim() ? '\n' : '') + path; $(axis).oninput(); notice('已保存：' + path); };
$('harness').onchange = () => { $('effort-label').hidden = val('harness') !== 'codex'; };
$('judge').onchange = () => {
  const cf = val('judge') === 'codeforces'; $('cf-fields').hidden = !cf; $('local-fields').hidden = cf;
};
$('save-agent').onclick = action(async () => {
  const harness = val('harness');
  const data = await api('/api/config/agent', { file: val('agent-file'), config: { id: val('agent-id'), harness,
    api: val('api'), model: val('model'), model_family_id: val('family') || undefined, base_url: val('base-url') || undefined,
    api_key_env: val('key-env') || undefined, ...(harness === 'codex' && val('effort') ? { reasoning_effort: val('effort') } : {}) } });
  addConfig('agents', data.path);
});
$('save-contest').onclick = action(async () => {
  const id = val('contest-id'), pdf = val('pdf'), file = val('contest-file');
  const data = val('judge') === 'codeforces'
    ? await api('/api/config/codeforces', { file, config: { id, pdf, contest: Number(val('cf-id')), handle: val('cf-handle'), languages: JSON.parse(val('cf-languages')) } })
    : await api('/api/config/contest', { file, config: { schema_version: 2, contest_id: id, data_version: 1, title: val('contest-title') || id,
      source: { name: 'Local' }, materials: { entrypoint: { kind: 'pdf', path: pdf } }, judge: { kind: 'local', answers: { path: val('answers') } } } });
  addConfig('contests', data.path);
});
$('preview').onclick = action(async () => {
  previewing = true; token = null; updateButtons(); notice('正在校验配置…'); $('plan').replaceChildren();
  const values = readFields();
  try {
    const plan = await api('/api/plan', { schema_version: 1, ...values });
    if (JSON.stringify(values) !== JSON.stringify(readFields())) { notice('配置已变化，请重新生成计划。'); return; }
    token = plan.token;
    $('plan').append(table(['Agent', 'Contest'], plan.jobs.map(job => [revision(job), contest(job)])));
    notice('计划就绪：' + plan.jobs.length + ' 个任务。');
  } finally { previewing = false; updateButtons(); }
});
$('start').onclick = action(async () => {
  const approved = token;
  token = null; busy = true; updateButtons();
  try {
    const result = await api('/api/batches', { token: approved });
    notice('批次已创建：' + result.id);
  } finally { busy = false; updateButtons(); }
});
function render(data) {
  const key = JSON.stringify(data);
  if (previous === key) return;
  previous = key;
  const old = [...$('batches').querySelectorAll('details')];
  const open = new Set(old.filter(el => el.open).map(el => el.dataset.id));
  const known = new Set(old.map(el => el.dataset.id));
  $('batches').replaceChildren();
  if (data.error) $('batches').append(node('p', data.error));
  if (!data.batches.length) $('batches').append(node('p', '还没有批次。'));
  data.batches.forEach((batch, i) => {
    const details = node('details'); details.dataset.id = batch.id;
    details.open = open.has(batch.id) || (i === 0 && !known.has(batch.id));
    details.append(node('summary', batch.id + ' · ' + batch.jobs.filter(j => j.status === 'completed').length + '/' + batch.jobs.length + ' 完成'));
    const queued = batch.jobs.some(j => j.status === 'queued');
    if (queued || batch.jobs.some(j => j.status === 'running')) details.append(button('停止整个批次', action(async () => {
      await api('/api/batches/' + batch.id + '/stop', {}); notice('已请求停止批次。');
    })));
    if (queued && !data.busy) details.append(button('继续未启动任务', action(async () => {
      await api('/api/batches/' + batch.id + '/resume', {}); notice('已请求继续批次。');
    })));
    if (batch.jobs.some(j => j.status === 'completed')) { const link = node('a', '导出已完赛结果'); link.href = '/api/batches/' + batch.id + '/results'; details.append(link); }
    details.append(table(['Agent', 'Contest', '状态', '操作'], batch.jobs.map(job => {
      const controls = node('div');
      if (job.run_id) controls.append(button('查看日志', () => {
        selected = job.run_id; $('run').textContent = job.run_id; $('stdout').textContent = ''; $('stderr').textContent = '';
      }));
      if (job.status === 'running') controls.append(button('停止当前任务', action(async () => {
        await api('/api/runs/' + job.run_id + '/cancel', {}); notice('已请求停止任务。');
      })));
      return [revision(job), contest(job), job.status + (job.reason ? ' · ' + job.reason : ''), controls];
    })));
    $('batches').append(details);
  });
}
async function poll() {
  try {
    const data = await api('/api/batches'); busy = data.busy; updateButtons(); render(data);
    const run = selected;
    if (run) {
      const logs = await api('/api/runs/' + run + '/logs');
      if (run === selected) for (const key of ['stdout', 'stderr']) {
        const el = $(key);
        if (el.textContent !== logs[key]) {
          const atBottom = el.scrollTop + el.clientHeight + 8 >= el.scrollHeight;
          el.textContent = logs[key]; if (atBottom) el.scrollTop = el.scrollHeight;
        }
      }
    }
  } catch (error) { notice(error.message); }
  finally { setTimeout(poll, 700); }
}
void poll();
`;
