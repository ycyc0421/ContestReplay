import { api, studioApi } from './api';
import { z } from 'zod';

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('validates successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: 42 }), { status: 200 })));
    await expect(api('/api/test', z.strictObject({ value: z.number() }))).resolves.toEqual({ value: 42 });
  });
  it('surfaces server error messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Preview the plan again' }), { status: 400 })));
    await expect(api('/api/test', z.unknown(), {})).rejects.toThrow('Preview the plan again');
  });
  it('adds the same-origin Studio header for writes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('null', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api('/api/test', z.null(), {});
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-CR-Studio': '1' });
  });
  it('sends only { cells } to /api/preflight without schema_version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, checked_at: '2025-01-01T00:00:00.000Z', images: [], agents: [], contests: [], compatibility: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await studioApi.preflight([{ agent: 'agents/a.toml', contest: 'contests/c.json' }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/preflight');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      cells: [{ agent: 'agents/a.toml', contest: 'contests/c.json' }],
    });
  });
  it('encodes resource IDs in URL path segments', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ deleted: true }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    await studioApi.deleteProvider('bad/id?x=1#frag%20');
    await studioApi.deleteOjAccount('oj/id?y=2');
    await studioApi.deletePushTarget('hook#1/2');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/providers/bad%2Fid%3Fx%3D1%23frag%2520',
      '/api/oj-accounts/oj%2Fid%3Fy%3D2',
      '/api/push-targets/hook%231%2F2',
    ]);
  });
  it('normalizes legacy /api/connections fallback to include backend and credential_available', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connections: [{
          id: 'legacy-1', label: 'Legacy', protocol: 'responses', base_url: 'https://api.openai.com/v1',
          credential_ref: 'a720a849-3c7d-4f35-a4bd-51ee0baf7f15', approved_origin: 'https://api.openai.com',
        }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await studioApi.providers();
    expect(result.providers[0]).toMatchObject({ id: 'legacy-1', backend: 'file', credential_available: true });
  });
});
