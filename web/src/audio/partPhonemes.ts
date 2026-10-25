// Phoneme timelines for the prebaked part sounds. Cartesia hallucinates phonemes for inline-IPA transcripts, so for
// those we derive the timeline from the IPA we asked for, spread over the audible span of the clip.

const STOPS = new Set(['p', 'b', 't', 'd', 'k', 'g', 'ɡ', 'ʔ']);
const STOP_SLOT_S = 0.06;

/** The symbols of a transcript that is exactly one `<<a|b|c>>` group (stress marks dropped), else null. */
export function ipaSymbols(say: string): string[] | null {
  const m = /^<<([^<>]+)>>$/.exec(say.trim());
  if (!m) return null;
  const symbols = m[1].split('|').map((s) => s.replace(/[ˈˌ]/g, '').trim()).filter(Boolean);
  return symbols.length ? symbols : null;
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

/** Stops get a short slot, the rest of the span is split evenly among the other symbols. Contiguous, within [onsetS, endS]. */
export function spreadPhonemes(
  symbols: string[],
  onsetS: number,
  endS: number,
  opts: { cut?: number } = {},
): { p: string; start: number; end: number }[] {
  const syms = opts.cut != null ? symbols.slice(0, Math.max(0, opts.cut)) : symbols;
  if (!syms.length) return [];
  const span = Math.max(0, endS - onsetS);
  const stopCount = syms.filter((s) => STOPS.has(s)).length;
  const otherCount = syms.length - stopCount;
  let stopSlot = Math.min(STOP_SLOT_S, span / syms.length);
  if (otherCount === 0) stopSlot = span / syms.length;
  const otherSlot = otherCount ? Math.max(0, span - stopSlot * stopCount) / otherCount : 0;
  const out: { p: string; start: number; end: number }[] = [];
  let t = onsetS;
  syms.forEach((p, i) => {
    const start = i === 0 ? ms(onsetS) : out[i - 1].end;
    t += STOPS.has(p) ? stopSlot : otherSlot;
    out.push({ p, start, end: i === syms.length - 1 ? ms(endS) : ms(Math.min(endS, Math.max(start, t))) });
  });
  return out;
}
