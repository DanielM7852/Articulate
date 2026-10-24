import { afterEach, beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const args = () => ({
  attemptId: 'a1', profileId: 'display-name', sound: 'r',
  pcm: new Int16Array(16000), captureStartMonotonicMs: 0, timeOriginUnixMs: 0,
});

test('shared identity signs upload and status requests', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ shared: true, profileId: 'p_abc' }))
    .mockResolvedValueOnce(json({ accepted: true }, 202))
    .mockResolvedValueOnce(json({ status: 'pending' }));
  vi.stubGlobal('fetch', fetch);
  const { uploadArticulation } = await import('../src/live/articulationUpload');
  const { getArticulationStatus } = await import('../src/conversation/director/api');
  expect(await uploadArticulation(args())).toBe(true);
  expect(fetch.mock.calls[1][0]).toContain('profileId=p_abc');
  expect(fetch.mock.calls[1][1].credentials).toBe('same-origin');
  await getArticulationStatus('a1', 'display-name');
  expect(fetch.mock.calls[2][0]).toBe('/v1/live/articulation/a1?profileId=p_abc');
  expect(fetch.mock.calls[2][1].credentials).toBe('same-origin');
});

test('local identity keeps the caller profile', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(json({ accepted: true }, 202))
    .mockResolvedValueOnce(json({ status: 'pending' }));
  vi.stubGlobal('fetch', fetch);
  const { uploadArticulation } = await import('../src/live/articulationUpload');
  const { getArticulationStatus } = await import('../src/conversation/director/api');
  expect(await uploadArticulation(args())).toBe(true);
  expect(fetch.mock.calls[1][0]).toContain('profileId=display-name');
  await getArticulationStatus('a1', 'display-name');
  expect(fetch.mock.calls[2][0]).toBe('/v1/live/articulation/a1?profileId=display-name');
});

test('identity failure falls back to the caller profile without throwing', async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(json({ accepted: true }, 202))
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(json({ status: 'pending' }));
  vi.stubGlobal('fetch', fetch);
  const { uploadArticulation } = await import('../src/live/articulationUpload');
  const { getArticulationStatus } = await import('../src/conversation/director/api');
  expect(await uploadArticulation(args())).toBe(true);
  expect(fetch.mock.calls[1][0]).toContain('profileId=display-name');
  await getArticulationStatus('a1', 'display-name');
  expect(fetch.mock.calls[3][0]).toBe('/v1/live/articulation/a1?profileId=display-name');
});
