// Short spoken fillers played while an attempt is being looked at, before the feedback. They must stay neutral:
// never hint at the result (no success/failure words, no numbers) and stay short. Add new lines to BAKED_LINES via
// this array (src/audio/bakedLines.ts) so a bake run covers them; unbaked lines fall back to live TTS.

export const THINKING_FILLERS: readonly string[] = [
  'One moment…',
  'Let me see…',
  'Okay, let me look…',
  'Give me a second…',
  'Let me look…',
  'Hmm, one second…',
];

/** A filler that differs from `last` (when the pool has more than one entry). `rand` is injectable for tests. */
export function pickFiller(last: string | null, rand: () => number = Math.random): string {
  const pool = THINKING_FILLERS.length > 1 ? THINKING_FILLERS.filter((f) => f !== last) : THINKING_FILLERS;
  const i = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
  return pool[i];
}
