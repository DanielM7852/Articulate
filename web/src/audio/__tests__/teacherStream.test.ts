// Async tests for speakTeacherStream and the speakTeacher request body. The shared harness is synchronous, so this file
// carries its own tiny async runner (see runStream.ts). Browser globals are replaced with fakes before the module loads.
import { expect } from '../../game/__tests__/harness';

type Msg = Record<string, unknown>;

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: Msg[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWS.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as Msg); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  serve(msg: Msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

class FakeCtx {
  currentTime = 0;
  outputLatency = 0;
  baseLatency = 0;
  state = 'running';
  destination = {};
  resume() { return Promise.resolve(); }
  createBuffer(_c: number, len: number, rate: number) { return { duration: len / rate, copyToChannel() { /* noop */ } }; }
  createBufferSource() { return { buffer: null, connect() { /* noop */ }, disconnect() { /* noop */ }, start() { /* noop */ }, stop() { /* noop */ }, onended: null }; }
}

const g = globalThis as unknown as Record<string, unknown>;
const fakeCtx = new FakeCtx();
g.WebSocket = FakeWS;
g.window = { AudioContext: function () { return fakeCtx; } };
g.fetch = async (url: string) => {
  if (String(url).includes('speech/token')) {
    return { ok: true, json: async () => ({ token: 'tok', ws_url: 'wss://x/tts', cartesia_version: 'v', model_id: 'm1', voice_id: 'v1', sample_rate: 24000, encoding: 'pcm_f32le' }) };
  }
  return { ok: false, json: async () => ({}) };
};

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
// 1 second of silence at 24 kHz as base64 float32.
const oneSecond = btoa(String.fromCharCode(...new Uint8Array(new Float32Array(24000).buffer)));

type AsyncCase = { name: string; fn: () => Promise<void> };
const cases: AsyncCase[] = [];
const atest = (name: string, fn: () => Promise<void>) => { cases.push({ name, fn }); };

async function mod() { return import('../teacher'); }

function lastWs(): FakeWS { return FakeWS.all[FakeWS.all.length - 1]; }

atest('stream: first push sends continue:true with buffer delay; later pushes lead with a space and share context_id', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  s.push('Hello there.');
  await tick();
  const ws = lastWs();
  ws.open();
  s.push('How are you?');
  expect(ws.sent.length).toBe(2);
  const [a, b] = ws.sent;
  expect(a.transcript as string).toBe('Hello there.');
  expect(a.continue as boolean).toBe(true);
  expect(a.max_buffer_delay_ms as number).toBe(0);
  expect(a.add_timestamps as boolean).toBe(true);
  expect(b.transcript as string).toBe(' How are you?');
  expect(b.continue as boolean).toBe(true);
  expect(b.context_id as string).toBe(a.context_id as string);
  expect(b.model_id as string).toBe(a.model_id as string);
  s.cancel();
});

atest('stream: end sends empty continue:false exactly once; later push ignored; end idempotent', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  s.push('One.');
  await tick();
  const ws = lastWs();
  ws.open();
  s.end();
  s.end();
  s.push('Ignored.');
  const closers = ws.sent.filter((m) => m.continue === false);
  expect(closers.length).toBe(1);
  expect(closers[0].transcript as string).toBe('');
  expect(ws.sent.length).toBe(2);
  expect(s.segments.length).toBe(1);
  s.cancel();
});

atest('stream: pushes and end before the socket opens flush in order on open', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  s.push('A one.');
  s.push('B two.');
  s.end();
  await tick();
  const ws = lastWs();
  expect(ws.sent.length).toBe(0);
  ws.open();
  expect(ws.sent.map((m) => m.transcript).join('|')).toBe('A one.| B two.|');
  expect(ws.sent.map((m) => m.continue).join(',')).toBe('true,true,false');
  s.cancel();
});

atest('stream: end with zero pushes finishes at once and sends nothing', async () => {
  const { speakTeacherStream } = await mod();
  const before = FakeWS.all.length;
  const s = speakTeacherStream();
  let reason = '';
  s.on('end', (r) => { reason = r; });
  s.end();
  await s.done;
  expect(reason).toBe('finished');
  await tick();
  expect(FakeWS.all.slice(before).every((w) => w.sent.length === 0)).toBe(true);
});

atest('stream: text and segments offsets for three pushes; blank ignored', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  s.push('Hi there.');
  s.push('   ');
  s.push(' Next one. ');
  s.push('Last!');
  expect(s.text).toBe('Hi there. Next one. Last!');
  expect(s.segments.map((x) => x.start).join(',')).toBe('0,10,20');
  for (const seg of s.segments) expect(s.text.slice(seg.start, seg.start + seg.text.length)).toBe(seg.text);
  s.cancel();
});

