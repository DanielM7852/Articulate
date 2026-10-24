import { FIRST_BEATMAP, type Segment, type Step } from './beatmap';
import { VOWELS, type VowelId, type ZoneSet } from './zones';

export interface Lesson {
  id: string;
  title: string;
  description: string;
  caveat?: string;
  steps: Step[];
  calibration: readonly VowelId[];
  lockReason?: string;
}

const hold = (word: string, vowel: VowelId, segments: Segment[]): Step => ({
  id: word, word, segments, note: { kind: 'hold', vowel, holdMs: 700 },
});
const cue = (letters: string): Segment => ({ letters, cue: 'letter cue' });
const vowel = (letters: string, ...sounds: VowelId[]): Segment => ({ letters, sounds });
const glide = (word: string, from: VowelId, to: VowelId, segments: Segment[], caveat?: string): Step => ({
  id: word, word, segments, note: { kind: 'glide', from, to }, caveat,
});

/** Word prompts are stylized routes through personal zones, not models of ordinary speech. */
export const LESSONS: readonly Lesson[] = [
  {
    id: 'starter', title: 'First route',
    description: 'One hold and three slides to learn the controls: ah, hi, how, we.',
    caveat: 'Stretch the vowel sounds to visit each zone. Everyday words often stop short of these endpoints.',
    steps: FIRST_BEATMAP, calibration: VOWELS,
  },
  {
    id: 'sweep', title: 'Front–back sweep',
    description: 'Move oo → eee, then compare the vowel zones in key / coo and tea / two.',
    caveat: 'The w in “we” is a consonant cue; oo → eee is an approximate movement route. Only the vowel zones count.',
    calibration: VOWELS,
    steps: [
      glide('we', 'oo', 'ee', [cue('w'), vowel('e', 'oo', 'ee')]),
      hold('key', 'ee', [cue('k'), vowel('ey', 'ee')]),
      hold('coo', 'oo', [cue('c'), vowel('oo', 'oo')]),
      hold('tea', 'ee', [cue('t'), vowel('ea', 'ee')]),
      hold('two', 'oo', [cue('tw'), vowel('o', 'oo')]),
    ],
  },
  {
    id: 'glides', title: 'Glide routes',
    description: 'Trace ah → eee for hi / buy and ah → oo for how / now.',
    caveat: 'These are stretched game routes. Your everyday diphthongs need not reach the held eee or oo zones.',
    calibration: VOWELS,
    steps: [
      glide('hi', 'ah', 'ee', [cue('h'), vowel('i', 'ah', 'ee')]),
      glide('buy', 'ah', 'ee', [cue('b'), vowel('uy', 'ah', 'ee')]),
      glide('how', 'ah', 'oo', [cue('h'), vowel('ow', 'ah', 'oo')]),
      glide('now', 'ah', 'oo', [cue('n'), vowel('ow', 'ah', 'oo')], 'The n is not judged. Nasal humming can still move the dot; focus on the stretched vowel route.'),
    ],
  },
  {
    id: 'boy', title: 'Boy route · extra zone',
    description: 'Set the stretched starting sound of boy, then glide from that aw zone to eee.',
    caveat: 'The aw label is a prompt for your own starting sound. It is never copied from ah or a textbook point.',
    calibration: ['aw', 'ee'],
    steps: [glide('boy', 'aw', 'ee', [cue('b'), vowel('oy', 'aw', 'ee')])],
  },
  {
    id: 'ladder', title: 'Front-vowel set',
    description: 'Compare the held vowels in beat, bit, bet and bat. Set every zone with your own voice first.',
    caveat: 'Your voice and accent set the positions. The four zones do not have to form a textbook ladder.',
    calibration: ['ee', 'ih', 'eh', 'ae'],
    steps: [
      hold('beat', 'ee', [cue('b'), vowel('ea', 'ee'), cue('t')]),
      hold('bit', 'ih', [cue('b'), vowel('i', 'ih'), cue('t')]),
      hold('bet', 'eh', [cue('b'), vowel('e', 'eh'), cue('t')]),
      hold('bat', 'ae', [cue('b'), vowel('a', 'ae'), cue('t')]),
    ],
  },
  {
    id: 'nasals', title: 'Rent / ween · locked',
    description: 'A future word contrast with nasal endings.',
    calibration: [], steps: [],
    lockReason: 'Nasal endings can still appear as vowel positions. This lesson stays locked until nasal rejection is validated.',
  },
];

export type LessonAvailability =
  | { kind: 'ready' }
  | { kind: 'calibrate'; vowels: readonly VowelId[] }
  | { kind: 'locked'; reason: string };

export function lessonAvailability(lesson: Lesson, zones: ZoneSet | null): LessonAvailability {
  if (lesson.lockReason) return { kind: 'locked', reason: lesson.lockReason };
  if (lesson.calibration.some((vowel) => !zones?.[vowel])) return { kind: 'calibrate', vowels: lesson.calibration };
  return { kind: 'ready' };
}

/** Show just this lesson's own targets, keeping unrelated calibration zones out of the playfield. */
export function lessonZones(lesson: Lesson, zones: ZoneSet): ZoneSet {
  return Object.fromEntries(lesson.calibration.flatMap((vowel) => zones[vowel] ? [[vowel, zones[vowel]]] : []));
}
