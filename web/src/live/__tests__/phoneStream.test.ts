import { expect, test } from '../../game/__tests__/harness';
import { CHUNK_SAMPLES, EMPTY_PHONES, PcmChunker, floatToInt16, mergePhones } from '../phoneStream';

const ph = (p: string, startMs: number) => ({ p, startMs, endMs: startMs + 60, conf: 0.9 });

test('mergePhones appends new committed and dedupes by startMs+p', () => {
  let s = mergePhones(EMPTY_PHONES, { committed: [ph('t', 0), ph('ɹ', 60)], provisional: [] });
  expect(s.committed.length).toBe(2);
  s = mergePhones(s, { committed: [ph('ɹ', 60), ph('æ', 120)], provisional: [] });
  expect(s.committed.length).toBe(3);
  expect(s.committed[2].p).toBe('æ');
  s = mergePhones(s, { committed: [ph('t', 300)], provisional: [] });
  expect(s.committed.length).toBe(4);
});

test('mergePhones replaces provisional and keeps committed identity when nothing new', () => {
  const a = mergePhones(EMPTY_PHONES, { committed: [ph('t', 0)], provisional: [ph('ɹ', 60)] });
  expect(a.provisional[0].p).toBe('ɹ');
  const b = mergePhones(a, { committed: [], provisional: [ph('k', 90)] });
  expect(b.provisional.length).toBe(1);
  expect(b.provisional[0].p).toBe('k');
  expect(b.committed === a.committed).toBe(true);
  const c = mergePhones(b, {});
  expect(c.provisional.length).toBe(0);
});

test('mergePhones bounds committed', () => {
  let s = EMPTY_PHONES;
  for (let i = 0; i < 100; i++) s = mergePhones(s, { committed: [ph('a', i * 10)], provisional: [] });
  expect(s.committed.length).toBe(60);
  expect(s.committed[59].startMs).toBe(990);
  expect(s.committed[0].startMs).toBe(400);
});

test('floatToInt16 clamps and scales', () => {
  expect(floatToInt16(0)).toBe(0);
  expect(floatToInt16(1)).toBe(32767);
  expect(floatToInt16(-1)).toBe(-32768);
  expect(floatToInt16(5)).toBe(32767);
  expect(floatToInt16(-5)).toBe(-32768);
});

test('PcmChunker downsamples 48k to 16k in 800-sample chunks', () => {
  const c = new PcmChunker(48000);
  let total = 0;
  const first: Int16Array[] = [];
  // 1 s of 48k constant 0.5 in odd-sized pieces
  let fed = 0;
  while (fed < 48000) {
    const n = Math.min(2048, 48000 - fed);
    for (const ch of c.push(new Float32Array(n).fill(0.5))) {
      total += ch.length;
      first.push(ch);
    }
    fed += n;
  }
  expect(first.length).toBe(20); // 16000/800 = 20
  expect(total).toBe(20 * CHUNK_SAMPLES);
  expect(first[0].length).toBe(CHUNK_SAMPLES);
  expect(first[7][100]).toBe(Math.round(0.5 * 32767));
});

test('PcmChunker preserves a ramp across push boundaries (same output as one push)', () => {
  const x = new Float32Array(48000).map((_, i) => Math.sin(i / 40));
  const a = new PcmChunker(48000, 16000, 100);
  const b = new PcmChunker(48000, 16000, 100);
  const one = b.push(x);
  const many: Int16Array[] = [];
  for (let i = 0; i < x.length; i += 777) many.push(...a.push(x.slice(i, i + 777)));
  expect(many.length).toBe(one.length);
  for (let k = 0; k < one.length; k++) {
    for (let i = 0; i < 100; i++) expect(many[k][i]).toBe(one[k][i]);
  }
});

test('PcmChunker passes through at 16k', () => {
  const c = new PcmChunker(16000, 16000, 100);
  const out = c.push(new Float32Array(201).fill(0.25));
  expect(out.length).toBe(2);
  expect(out[0][0]).toBe(Math.round(0.25 * 32767));
});
