// Ordered playback of Ava's replies: one utterance per realtime response, each spoken through ONE stream so prosody
// carries across its sentences. The next response's stream is only created once the previous one is done (creating a
// stream cancels whatever is current). Pure logic with an injected stream factory so it can be tested without audio.

import { heardPrefix } from './sentences';

export interface QueueStream {
  /** false = the sentence was ignored (stream ended or failed); anything else counts as accepted. */
  push(sentence: string): boolean | void;
  end(): void;
  cancel(): void;
  readonly done: Promise<void>;
}

export interface Utterance<S extends QueueStream> {
  responseId: string;
  /** Sentences not yet handed to a stream (only before the stream exists). */
  pending: string[];
  /** Every sentence handed to the stream, in order. */
  spoken: string[];
  textEnded: boolean;
  stream: S | null;
}

export interface UtteranceQueueHooks<S extends QueueStream> {
  createStream(): S;
  /** Checked when an utterance would start and before every push; false cancels everything. */
  canSpeak(): boolean;
  /** The utterance's stream was created and holds its first sentences. */
  onStream?(u: Utterance<S>): void;
  /** One sentence was handed to a stream. */
  onSentence?(text: string, u: Utterance<S>): void;
  /** The utterance finished playing (not called on cancel). */
  onUtteranceDone?(u: Utterance<S>): void;
  /** true when the queue becomes non-empty, false when it drains or is stopped. */
  onBusy?(busy: boolean): void;
}

export class UtteranceQueue<S extends QueueStream> {
  private list: Utterance<S>[] = [];
  private running = false;
  private gen = 0;

  constructor(private readonly hooks: UtteranceQueueHooks<S>) {}

  /** Queued or playing utterances, head first. */
  get utterances(): readonly Utterance<S>[] {
    return this.list;
  }

  get head(): Utterance<S> | null {
    return this.list[0] ?? null;
  }

  /** An utterance is queued or playing. */
  get busy(): boolean {
    return this.list.length > 0 || this.running;
  }

  find(responseId: string): Utterance<S> | undefined {
    return this.list.find((u) => u.responseId === responseId);
  }

  /** Sentences of one response, as they complete. A response with no sentences creates no utterance. */
  add(responseId: string, sentences: string[]): void {
    const clean = sentences.filter((s) => s.trim());
    if (!clean.length) return;
    let u = this.find(responseId);
    if (u?.textEnded) return;
    if (!this.hooks.canSpeak()) { this.stop(); return; }
    if (!u) {
      u = { responseId, pending: [], spoken: [], textEnded: false, stream: null };
      const wasBusy = this.busy;
      this.list.push(u);
      if (!wasBusy) this.hooks.onBusy?.(true);
    }
    if (u.stream) {
      for (const s of clean) this.give(u, s);
    } else {
      u.pending.push(...clean);
    }
    void this.pump();
  }

  /** The response's text is complete: close its stream once everything is pushed. */
  end(responseId: string): void {
    const u = this.find(responseId);
    if (!u || u.textEnded) return;
    u.textEnded = true;
    if (u.stream) u.stream.end();
  }

  /** Floor check for a playing stream (call on its 'start' and 'word' events): false stops the queue. */
  check(): boolean {
    if (this.hooks.canSpeak()) return true;
    this.stop();
    return false;
  }

  /** Cancel the playing stream and forget everything queued. */
  stop(): void {
    this.gen += 1;
    const streams = this.list.map((u) => u.stream).filter((s): s is S => !!s);
    const wasBusy = this.busy;
    this.list = [];
    this.running = false;
    for (const s of streams) s.cancel();
    if (wasBusy) this.hooks.onBusy?.(false);
  }

  private give(u: Utterance<S>, sentence: string): void {
    if (u.stream!.push(sentence) === false) return; // ignored by the stream: it was never spoken
    u.spoken.push(sentence);
    this.hooks.onSentence?.(sentence, u);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = this.gen;
    while (gen === this.gen && this.list.length) {
      const u = this.list[0];
      if (!this.hooks.canSpeak()) { this.stop(); return; }
      const stream = this.hooks.createStream();
      u.stream = stream;
      const first = u.pending;
      u.pending = [];
      for (const s of first) this.give(u, s);
      try { this.hooks.onStream?.(u); } catch { /* caller errors never stop speech */ }
      if (u.textEnded) stream.end();
      await stream.done;
      if (gen !== this.gen) return; // stop() already reset the queue
      this.list.shift();
      try { this.hooks.onUtteranceDone?.(u); } catch { /* ignore */ }
    }
    if (gen !== this.gen) return;
    this.running = false;
    this.hooks.onBusy?.(false);
  }
}

/** What a stream must expose for history repair. */
export interface HeardStream extends QueueStream {
  readonly text: string;
  readonly words: readonly { text: string }[];
  readonly source?: string;
  heardText(): string;
}

export interface RepairStep {
  itemId: string;
  /** Text to keep ('' = delete the item). */
  heard: string;
}

/**
 * Which assistant items must change so history matches what the learner heard. Pure: compute it BEFORE the streams are
 * cancelled (they know what was heard), apply it afterwards. Fully heard replies are never rewritten.
 * `generating` is the response the server is still writing, if any.
 */
export function planHistoryRepair<S extends HeardStream>(
  utterances: readonly Utterance<S>[],
  generating: string | null,
  itemFor: (responseId: string) => string | null,
): RepairStep[] {
  const steps: RepairStep[] = [];
  const seen = new Set<string>();
  for (const u of utterances) {
    seen.add(u.responseId);
    const itemId = itemFor(u.responseId);
    if (!itemId) continue;
    const st = u.stream;
    if (!st) { steps.push({ itemId, heard: '' }); continue; }
    // Text still streaming (not ended) means the item holds more than the stream does.
    const textComplete = u.textEnded && generating !== u.responseId;
    const full = st.text;
    const n = st.heardText().split(/\s+/).filter(Boolean).length;
    // An utterance still in the queue is still playing (finished ones are shifted off), so timestamps received so far
    // say nothing about completeness: fully heard means every word of the full text has started playing. The browser
    // voice has no word timing at all; its reply counts as heard once its text is complete.
    const total = full.split(/\s+/).filter(Boolean).length;
    const browserNoTiming = st.source === 'browser' && st.words.every((w) => !w.text);
    if (textComplete && (browserNoTiming || n >= total)) continue;
    const heard = heardPrefix(full, n);
    if (heard === full && textComplete) continue;
    steps.push({ itemId, heard });
  }
  // A reply still being written that never reached the speaker: nothing of it was heard.
  if (generating && !seen.has(generating)) {
    const itemId = itemFor(generating);
    if (itemId) steps.push({ itemId, heard: '' });
  }
  return steps;
}
