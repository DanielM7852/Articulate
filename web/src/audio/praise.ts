import { PRAISE_LINES as LINES } from './bakedLines';

export const PRAISE_LINES: readonly string[] = LINES;

let last = '';

/** A random praise line that is never the same as the previous pick. Always a member of PRAISE_LINES. */
export function pickPraise(rand: () => number = Math.random): string {
  const pool = PRAISE_LINES.filter((l) => l !== last);
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  last = pool[i];
  return last;
}
