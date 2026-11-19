import { parse } from 'parse5';

const origin = 'https://codeforces.com';
type Element = { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: Element[]; value?: string };
function walk(root: Element): Element[] {
  return [root, ...(root.childNodes ?? []).flatMap(walk)];
}
const attr = (node: Element, name: string) => node.attrs?.find(a => a.name === name)?.value;
const text = (node: Element): string => (node.value ?? '') + (node.childNodes ?? []).map(text).join('');
function html(value: string) { return walk(parse(value) as Element); }
export function cfForm(markup: string, contest: number, handle: string) {
  const nodes = html(markup);
  const profile = nodes.some(el => el.tagName === 'a' && attr(el, 'href')?.toLowerCase() === `/profile/${handle.toLowerCase()}` && text(el).trim().toLowerCase() === handle.toLowerCase());
  const form = nodes.find(el => el.tagName === 'form' && walk(el).some(input => attr(input, 'name') === 'submittedProblemIndex') &&
    walk(el).some(input => attr(input, 'name') === 'source'));
  if (!profile || !form) throw new Error('Codeforces did not return the signed-in submission form');
  const action = new URL(attr(form, 'action') || `/contest/${contest}/submit`, origin);
  if (action.origin !== origin || action.pathname !== `/contest/${contest}/submit`) throw new Error('Unexpected Codeforces form route');
  const fields = new URLSearchParams();
  for (const el of walk(form)) if (el.tagName === 'input' && attr(el, 'type') === 'hidden' && attr(el, 'name')) {
    fields.set(attr(el, 'name')!, attr(el, 'value') ?? '');
  }
  if (!fields.get('csrf_token')) throw new Error('Codeforces form has no CSRF token');
  return { action, fields };
}
export function cfReceipt(location: string | null, contest: number) {
  if (!location) return undefined;
  const url = new URL(location, origin);
  if (url.origin !== origin) return undefined;
  const value = Number(url.pathname.match(new RegExp(`^/contest/${contest}/submission/(\\d+)/?$`))?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
export async function submitCodeforcesWeb(input: { contest: number; problem: string; language: number; source: string; handle: string; cookie: string; signal: AbortSignal;
  beforePost: () => Promise<void>; correlate: () => Promise<number> }) {
  const { contest, problem, language, source, handle, cookie } = input;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  const url = `${origin}/contest/${contest}/submit`;
  const session = new Map(cookie.split(';').map(part => part.trim()).filter(part => part.includes('=')).map(part => {
    const i = part.indexOf('='); return [part.slice(0, i), part.slice(i + 1)];
  }));
  if (!session.size || /[\r\n]/.test(cookie)) throw new Error('Invalid Codeforces session cookie');
  const headers = () => ({ cookie: [...session].map(([k, v]) => `${k}=${v}`).join('; ') });
  const response = await fetch(url, { headers: headers(), redirect: 'manual', signal });
  if (!response.ok) throw new Error('Codeforces sign-in, challenge or submission form unavailable');
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';')[0]!; const i = pair.indexOf('=');
    if (i > 0) session.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const { action, fields } = cfForm(await response.text(), contest, handle);
  fields.set('action', 'submitSolutionFormSubmitted');
  fields.set('submittedProblemIndex', problem); fields.set('programTypeId', String(language));
  fields.set('contestId', String(contest)); fields.set('source', source); fields.set('tabSize', '4');
  await input.beforePost();
  const uploaded = await fetch(action, { method: 'POST', headers: { ...headers(), origin, referer: url }, body: fields, redirect: 'manual', signal });
  const location = uploaded.headers.get('location');
  const redirect = location && uploaded.status >= 300 && uploaded.status < 400 ? new URL(location, origin) : undefined;
  const id = redirect ? cfReceipt(redirect.href, contest) : undefined;
  if (id) { await uploaded.body?.cancel(); return id; }
  const list = redirect?.origin === origin && redirect.pathname === `/contest/${contest}/my`;
  const confirmed = uploaded.ok && /submitted successfully/i.test(await uploaded.text());
  if (!uploaded.ok) await uploaded.body?.cancel();
  if (list || confirmed) return input.correlate();
  throw new Error('Codeforces did not confirm submission; it will not be retried');
}
