/**
 * "MVP demo" build switch (VITE_DEMO_MVP=true): no survey, and only the words track, sheep, rent,
 * in that order. Unset or any other value leaves the full app untouched.
 */
export const DEMO_WORDS = ['track', 'sheep', 'rent'] as const;

function viteEnv(): string | undefined {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_DEMO_MVP;
}

export const DEMO_MVP: boolean = viteEnv() === 'true';

/** The lesson's word keys: the demo list (only keys that exist) when `demo`, else `all` unchanged. */
export function lessonWordKeys(all: string[], demo: boolean = DEMO_MVP): string[] {
  return demo ? DEMO_WORDS.filter((w) => all.includes(w)) : all;
}
