import { api } from './api';
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
});
