import { useEffect, useMemo, useState } from 'react';
import type { TeacherSpeech } from '../audio/teacher';
import './teacherCaptions.css';

/** The display tokens a timed word covers, inclusive; lo > hi never happens, -1 means none. */
export interface CaptionSpan {
  lo: number;
  hi: number;
}

/** Comparison key for a word: lowercase letters and digits only (punctuation, hyphens and apostrophes dropped). */
export function captionKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const MAX_GROUP = 6; // tokens one side may merge to match the other
const RESYNC_WINDOW = 6; // tokens each side to look ahead for an anchor after a mismatch

/**
 * Map each timed word (the TTS tokenization) to the display tokens (the caption split on whitespace)
 * it was spoken for. Walks both lists, merging consecutive tokens on either side whose keys
 * concatenate to the other side's (contractions, hyphens, split numbers), and after a mismatch (for
 * example "3" spoken as "three") resyncs on the next matching pair and spreads the words in between
 * by index, or by character position when the counts differ. The timed list may still be growing.
 */
export function alignCaptionWords(display: readonly string[], timed: readonly string[]): CaptionSpan[] {
  const out: CaptionSpan[] = timed.map(() => ({ lo: -1, hi: -1 }));
  if (!timed.length || !display.length) return out;

  const dIdx: number[] = [];
  const D: string[] = [];
  display.forEach((w, i) => {
    const k = captionKey(w);
    if (k) { dIdx.push(i); D.push(k); }
  });
  const tIdx: number[] = [];
  const T: string[] = [];
  timed.forEach((w, i) => {
    const k = captionKey(w);
    if (k) { tIdx.push(i); T.push(k); }
  });
  if (!D.length) return out;

  const spans: CaptionSpan[] = new Array(T.length); // over D indices

  // Fast path: same tokenization (the browser fallback, and most Cartesia lines).
  if (T.length <= D.length && T.every((k, i) => k === D[i])) {
    for (let i = 0; i < T.length; i++) spans[i] = { lo: i, hi: i };
  } else {
    /** Tokens consumed on each side if the keys at (i, j) match after merging, else null. */
    const group = (i: number, j: number): { di: number; dj: number } | null => {
      let a = D[i];
      let b = T[j];
      let di = 1;
      let dj = 1;
      while (a !== b) {
        if (a.length < b.length) {
          if (!b.startsWith(a) || i + di >= D.length || di >= MAX_GROUP) return null;
          a += D[i + di++];
        } else {
          if (!a.startsWith(b) || dj >= MAX_GROUP) return null;
          if (j + dj >= T.length) return { di, dj }; // the rest of this word has not arrived yet
          b += T[j + dj++];
        }
      }
      return { di, dj };
    };

    /** Spread timed [t0, t1) over display [d0, d1). */
    const spread = (d0: number, d1: number, t0: number, t1: number, tail: boolean) => {
      const nd = d1 - d0;
      const nt = t1 - t0;
      if (nt <= 0) return;
      if (nd <= 0) {
        // Extra spoken tokens with no display token: keep the previous highlight.
        const d = Math.min(Math.max(d0 - 1, 0), D.length - 1);
        for (let t = t0; t < t1; t++) spans[t] = { lo: d, hi: d };
        return;
      }
      if (nt === nd || (tail && nt < nd)) {
        // Equal counts, or a still-growing tail: one to one.
        for (let k = 0; k < nt; k++) spans[t0 + k] = { lo: d0 + k, hi: d0 + k };
        return;
      }
      // Character-fraction fallback: the word's index fraction picks the display token at that share of the text.
      const cum: number[] = [0];
      for (let d = d0; d < d1; d++) cum.push(cum[cum.length - 1] + D[d].length);
      const total = cum[cum.length - 1];
      for (let k = 0; k < nt; k++) {
        const at = ((k + 0.5) / nt) * total;
        let d = 0;
        while (d < nd - 1 && cum[d + 1] <= at) d++;
        spans[t0 + k] = { lo: d0 + d, hi: d0 + d };
      }
    };

    /** Nearest later (di, dj) where the lists match again, preferring the fewest skipped tokens. */
    const anchor = (i: number, j: number): { i: number; j: number } | null => {
      for (let s = 1; s <= 2 * RESYNC_WINDOW; s++) {
        let best: { i: number; j: number; skew: number } | null = null;
        for (let di = 0; di <= s; di++) {
          const dj = s - di;
          if (di > RESYNC_WINDOW || dj > RESYNC_WINDOW || i + di >= D.length || j + dj >= T.length) continue;
          const skew = Math.abs(di - dj); // balanced skips first: a substituted word, not an insertion
          if (D[i + di] === T[j + dj] && (!best || skew < best.skew)) best = { i: i + di, j: j + dj, skew };
        }
        if (best) return { i: best.i, j: best.j };
      }
      return null;
    };

    let i = 0;
    let j = 0;
    while (j < T.length) {
      if (i >= D.length) {
        spread(D.length, D.length, j, T.length, true);
        break;
      }
      const g = group(i, j);
      if (g) {
        for (let k = 0; k < g.dj; k++) spans[j + k] = { lo: i, hi: i + g.di - 1 };
        i += g.di;
        j += g.dj;
        continue;
      }
      const a = anchor(i, j);
      if (a) {
        spread(i, a.i, j, a.j, false);
        i = a.i;
        j = a.j;
        continue;
      }
      spread(i, D.length, j, T.length, true);
      break;
    }
  }

  // Back to original indices; empty-key timed tokens (bare punctuation) follow their neighbour.
  T.forEach((_, k) => {
    const s = spans[k];
    out[tIdx[k]] = s ? { lo: dIdx[s.lo], hi: dIdx[s.hi] } : { lo: -1, hi: -1 };
  });
  for (let t = 0; t < out.length; t++) {
    if (out[t].lo >= 0) continue;
    if (t > 0 && out[t - 1].lo >= 0) out[t] = out[t - 1];
  }
  for (let t = out.length - 1; t >= 0; t--) {
    if (out[t].lo >= 0) continue;
    if (t + 1 < out.length && out[t + 1].lo >= 0) out[t] = out[t + 1];
  }
  return out;
}

