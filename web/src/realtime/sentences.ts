// Streaming sentence splitter for Ava's text deltas: the first sentence is handed to Cartesia as soon as its
// terminator and a following space arrive, so speech starts before the whole reply has streamed.

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'e.g', 'i.e']);
// A terminator run (. ! ? or an ellipsis), optional closing quotes/brackets, then whitespace.
const BOUNDARY = /([.!?…]+["'”’)\]]*)\s+/g;

export class SentenceSplitter {
  private buf = '';

  /** Add streamed text; returns any sentences completed by it (trimmed, non-empty). */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let start = 0;
    BOUNDARY.lastIndex = 0;
    for (let m = BOUNDARY.exec(this.buf); m; m = BOUNDARY.exec(this.buf)) {
      const end = m.index + m[1].length;
      const candidate = this.buf.slice(start, end);
      const lastWord = candidate.trim().split(/\s+/).pop()?.replace(/[.!?…"'”’)\]]+$/, '').toLowerCase() ?? '';
      if (m[1].startsWith('.') && ABBREVIATIONS.has(lastWord)) continue;
      const s = candidate.trim();
      if (s) out.push(s);
      start = m.index + m[0].length;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** End of the reply: return whatever is left as a final sentence. */
  flush(): string[] {
    const s = this.buf.trim();
    this.buf = '';
    return s ? [s] : [];
  }

  reset(): void {
    this.buf = '';
  }
}

/** Fraction of b's words that also appear in a (0..1), for the self-echo guard. */
export function wordOverlap(a: string, b: string): number {
  const words = (t: string) => t.toLowerCase().replace(/[^a-z'\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const pool = new Set(words(a));
  const wb = words(b);
  if (!wb.length) return 0;
  return wb.filter((w) => pool.has(w)).length / wb.length;
}
