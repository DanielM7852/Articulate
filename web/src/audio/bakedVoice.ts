// Prebaked voice lines: static WAV + word/phoneme timings in /voice/manifest.json, written by scripts/bake_voice.ts.
// Everything here fails soft: a missing manifest or file just means the line is spoken live.

export interface TimedWord { text: string; start: number; end: number }
export interface TimedPhoneme { p: string; start: number; end: number }

export interface BakedEntry {
  file: string;
  durationS: number;
  words: TimedWord[];
  phonemes: TimedPhoneme[];
}

export type BakedManifest = Record<string, BakedEntry>;

const MANIFEST_URL = '/voice/manifest.json';

let manifest: BakedManifest | null = null;
let inflight: Promise<BakedManifest> | null = null;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Cartesia `timestamps` message block -> TimedWord[]. Shared by the live path's shape and the bake script. */
export function wordsFromBlock(block: unknown): TimedWord[] {
  const b = block as { words?: unknown; start?: unknown; end?: unknown } | undefined;
  if (!b || !Array.isArray(b.words)) return [];
  const starts = Array.isArray(b.start) ? b.start : [];
  const ends = Array.isArray(b.end) ? b.end : [];
  return b.words.map((w, i) => ({ text: String(w), start: num(starts[i]), end: num(ends[i]) }));
}

/** Cartesia `phoneme_timestamps` message block -> TimedPhoneme[]. */
export function phonemesFromBlock(block: unknown): TimedPhoneme[] {
  const b = block as { phonemes?: unknown; start?: unknown; end?: unknown } | undefined;
  if (!b || !Array.isArray(b.phonemes)) return [];
  const starts = Array.isArray(b.start) ? b.start : [];
  const ends = Array.isArray(b.end) ? b.end : [];
  return b.phonemes.map((p, i) => ({ p: String(p), start: num(starts[i]), end: num(ends[i]) }));
}

function isEntry(v: unknown): v is BakedEntry {
  const e = v as BakedEntry | null;
  return !!e && typeof e.file === 'string' && Array.isArray(e.words) && Array.isArray(e.phonemes);
}

/** Fetch the manifest once and cache it. Never rejects; failure caches an empty manifest. */
export function loadBakedManifest(): Promise<BakedManifest> {
  if (manifest) return Promise.resolve(manifest);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (typeof fetch === 'undefined') return {};
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) return {};
      const raw = (await res.json()) as Record<string, unknown>;
      const out: BakedManifest = {};
      for (const [text, entry] of Object.entries(raw ?? {})) if (isEntry(entry)) out[text] = entry;
      return out;
    } catch {
      return {};
    }
  })().then((m) => {
    manifest = m;
    return m;
  });
  return inflight;
}

/** Pure lookup: exact text, and only at normal speed (the baked audio is speed 1). */
export function lookupBaked(m: BakedManifest | null, text: string, speed?: number | null): BakedEntry | null {
  if (!m) return null;
  if (speed !== undefined && speed !== null && Math.abs(speed - 1) > 0.01) return null;
  return Object.prototype.hasOwnProperty.call(m, text) ? m[text] : null;
}

/** Synchronous lookup against the cached manifest (null until it has loaded). */
export function bakedEntry(text: string, speed?: number | null): BakedEntry | null {
  return lookupBaked(manifest, text, speed);
}

/** Wait up to `waitMs` for the manifest, then look up. Resolves null on timeout so the caller goes live. */
export async function bakedEntryReady(text: string, speed?: number | null, waitMs = 1500): Promise<BakedEntry | null> {
  if (speed !== undefined && speed !== null && Math.abs(speed - 1) > 0.01) return null;
  if (manifest) return lookupBaked(manifest, text, speed);
  const m = await Promise.race([
    loadBakedManifest(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
  ]);
  return lookupBaked(m, text, speed);
}
