import type { LessonSettings } from '@lesson-rules';

export function personName(value: string | null | undefined): string {
  const raw = (value || '').trim();
  if (!raw || raw === 'unknown') return 'Unknown';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function exerciseName(target: string | null | undefined): string {
  switch (target) {
    case 'i':
      return 'ee, as in see';
    case 'u':
      return 'oo, as in food';
    case 'a':
      return 'ah, as in father';
    case 'head':
      return 'head';
    default:
      return 'Unknown';
  }
}

export function formatName(context: string | null | undefined): string {
  switch (context) {
    case 'sound':
      return 'Isolated sound';
    case 'word':
      return 'Word';
    case 'phrase':
      return 'Phrase';
    default:
      return 'Unknown';
  }
}

export function supportName(assistance: string | null | undefined): string {
  switch (assistance) {
    case 'cue-target':
      return 'Cue and target';
    case 'target-only':
      return 'Target only';
    case 'none':
      return 'No extra support';
    default:
      return 'Unknown';
  }
}

export function cueName(cueId: string | null | undefined): string {
  switch (cueId) {
    case 'spread-lips':
      return 'Spread lips';
    case 'round-lips':
      return 'Round lips';
    case 'open-jaw':
      return 'Open jaw';
    case '':
      return 'No cue';
    default:
      return 'Unknown';
  }
}

export function findingName(finding: string | null | undefined): string {
  switch (finding) {
    case 'mouth_more_open':
      return 'Mouth stayed a little more closed than the reference';
    case 'mouth_less_open':
      return 'Mouth opened a little more than the reference';
    case 'tongue_forward':
      return 'Tongue sat a little further back than the reference';
    case 'tongue_back':
      return 'Tongue sat a little further forward than the reference';
    case 'finish':
      return 'The sound stopped early';
    case 'silence':
      return 'Not enough sound';
    case 'clipping':
      return 'Too loud';
    case 'too_short':
      return 'Too short';
    case 'no_mic':
      return 'No microphone';
    case 'insufficient':
      return 'Not enough to compare';
    case '':
    case 'none':
      return 'No measured result';
    default:
      return 'Unknown';
  }
}

export function activityName(presence: string | null | undefined): string {
  switch (presence) {
    case 'idle':
      return 'Ready';
    case 'recording':
      return 'Recording';
    case 'analyzing':
      return 'Checking the take';
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Activity unknown';
  }
}

export type ChangeRow = { label: string; before: string; after: string };

export function changedSettings(previous: LessonSettings | null, next: LessonSettings): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const before = previous;
  if (!before || before.target !== next.target) {
    rows.push({ label: 'Practice sound', before: before ? exerciseName(before.target) : 'Default plan', after: exerciseName(next.target) });
  }
  if (!before || before.context !== next.context) {
    rows.push({ label: 'Practice format', before: before ? formatName(before.context) : 'Isolated sound', after: formatName(next.context) });
  }
  if (!before || before.assistance !== next.assistance) {
    rows.push({ label: 'Support', before: before ? supportName(before.assistance) : 'Cue and target', after: supportName(next.assistance) });
  }
  if (!before || before.cueId !== next.cueId) {
    rows.push({ label: 'Practice cue', before: before ? cueName(before.cueId) : 'Spread lips', after: cueName(next.cueId) });
  }
  if (!before || before.referenceReplay !== next.referenceReplay) {
    rows.push({
      label: 'Reference',
      before: before ? (before.referenceReplay ? 'Sonic reference' : 'No reference') : 'No reference',
      after: next.referenceReplay ? 'Sonic reference' : 'No reference',
    });
  }
  if (!before || before.repetitions !== next.repetitions) {
    rows.push({
      label: 'Repetitions',
      before: before ? String(before.repetitions) : '1',
      after: String(next.repetitions),
    });
  }
  if (!before || before.note !== next.note) {
    rows.push({ label: 'Note', before: before?.note || 'None', after: next.note || 'None' });
  }
  return rows;
}

export function learnerInstruction(settings: LessonSettings): string {
  const replay = settings.referenceReplay
    ? 'A Sonic reference of this target is played and compared with the learner.'
    : 'No Sonic reference.';
  const note = settings.note ? ` Note: ${settings.note}` : '';
  return `Practice ${exerciseName(settings.target)}. Format: ${formatName(settings.context)}. Support: ${supportName(settings.assistance)}. Cue: ${cueName(settings.cueId)}. ${replay} Repeat ${settings.repetitions} ${settings.repetitions === 1 ? 'time' : 'times'}.${note}`;
}

export function plainChange(visible: string): string {
  return visible
    .replaceAll('Reference replay on', 'Sonic reference on')
    .replaceAll('Reference replay off', 'Sonic reference off')
    .replaceAll('Target ', 'Practice sound ')
    .replaceAll('Context ', 'Practice format ')
    .replaceAll('Assistance ', 'Support ')
    .replaceAll('Cue ', 'Practice cue ')
    .replaceAll('spread-lips', 'Spread lips')
    .replaceAll('round-lips', 'Round lips')
    .replaceAll('open-jaw', 'Open jaw')
    .replaceAll('cue-target', 'Cue and target')
    .replaceAll('target-only', 'Target only')
    .replaceAll(' -> ', ' to ')
    // 2026-10-24: older saves wrote the new side on both ends. The values differed, so the new side is the real one.
    .replaceAll('Reference on to on', 'Reference off to on')
    .replaceAll('Reference off to off', 'Reference on to off');
}

export function clockLabel(micros: bigint): string {
  if (micros === 0n) return 'Time unknown';
  const ms = Number(micros / 1000n);
  if (!Number.isFinite(ms) || ms <= 0) return 'Time unknown';
  return new Date(ms).toLocaleString();
}
