import { expect, test } from '../../game/__tests__/harness';
import { ClipRing, encodeWav16, resampleLinear, toBase64 } from '../attemptAudio';

const str = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

test('encodeWav16 header', () => {
  const w = encodeWav16(new Float32Array(100), 16000);
  const v = new DataView(w.buffer);
  expect(w.length).toBe(244);
  expect(str(w, 0, 4)).toBe('RIFF');
  expect(str(w, 8, 4)).toBe('WAVE');
  expect(str(w, 12, 4)).toBe('fmt ');
  expect(v.getUint16(20, true)).toBe(1);
  expect(v.getUint16(22, true)).toBe(1);
  expect(v.getUint32(24, true)).toBe(16000);
  expect(v.getUint16(34, true)).toBe(16);
  expect(str(w, 36, 4)).toBe('data');
  expect(v.getUint32(40, true)).toBe(200);
  expect(v.getUint32(4, true)).toBe(236);
});

test('encodeWav16 clamps', () => {
  const w = encodeWav16(new Float32Array([2, -2, 0.5]), 16000);
  const v = new DataView(w.buffer);
  expect(v.getInt16(44, true)).toBe(32767);
  expect(v.getInt16(46, true)).toBe(-32768);
  expect(v.getInt16(48, true)).toBe(16384);
});

test('resampleLinear length and values', () => {
  expect(resampleLinear(new Float32Array(48000), 48000, 16000).length).toBe(16000);
  expect(resampleLinear(new Float32Array(48001), 48000, 16000).length).toBe(16000);
  expect(resampleLinear(new Float32Array(44100), 44100, 16000).length).toBe(16000);
  const r = resampleLinear(new Float32Array([0, 1, 2, 3]), 4, 2);
  expect(r.length).toBe(2);
  expect(r[1]).toBe(2);
});

test('toBase64 round trip on 250 KB', () => {
  const b = new Uint8Array(250000);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31) & 255;
  const back = Uint8Array.from(atob(toBase64(b)), (c) => c.charCodeAt(0));
  expect(back.length).toBe(b.length);
  let same = true;
  for (let i = 0; i < b.length; i++) if (back[i] !== b[i]) same = false;
  expect(same).toBe(true);
});

test('ClipRing under-filled returns null, filled returns window', () => {
  const r = new ClipRing(1000);
  expect(r.take(1000, 1000)).toBe(null);
  r.push(new Float32Array(2000).fill(0.1), 5000);
  expect(r.take(5000, 3000)).toBe(null);
  expect(r.take(5000, 1000)!.length).toBe(1000);
  expect(r.take(4000, 1000)!.length).toBe(1000);
  expect(r.take(1000, 1000)).toBe(null);
});
