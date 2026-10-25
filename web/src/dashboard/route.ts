import type { NodeId } from '../telemetry/client';

/**
 * Nodes on the live graph: the reducer's twelve ids plus the parts the app runs that the deployed reducer has no id
 * for. Those are told apart by event kind and payload (docs/telemetry.md), never by source / target.
 */
export type GraphId = NodeId | 'realtime' | 'phones' | 'azure' | 'classroom' | 'head' | 'recap';

/** Where a route can end: a node, or the recap's email (Resend has no node; the email shows on the Recap card). */
export type RouteEnd = GraphId | 'email';

export interface RoutableEvent {
  kind: string;
  source: string;
  target: string;
  payload?: Record<string, unknown> | null;
}

/** The two speech-to-text services: OpenAI Realtime (word lesson) and Cartesia Ink (hands-free practice). */
export type SttNode = 'realtime' | 'stt';

/** stt.* rows name their service in `provider`; rows from before the field existed all came from Cartesia Ink. */
export function sttNodeOf(payload: Record<string, unknown> | null | undefined): SttNode {
  const v = payload?.provider;
  return typeof v === 'string' && v.toLowerCase() === 'openai' ? 'realtime' : 'stt';
}

/**
 * The graph edge an event travels, [from, to]. Used for packets, ripples and the per-node counters.
 * - stt.*: the `stt` end becomes Realtime or Ink by `provider` (missing or unknown: Ink, so backfill keeps its route).
 * - phones.*: the learner's tab and the GPU phone service; frames come back to the tab, everything else goes out.
 * - azure.*: backend to Azure for request / skipped, Azure back to the backend for result / error.
 * - classroom.*, lesson.*: to the classroom database, from the backend or the browser by `source`.
 * - head.*: Sonic drives the head while it speaks; anything else (ready) comes from the learner's screen.
 * - claude.*: the backend's calls keep source -> target, except purpose `recap` (the session recap), which runs
 *   between the model and the Recap node: the request goes out, the response or error comes back.
 * - recap.*: the learner asks for a recap (start) and gets it, or a refusal, back (ready, error, limited); the email
 *   attempt (email, email_skipped) leaves the recap for 'email', which has no node.
 * - everything else: the event's own source -> target.
 */
export function routeOf(e: RoutableEvent): [GraphId, RouteEnd] {
  const dot = e.kind.indexOf('.');
  const family = dot < 0 ? e.kind : e.kind.slice(0, dot);
  const verb = dot < 0 ? '' : e.kind.slice(dot + 1);
  const source = e.source as GraphId;
  const target = e.target as GraphId;
  switch (family) {
    case 'stt': {
      const node = sttNodeOf(e.payload);
      return [source === 'stt' ? node : source, target === 'stt' ? node : target];
    }
    case 'phones':
      return verb === 'frame' ? ['phones', 'ui'] : ['ui', 'phones'];
    case 'azure':
      return verb === 'result' || verb === 'error' ? ['azure', 'backend'] : ['backend', 'azure'];
    case 'classroom':
    case 'lesson':
      return [source === 'backend' ? 'backend' : 'ui', 'classroom'];
    case 'head':
      return verb === 'speak' ? ['tts', 'head'] : ['ui', 'head'];
    case 'claude':
      if (e.payload?.purpose !== 'recap') return [source, target];
      return verb === 'request' ? ['recap', 'claude'] : ['claude', 'recap'];
    case 'recap':
      if (verb === 'start') return ['ui', 'recap'];
      return verb === 'email' || verb === 'email_skipped' ? ['recap', 'email'] : ['recap', 'ui'];
    default:
      return [source, target];
  }
}
