export type LessonSnap = {
  revision: number;
  commandId: string;
  source: string;
  visible: string;
  settingsJson: string;
  ackPhase: string;
};

export type LessonDecision =
  | { kind: 'same' }
  | { kind: 'obsolete' }
  | { kind: 'pending'; lesson: LessonSnap }
  | { kind: 'apply'; lesson: LessonSnap; speak: false };

/**
 * An acknowledgment is application state, not comprehension.
 * Spoken coaching is never replayed from a lesson snapshot.
 */
export function decideLesson(input: {
  appliedRevision: number;
  incoming: LessonSnap | null;
  recording: boolean;
}): LessonDecision {
  const incoming = input.incoming;
  if (!incoming || incoming.revision <= 0 || incoming.source === 'default') return { kind: 'same' };
  if (incoming.revision < input.appliedRevision) return { kind: 'obsolete' };
  if (incoming.revision === input.appliedRevision) return { kind: 'same' };
  if (input.recording) return { kind: 'pending', lesson: incoming };
  return { kind: 'apply', lesson: incoming, speak: false };
}