/**
 * The timed words that belong to the display text when that is only a prefix of the spoken text (a streamed reply
 * whose later sentences are not revealed yet): words are kept until their letters cover the display letters.
 */
export function wordsWithinDisplay<T extends { text: string }>(words: readonly T[], display: string): T[] {
  const total = captionKey(display).length;
  const out: T[] = [];
  let sum = 0;
  for (const w of words) {
    if (sum >= total) break;
    out.push(w);
    sum += captionKey(w.text).length;
  }
  return out;
}

// Shows the spoken line with the current word highlighted. Re-renders on 'word' events only.
export function TeacherCaptions(props: { speech: TeacherSpeech | null; text: string; className?: string }) {
  const { speech, text, className } = props;
  const [current, setCurrent] = useState(-1);

  useEffect(() => {
    setCurrent(-1);
    if (!speech) return undefined;
    const offWord = speech.on('word', (i) => setCurrent(i));
    const offEnd = speech.on('end', () => setCurrent(-1));
    return () => {
      offWord();
      offEnd();
    };
  }, [speech]);

  // Exact match for a single line; a prefix of the speech text for a streamed reply that is revealed sentence by sentence.
  const exact = !!speech && speech.text === text;
  const prefix = !exact && !!speech && !!text && speech.text.startsWith(text);
  const words = exact ? speech!.words : prefix ? wordsWithinDisplay(speech!.words, text) : [];
  const timed = words.length > 0 && current >= 0;
  const wordCount = words.length; // speech.words grows in place as timestamps stream in

  const pieces = useMemo(() => text.split(/(\s+)/), [text]);
  const spans = useMemo(
    () => (wordCount ? alignCaptionWords(pieces.filter((p) => !/^\s*$/.test(p)), words.map((w) => w.text)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pieces, speech, wordCount, prefix],
  );

  // Align timed words to the display text; the live-region copy below carries the full line once.
  let body: JSX.Element | string = text;
  const span = timed ? spans[current] : undefined;
  if (span && span.lo >= 0) {
    let w = -1;
    body = (
      <>
        {pieces.map((piece, i) => {
          if (/^\s*$/.test(piece)) return piece;
          w += 1;
          const state = w < span.lo ? 'past' : w > span.hi ? 'upcoming' : 'current';
          return (
            <span
              key={i}
              className={`teacher-captions__word teacher-captions__word--${state}`}
              aria-current={state === 'current' ? 'true' : undefined}
            >
              {piece}
            </span>
          );
        })}
      </>
    );
  }

  return (
    <div className={['teacher-captions', className].filter(Boolean).join(' ')}>
      <p className="teacher-captions__sr" aria-live="polite">{text}</p>
      <p aria-hidden="true" style={{ margin: 0 }}>{body}</p>
    </div>
  );
}
