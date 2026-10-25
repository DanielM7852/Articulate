export type RoomStatus = {
  state: string;
  ready: boolean;
  updatedAt: number | null;
};

export function classReach(rows: { lessonSource: string }[]): { affected: number; own: number } {
  const own = rows.filter((row) => row.lessonSource === 'learner').length;
  return { affected: rows.length - own, own };
}

export function presenceWord(presence: string | null | undefined): string {
  switch (presence) {
    case 'idle':
      return 'Ready';
    case 'recording':
      return 'Recording';
    case 'analyzing':
      return 'Analyzing';
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Activity unknown';
  }
}

const SECRET = /token|secret|password|authorization|cookie|audio|wav/i;

/** Drops fields the public stream should not show in the console. */
export function publicPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET.test(key)) continue;
    if (key === 'sid') continue;
    out[key] = typeof value === 'string' && value.length > 180 ? `${value.slice(0, 180)}…` : value;
  }
  return out;
}

export function commandOf(payload: Record<string, unknown>): string {
  const value = payload.commandId ?? payload.command_id;
  return typeof value === 'string' ? value : '';
}

export type StreamStage = 'saved' | 'received' | 'applied';

export function observedStages(
  events: { kind: string; commandId: string }[],
  commandId: string,
): Record<StreamStage, boolean> {
  const mine = commandId ? events.filter((event) => event.commandId === commandId) : [];
  return {
    saved: mine.some((event) => event.kind === 'lesson.saved'),
    received: mine.some((event) => event.kind === 'lesson.received'),
    applied: mine.some((event) => event.kind === 'lesson.applied'),
  };
}
