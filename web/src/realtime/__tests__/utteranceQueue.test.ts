// Async tests for UtteranceQueue (own tiny runner: the shared harness is synchronous).
import { expect } from '../../game/__tests__/harness';
import { UtteranceQueue, planHistoryRepair, type HeardStream, type QueueStream } from '../utteranceQueue';

class FakeStream implements QueueStream {
  pushed: string[] = [];
  ended = false;
  cancelled = false;
  finish!: () => void;
  readonly done = new Promise<void>((r) => { this.finish = r; });
  accept = true;
  push(s: string) { if (!this.accept) return false; this.pushed.push(s); return true; }
  end() { this.ended = true; }
  cancel() { this.cancelled = true; this.finish(); }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function make(canSpeak = () => true) {
  const streams: FakeStream[] = [];
  const busy: boolean[] = [];
  const sentences: string[] = [];
  const q = new UtteranceQueue<FakeStream>({
    createStream: () => { const s = new FakeStream(); streams.push(s); return s; },
    canSpeak: () => canSpeak(),
    onBusy: (b) => busy.push(b),
    onSentence: (t) => sentences.push(t),
  });
  return { q, streams, busy, sentences };
}

const cases: { name: string; fn: () => Promise<void> }[] = [
  { name: 'sentences of one response go into one stream, end() on text end', fn: async () => {
    const { q, streams, sentences } = make();
    q.add('r1', ['One.']);
    q.add('r1', ['Two.', 'Three.']);
    expect(streams.length).toBe(1);
    expect(streams[0].pushed.join('|')).toBe('One.|Two.|Three.');
    expect(sentences.length).toBe(3);
    expect(streams[0].ended).toBe(false);
    q.end('r1');
    expect(streams[0].ended).toBe(true);
    streams[0].finish();
    await tick();
    expect(q.busy).toBe(false);
  } },
  { name: 'two responses play in order; the next stream starts only after the previous is done', fn: async () => {
    const { q, streams } = make();
    q.add('r1', ['A.']);
    q.add('r2', ['B.']);
    q.end('r1');
    q.end('r2');
    expect(streams.length).toBe(1);
    expect(q.utterances.length).toBe(2);
    streams[0].finish();
    await tick();
    expect(streams.length).toBe(2);
    expect(streams[1].pushed.join('|')).toBe('B.');
    expect(streams[1].ended).toBe(true);
    streams[1].finish();
    await tick();
    expect(q.busy).toBe(false);
  } },
  { name: 'end() before the stream exists still ends it on creation; empty response makes no utterance', fn: async () => {
    const { q, streams } = make();
    q.add('r0', []);
    q.add('r0', ['  ']);
    expect(q.busy).toBe(false);
    q.add('r1', ['A.']);
    q.add('r2', ['B.']);
    q.end('r2');
    streams[0].finish();
    await tick();
    expect(streams[1].ended).toBe(true);
  } },
  { name: 'stop() cancels the stream and clears everything', fn: async () => {
    const { q, streams, busy } = make();
    q.add('r1', ['A.']);
    q.add('r2', ['B.']);
    q.stop();
    expect(streams[0].cancelled).toBe(true);
    expect(q.busy).toBe(false);
    expect(q.utterances.length).toBe(0);
    await tick();
    expect(streams.length).toBe(1);
    expect(busy.join(',')).toBe('true,false');
  } },
  { name: 'canSpeak false on a new utterance or a push cancels and clears', fn: async () => {
    let ok = true;
    const { q, streams } = make(() => ok);
    q.add('r1', ['A.']);
    q.add('r2', ['B.']);
    ok = false;
    q.add('r1', ['More.']);
    expect(streams[0].cancelled).toBe(true);
    expect(q.busy).toBe(false);
    q.add('r3', ['C.']);
    expect(streams.length).toBe(1);
  } },
  { name: 'canSpeak false when the next utterance would start clears the queue', fn: async () => {
    let ok = true;
    const { q, streams } = make(() => ok);
    q.add('r1', ['A.']);
    q.add('r2', ['B.']);
    ok = false;
    streams[0].finish();
    await tick();
    expect(streams.length).toBe(1);
    expect(q.busy).toBe(false);
  } },
  { name: 'new response after stop plays normally', fn: async () => {
    const { q, streams } = make();
    q.add('r1', ['A.']);
    q.stop();
    q.add('r2', ['B.']);
    expect(streams.length).toBe(2);
    expect(q.head!.responseId).toBe('r2');
    streams[1].finish();
    await tick();
    expect(q.busy).toBe(false);
  } },
  { name: 'check() stops the queue when the floor is lost mid-stream', fn: async () => {
    let ok = true;
    const { q, streams, busy } = make(() => ok);
    q.add('r1', ['A.']);
    expect(q.check()).toBe(true);
    ok = false;
    expect(q.check()).toBe(false);
    expect(streams[0].cancelled).toBe(true);
    expect(q.busy).toBe(false);
    expect(busy[busy.length - 1]).toBe(false);
  } },
  { name: 'repair plan: fully heard reply is not rewritten, cut reply is shortened, unstarted is deleted', fn: async () => {
    class HS extends FakeStream implements HeardStream {
      source = 'cartesia';
      constructor(public text: string, public words: { text: string }[], private heard: string) { super(); }
      heardText() { return this.heard; }
    }
    const mk = (id: string, st: HS | null, textEnded: boolean) => ({ responseId: id, pending: [], spoken: [], textEnded, stream: st });
    const full = new HS('Nice work today.', [{ text: 'Nice' }, { text: 'work' }, { text: 'today.' }], 'Nice work today.');
    const cut = new HS('Nice work today.', [{ text: 'Nice' }, { text: 'work' }, { text: 'today.' }], 'Nice work');
    const growing = new HS('Nice work', [{ text: 'Nice' }, { text: 'work' }], 'Nice work');
    const items: Record<string, string> = { r1: 'i1', r2: 'i2', r3: 'i3', r4: 'i4', r5: 'i5' };
    const plan = planHistoryRepair(
      [mk('r1', full, true), mk('r2', cut, true), mk('r3', null, true), mk('r4', growing, false)],
      'r5',
      (r) => items[r] ?? null,
    );
    expect(plan.map((p) => `${p.itemId}:${p.heard}`).join('|')).toBe('i2:Nice work|i3:|i4:Nice work|i5:');
  } },
  { name: 'repair plan: timestamps received only for sentence 1 (fully played) cuts the reply to sentence 1', fn: async () => {
    class HS extends FakeStream implements HeardStream {
      source = 'cartesia';
      constructor(public text: string, public words: { text: string }[], private heard: string) { super(); }
      heardText() { return this.heard; }
    }
    const text = 'First one here. Second one here. Third one here.';
    const st = new HS(text, [{ text: 'First' }, { text: 'one' }, { text: 'here.' }], 'First one here.');
    const u = { responseId: 'r1', pending: [], spoken: [], textEnded: true, stream: st };
    const plan = planHistoryRepair([u], null, () => 'i1');
    expect(plan.map((p) => `${p.itemId}:${p.heard}`).join('|')).toBe('i1:First one here.');
  } },
  { name: 'repair plan: browser reply without word timing counts as heard once text is complete', fn: async () => {
    class HS extends FakeStream implements HeardStream {
      source = 'browser';
      words: { text: string }[] = [];
      constructor(public text: string) { super(); }
      heardText() { return ''; }
    }
    const u = { responseId: 'r1', pending: [], spoken: [], textEnded: true, stream: new HS('Hi there.') };
    expect(planHistoryRepair([u], null, () => 'i1').length).toBe(0);
  } },
  { name: 'a sentence the stream ignored (push returned false) is not recorded', fn: async () => {
    const { q, streams, sentences } = make();
    q.add('r1', ['One.']);
    streams[0].accept = false;
    q.add('r1', ['Two.']);
    expect(q.head!.spoken.join('|')).toBe('One.');
    expect(sentences.join('|')).toBe('One.');
  } },
];

export async function runQueueTests(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); console.log(`  ok   ${c.name}`); } catch (e) { failed++; console.log(`  FAIL ${c.name}\n       ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} queue tests passed`);
  if (failed) throw new Error(`${failed} queue test(s) failed`);
}
