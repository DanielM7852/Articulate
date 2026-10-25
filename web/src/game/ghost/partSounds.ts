/**
 * What Ava says out loud when she pronounces one lesson part. `say` is the exact Cartesia transcript (inline IPA in
 * <<...>>, see docs.cartesia.ai custom pronunciations); it is prebaked into /voice by scripts/bake_voice.ts, so keep
 * it byte-identical. `caption` is what the learner reads, and what a browser-speech fallback says instead of the markup.
 * `at` is the side-view cue phase where the sound starts, so the audio lands on the release in the tongue animation:
 * a stop sounds on its release ('relax'), a two-pose cue on its glide ('glide'), a vowel or continuant on 'hold'.
 */
export type SoundPhase = 'hold' | 'glide' | 'relax';

export interface PartSound {
  say: string;
  caption: string;
  at: SoundPhase;
}

/** Keyed by word, then lesson part id (words.ts parts). */
export const PART_SOUNDS: Record<string, Record<string, PartSound>> = {
  track: {
    tr: { say: '<<t|ɹ|æ>>', caption: 'tra', at: 'glide' },
    a: { say: '<<æ|t>>', caption: 'a', at: 'hold' },
    ck: { say: '<<k|ʌ>>', caption: 'ck', at: 'relax' },
  },
  sheep: {
    sh: { say: '<<ʃ|ʃ|ʃ>>', caption: 'sh', at: 'hold' },
    ee: { say: 'eee', caption: 'ee', at: 'hold' },
    p: { say: '<<p|ʌ>>', caption: 'p', at: 'relax' },
  },
  rent: {
    r: { say: 'rrr', caption: 'r', at: 'hold' },
    e: { say: '<<ɛ|ʔ>>', caption: 'e', at: 'hold' },
    nt: { say: 'nt', caption: 'nt', at: 'hold' },
  },
  brain: {
    br: { say: '<<b|ɹ|ʌ>>', caption: 'br', at: 'hold' },
    ai: { say: '<<e|ɪ>>', caption: 'ai', at: 'hold' },
    n: { say: '<<n|ɑ>>', caption: 'n', at: 'hold' },
  },
};

export function partSound(word: string, partId: string): PartSound | null {
  return PART_SOUNDS[word]?.[partId] ?? null;
}

/** Every transcript to prebake. */
export const PART_SOUND_LINES: string[] = Object.values(PART_SOUNDS).flatMap((parts) => Object.values(parts).map((s) => s.say));
