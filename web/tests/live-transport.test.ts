import { afterEach, beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const jid = '44444444-4444-4444-8444-444444444444';

test('shared requests use the server identity and poll a job through the same origin', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ shared: true, profileId: 'p_abc' }))
    .mockResolvedValueOnce(json({ jobId: jid, statusUrl: 'https://untrusted.invalid/' }, 202))
    .mockResolvedValueOnce(json({ jobId: jid }, 202))
    .mockResolvedValueOnce(json({ caption: 'Try again.' }));
  vi.stubGlobal('fetch', fetch);
  const { livePost } = await import('../src/live/transport');
  const pending = livePost('/v1/live/coach', { profileId: 'display-name' });
  await vi.advanceTimersByTimeAsync(600);
  expect(await pending).toEqual({ caption: 'Try again.' });
  expect(JSON.parse(fetch.mock.calls[1][1].body).profileId).toBe('p_abc');
  expect(fetch.mock.calls[1][1].credentials).toBe('same-origin');
  expect(fetch.mock.calls[1][1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(fetch.mock.calls[2][0]).toBe(`/v1/live/jobs/${jid}`);
  expect(fetch.mock.calls[3][0]).toBe(`/v1/live/jobs/${jid}`);
});

test('local backends retain the caller profile and synchronous contract', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ shared: false, profileId: null }))
    .mockResolvedValueOnce(json({ caption: 'Ready.' }));
  vi.stubGlobal('fetch', fetch);
  const { livePost } = await import('../src/live/transport');
  expect(await livePost('/v1/live/coach', { profileId: 'local-name' })).toEqual({ caption: 'Ready.' });
  expect(JSON.parse(fetch.mock.calls[1][1].body).profileId).toBe('local-name');
});

test('aborting polling stops further requests', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ shared: true, profileId: 'p_abc' }))
    .mockResolvedValueOnce(json({ jobId: jid }, 202));
  vi.stubGlobal('fetch', fetch);
  const { livePost } = await import('../src/live/transport');
  const ctl = new AbortController();
  const pending = livePost('/v1/live/coach', {}, ctl.signal);
  const rejected = expect(pending).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(1);
  ctl.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('conversation revisions follow the committed response into the next request', async () => {
  const response = { sessionId: jid, say: 'Ready.', action: 'demonstrate', revision: 3 };
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ shared: true, profileId: 'p_abc' }))
    .mockResolvedValueOnce(json(response))
    .mockResolvedValueOnce(json({ ...response, revision: 4 }));
  vi.stubGlobal('fetch', fetch);
  const { startSession, sendTurn } = await import('../src/conversation/director/api');
  await startSession({ profileId: 'name', displayName: 'Maya', sounds: ['u'] });
  await sendTurn({ sessionId: jid, profileId: 'name', event: { kind: 'control', control: 'ready' } });
  expect(JSON.parse(fetch.mock.calls[2][1].body).expectedRevision).toBe(3);
});

test('HTTP failures and invalid job identifiers never become coaching responses', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ shared: true, profileId: 'p_abc' }))
    .mockResolvedValueOnce(json({ detail: 'queue_full' }, 429))
    .mockResolvedValueOnce(json({ jobId: '../../other' }, 202));
  vi.stubGlobal('fetch', fetch);
  const { livePost } = await import('../src/live/transport');
  await expect(livePost('/v1/live/coach', {})).rejects.toThrow('429');
  await expect(livePost('/v1/live/coach', {})).rejects.toThrow('Malformed coaching job');
});
