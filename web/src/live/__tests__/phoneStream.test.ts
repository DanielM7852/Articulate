import { expect, test } from '../../game/__tests__/harness';
import { CHUNK_SAMPLES, EMPTY_PHONES, PcmChunker, classifyClose, connectPhoneStream, floatToInt16, mergePhones, type StreamInfo, type StreamState } from '../phoneStream';

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

test('classifyClose maps close codes to reasons', () => {
  expect(classifyClose(1008, false)).toBe('origin-rejected');
  expect(classifyClose(1006, false)).toBe('unreachable');
  expect(classifyClose(1000, false)).toBe('unreachable');
  expect(classifyClose(1000, true)).toBe('closed');
  expect(classifyClose(1008, true)).toBe('closed');
});

class FakeWS {
  static last: FakeWS | null = null;
  static OPEN = 1;
  binaryType = '';
  readyState = 0;
  bufferedAmount = 0;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send() {}
  close() {}
}

function run(url: string, script: (ws: FakeWS) => void) {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevWarn = console.warn;
  const warns: string[] = [];
  const states: { s: StreamState; info?: StreamInfo }[] = [];
  g.WebSocket = FakeWS;
  console.warn = (m: unknown) => void warns.push(String(m));
  const h = connectPhoneStream({ getAudioTracks: () => [] } as unknown as MediaStream, {
    url,
    onState: (s, info) => states.push({ s, info }),
    onPhones: () => undefined,
  });
  try {
    script(FakeWS.last!);
  } finally {
    h.close();
    g.WebSocket = prevWS;
    console.warn = prevWarn;
  }
  return { warns, reasons: states.filter((x) => x.info?.reason).map((x) => x.info!.reason) };
}

test('close 1008 before ready reports origin-rejected and warns once per url+reason', () => {
  const a = run('ws://t1/ws', (ws) => ws.onclose!({ code: 1008 }));
  expect(a.reasons.join()).toBe('origin-rejected');
  expect(a.warns.length).toBe(1);
  expect(a.warns[0].includes('(origin-rejected) at ws://t1/ws')).toBe(true);
  expect(a.warns[0].includes('PHONES_ALLOWED_ORIGINS')).toBe(true);
  expect(a.warns[0].includes('basic formant view')).toBe(true);
  const b = run('ws://t1/ws', (ws) => ws.onclose!({ code: 1008 }));
  expect(b.reasons.join()).toBe('origin-rejected');
  expect(b.warns.length).toBe(0);
  const c = run('ws://t1/ws', (ws) => ws.onclose!({ code: 1006 }));
  expect(c.reasons.join()).toBe('unreachable');
  expect(c.warns.length).toBe(1);
});

test('error then close before ready is unreachable; close after ready is closed', () => {
  const a = run('ws://t2/ws', (ws) => {
    ws.onerror!();
    ws.onclose!({ code: 1006 });
  });
  expect(a.reasons.join()).toBe('unreachable');
  const b = run('ws://t3/ws', (ws) => {
    ws.onmessage!({ data: JSON.stringify({ type: 'ready' }) });
    ws.onclose!({ code: 1006 });
  });
  expect(b.reasons.join()).toBe('closed');
  expect(b.warns.length).toBe(1);
});