atest('stream: heardText only has words started by the clock; cumulative timestamps pass through', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  s.push('Hello there. Bye now.');
  await tick();
  const ws = lastWs();
  ws.open();
  const ctxId = ws.sent[0].context_id as string;
  expect(s.heardText()).toBe('');
  ws.serve({ type: 'chunk', context_id: ctxId, data: oneSecond, done: false });
  ws.serve({ type: 'timestamps', context_id: ctxId, word_timestamps: { words: ['Hello', 'there.'], start: [0, 0.4], end: [0.4, 0.8] } });
  ws.serve({ type: 'chunk', context_id: ctxId, data: oneSecond, done: false });
  ws.serve({ type: 'timestamps', context_id: ctxId, word_timestamps: { words: ['Bye', 'now.'], start: [1.0, 1.4], end: [1.4, 1.8] } });
  expect(s.words[2].start).toBe(1.0);
  // startAt = 0.05 (LEAD_S); clock = currentTime - 0.05.
  fakeCtx.currentTime = 0.05 + 0.5;
  expect(s.heardText()).toBe('Hello there.');
  fakeCtx.currentTime = 0.05 + 1.2;
  expect(s.heardText()).toBe('Hello there. Bye');
  s.cancel();
  fakeCtx.currentTime = 99;
  expect(s.heardText()).toBe('Hello there. Bye');
  fakeCtx.currentTime = 0;
});

atest('stream: per-input timestamps (restart near 0) are offset onto the stream clock', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  s.push('A b.');
  await tick();
  const ws = lastWs();
  ws.open();
  const ctxId = ws.sent[0].context_id as string;
  ws.serve({ type: 'timestamps', context_id: ctxId, word_timestamps: { words: ['A', 'b.'], start: [0, 0.3], end: [0.3, 0.6] } });
  ws.serve({ type: 'timestamps', context_id: ctxId, word_timestamps: { words: ['C', 'd.'], start: [0, 0.3], end: [0.3, 0.6] } });
  expect(s.words[2].start).toBe(0.6);
  expect(s.words[3].end).toBe(1.2);
  s.cancel();
});

atest('stream: an input split across two blocks is offset once; a third input offsets by the cumulative end', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  s.push('A b.');
  await tick();
  const ws = lastWs();
  ws.open();
  const ctxId = ws.sent[0].context_id as string;
  const block = (words: string[], start: number[], end: number[]) => ws.serve({ type: 'timestamps', context_id: ctxId, word_timestamps: { words, start, end } });
  block(['A', 'b.'], [0, 0.3], [0.3, 0.6]); // input 1: 0..0.6
  block(['C', 'd.'], [0, 0.3], [0.3, 0.6]); // input 2, block 1 (restarts near 0): +0.6
  block(['e', 'f.'], [0.6, 0.75], [0.75, 0.9]); // input 2, block 2 continues from block 1: still +0.6, not re-offset
  block(['G', 'h.'], [0, 0.2], [0.2, 0.5]); // input 3 restarts: +1.5 (0.6 + 0.9)
  const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true);
  near(s.words[2].start, 0.6);
  near(s.words[3].end, 1.2);
  near(s.words[4].start, 1.2);
  near(s.words[5].end, 1.5);
  near(s.words[6].start, 1.5);
  near(s.words[7].end, 2.0);
  s.cancel();
});

atest('stream: three inputs of different lengths; cumulative timestamps are not offset', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  s.push('A b.');
  await tick();
  const ws = lastWs();
  ws.open();
  const ctxId = ws.sent[0].context_id as string;
  const block = (words: string[], start: number[], end: number[]) => ws.serve({ type: 'timestamps', context_id: ctxId, word_timestamps: { words, start, end } });
  block(['A'], [0], [0.6]);
  block(['B'], [0], [0.4]);
  block(['C'], [0], [0.5]);
  const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true);
  near(s.words[1].start, 0.6);
  near(s.words[1].end, 1.0);
  near(s.words[2].start, 1.0);
  near(s.words[2].end, 1.5);
  s.cancel();
});

atest('stream: push returns true when accepted, false for blank, after end and after a mid-stream transport failure', async () => {
  const { speakTeacherStream } = await mod();
  const s = speakTeacherStream();
  expect(s.push('One.')).toBe(true);
  expect(s.push('   ')).toBe(false);
  await tick();
  const ws = lastWs();
  ws.open();
  s.end();
  expect(s.push('Late.')).toBe(false);
  s.cancel();
  expect(s.push('After cancel.')).toBe(false);

  const t = speakTeacherStream();
  expect(t.push('Two.')).toBe(true);
  await tick();
  const ws2 = lastWs();
  ws2.open();
  const ctxId = ws2.sent[0].context_id as string;
  ws2.serve({ type: 'chunk', context_id: ctxId, data: oneSecond, done: false });
  ws2.serve({ type: 'error', context_id: ctxId, message: 'boom' });
  expect(t.push('After failure.')).toBe(false);
  expect(t.segments.length).toBe(1);
  t.cancel();
});

atest('speakTeacher: single-message body unchanged (continue:false, no max_buffer_delay_ms, full text)', async () => {
  const { speakTeacher } = await mod();
  const s = speakTeacher('Hello world.');
  await tick();
  await tick();
  const ws = lastWs();
  ws.open();
  expect(ws.sent.length).toBe(1);
  const body = ws.sent[0];
  expect(body.transcript as string).toBe('Hello world.');
  expect(body.continue as boolean).toBe(false);
  expect('max_buffer_delay_ms' in body).toBe(false);
  expect(body.add_phoneme_timestamps as boolean).toBe(true);
  s.cancel();
});

export async function runStreamTests(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); console.log(`  ok   ${c.name}`); } catch (e) { failed++; console.log(`  FAIL ${c.name}\n       ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  // The module's tick interval and fake sockets can keep Node alive; the runner exits explicitly.
  const proc = (globalThis as unknown as { process: { exit(code: number): void } }).process;
  proc.exit(failed ? 1 : 0);
}
