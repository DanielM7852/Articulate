import { THINKING_FILLERS } from '../realtime/fillers';
import { PART_SOUND_LINES } from '../game/ghost/partSounds';

// The fixed lines Ava speaks from app start through the survey. They are prebaked into /voice (see
// scripts/bake_voice.ts) so playback costs no TTS credits. Any text not listed here still uses live Cartesia.
// Keep the strings byte-identical to what is spoken: the manifest is keyed by exact text.

export const GREETING = [
  'Hi, I’m Ava. I’ll show you each sound with my mouth, and you’ll see your own voice on the board.',
  'First, a quick survey so I know what to focus on.',
];

export const WELCOME_BACK = ['Welcome back. Let’s pick up where we left off.'];

export const QUESTIONS = {
  1: { title: 'What would you like to feel more comfortable with?', hint: 'Pick as many as you like.' },
  2: { title: 'Which sounds most like your routine?', hint: 'Then choose a pace that feels comfortable.' },
  3: { title: 'When a sound feels new, what helps you start?', hint: 'And how much guidance you’d like.' },
} as const;

/** The exact string the quiz narrates for a step. */
export const questionLine = (step: keyof typeof QUESTIONS): string => `${QUESTIONS[step].title} ${QUESTIONS[step].hint}`;

export const QUIZ_LINES: string[] = ([1, 2, 3] as const).map(questionLine);

/** Praise cues the lesson speaks after a good attempt; praise.ts picks among them. */
export const PRAISE_LINES: string[] = ['Great!', 'Good job!', 'Well done!', 'Nice!', "That's it!", 'Nicely done!', 'There you go!'];

export const BAKED_LINES: string[] = [...GREETING, ...WELCOME_BACK, ...QUIZ_LINES, ...THINKING_FILLERS, ...PART_SOUND_LINES, ...PRAISE_LINES];
