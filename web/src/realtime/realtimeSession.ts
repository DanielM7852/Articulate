// Ava realtime session: OpenAI Realtime over WebRTC, text output only. The browser gets an ephemeral client
// secret from our backend (POST /v1/realtime/session), sends its mic track to OpenAI for semantic VAD and input
// transcription, and receives events on the "oai-events" data channel. Ava's voice is Cartesia (see
// useAvaRealtime), so no remote audio track is played. The secret is only held in memory and never logged.

import { openAecMic } from '../conversation/audio/micAec';
import { emit as telemetryEmit } from '../telemetry/client';

/** Dashboard telemetry for the OpenAI speech-to-text leg (provider openai). Never affects the session. */
function sttTelemetry(source: 'mic' | 'stt', target: 'stt' | 'ui', kind: string, label: string, payload: Record<string, unknown>, model: string | null): void {
  try {
    telemetryEmit(source, target, kind, label, { ...payload, provider: 'openai', ...(model ? { model } : {}) });
  } catch { /* telemetry never breaks the session */ }
}

export interface RealtimeSecret {
  client_secret: string;
  expires_at: number;
  model: string;
  calls_url: string;
  session_id?: string | null;
}

export interface SemanticVad {
  type: 'semantic_vad';
  eagerness: 'low' | 'medium' | 'high' | 'auto';
  create_response: boolean;
  interrupt_response: boolean;
}

export const DEFAULT_TURN_DETECTION: SemanticVad = {
  type: 'semantic_vad',
  eagerness: 'medium',
  create_response: true,
  interrupt_response: true,
};

export type RealtimeState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

export interface FunctionCall {
  name: string;
  callId: string;
  itemId: string;
  responseId: string | null;
  /** Raw JSON string from the model. */
  rawArgs: string;
  /** Parsed arguments, or {} when the model sent invalid JSON. */
  args: Record<string, unknown>;
}

export interface RealtimeEvents {
  state: (state: RealtimeState) => void;
  /** Assistant text as it streams (response.output_text.delta). */
  textDelta: (e: { responseId: string; itemId: string; delta: string }) => void;
  /** Final assistant text for one content part (response.output_text.done). */
  textDone: (e: { responseId: string; itemId: string; text: string }) => void;
  responseCreated: (e: { responseId: string }) => void;
  /** status: completed | cancelled | incomplete | failed. functionCalls lists every call in that response. */
  responseDone: (e: { responseId: string; status: string; functionCalls: FunctionCall[] }) => void;
  /** One function_call output item finished streaming its arguments. */
  functionCall: (call: FunctionCall) => void;
  /** Learner transcription (conversation.item.input_audio_transcription.completed). */
  userTranscript: (e: { itemId: string; transcript: string }) => void;
  /** Semantic VAD detected the learner starting to speak (barge-in trigger). */
  speechStarted: (e: { itemId: string | null }) => void;
  speechStopped: (e: { itemId: string | null }) => void;
  error: (message: string) => void;
  /** Every server event, unparsed, for debugging. */
  event: (event: Record<string, unknown>) => void;
}

type Handlers = { [K in keyof RealtimeEvents]: Set<RealtimeEvents[K]> };

export interface RealtimeSessionOptions {
  /** Backend route that mints the ephemeral secret. */
  sessionUrl?: string;
  /** Learner profile; sent so the backend can add what Ava remembers about them to her instructions. */
  profileId?: string;
  /** Mic stream to send. Defaults to the echo-cancelled mic from micAec (so Ava's Cartesia voice is suppressed). */
  micStream?: MediaStream;
  /** Turn detection restored when practice mode ends; must match what the backend baked into the secret. */
  turnDetection?: SemanticVad;
  /** How long setPracticeMode waits for session.updated before rejecting. */
  updateTimeoutMs?: number;
}

const SECRET_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toCall(item: Record<string, unknown>, responseId: string | null): FunctionCall {
  const rawArgs = str(item.arguments);
  return { name: str(item.name), callId: str(item.call_id), itemId: str(item.id), responseId, rawArgs, args: parseArgs(rawArgs) };
}

export class RealtimeSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private sender: RTCRtpSender | null = null;
  private ownedMic: { close(): void } | null = null;
  private handlers: Handlers = {
    state: new Set(), textDelta: new Set(), textDone: new Set(), responseCreated: new Set(), responseDone: new Set(),
    functionCall: new Set(), userTranscript: new Set(), speechStarted: new Set(), speechStopped: new Set(),
    error: new Set(), event: new Set(),
  };
  private _state: RealtimeState = 'idle';
  // Starts gated: practice mode is in effect from the first track, so nothing the learner or the speakers produce can
  // start a response until the lesson calls setPracticeMode(false).
  private gates = { practice: true, playback: false };
  private activeResponse: string | null = null;
  private pendingUpdates: Array<{
    eventId: string;
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private updateSeq = 0;
  /** First assistant message item of each response, and each item's previous_item_id (for history repair). */
  private assistantItems = new Map<string, string>();
  private itemPrev = new Map<string, string | null>();
  private readonly opts: Required<Omit<RealtimeSessionOptions, 'micStream' | 'profileId'>> & { micStream?: MediaStream; profileId?: string };
  model: string | null = null;

  constructor(options: RealtimeSessionOptions = {}) {
    this.opts = {
      sessionUrl: options.sessionUrl ?? '/v1/realtime/session',
      profileId: options.profileId,
      micStream: options.micStream,
      turnDetection: options.turnDetection ?? DEFAULT_TURN_DETECTION,
      updateTimeoutMs: options.updateTimeoutMs ?? 5000,
    };
  }

  get state(): RealtimeState {
    return this._state;
  }

  get practiceMode(): boolean {
    return this.gates.practice;
  }

  /** The response currently generating, if any. */
  get responding(): string | null {
    return this.activeResponse;
  }

  on<K extends keyof RealtimeEvents>(ev: K, fn: RealtimeEvents[K]): () => void {
    (this.handlers[ev] as Set<RealtimeEvents[K]>).add(fn);
    return () => { (this.handlers[ev] as Set<RealtimeEvents[K]>).delete(fn); };
  }

  private emit<K extends keyof RealtimeEvents>(ev: K, ...args: Parameters<RealtimeEvents[K]>): void {
    for (const fn of [...this.handlers[ev]]) {
      try { (fn as (...a: Parameters<RealtimeEvents[K]>) => void)(...args); } catch { /* listener errors never break the session */ }
    }
  }

  private setState(s: RealtimeState): void {
    if (this._state === s) return;
    const prev = this._state;
    this._state = s;
    if (s === 'open') sttTelemetry('mic', 'stt', 'stt.open', 'realtime session open', {}, this.model);
    else if (prev === 'open') sttTelemetry('mic', 'stt', 'stt.close', 'realtime session closed', {}, this.model);
    this.emit('state', s);
  }

  // ---- lifecycle

  async connect(): Promise<void> {
    if (this._state === 'connecting' || this._state === 'open') return;
    this.setState('connecting');
    try {
      const secret = await this.fetchSecret();
      this.model = secret.model;
      let stream = this.opts.micStream;
      if (!stream) {
        const mic = await openAecMic();
        this.ownedMic = mic;
        stream = mic.stream;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No microphone track.');

      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.sender = pc.addTrack(track, stream);
      this.applyGates(); // the outgoing track is disabled before any audio can be sent
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = (m) => this.onServerMessage(m.data);
      dc.onclose = () => { if (this._state === 'open') this.setState('closed'); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') this.fail('Realtime connection failed.');
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), CONNECT_TIMEOUT_MS);
      let answer: string;
      try {
        const res = await fetch(secret.calls_url, {
          method: 'POST',
          body: offer.sdp ?? '',
          headers: { Authorization: `Bearer ${secret.client_secret}`, 'Content-Type': 'application/sdp' },
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`Realtime call rejected (${res.status}).`);
        answer = await res.text();
      } finally {
        clearTimeout(timer);
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      await new Promise<void>((resolve, reject) => {
        if (dc.readyState === 'open') { resolve(); return; }
        const t = setTimeout(() => reject(new Error('Realtime data channel did not open.')), CONNECT_TIMEOUT_MS);
        dc.onopen = () => { clearTimeout(t); resolve(); };
      });
      // Turn detection off and the input buffer cleared before connect() resolves (the track is already disabled).
      await this.setPracticeMode(true);
      this.setState('open');
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'Realtime connection failed.');
      throw err;
    }
  }

  disconnect(): void {
    for (const p of this.pendingUpdates) { clearTimeout(p.timer); p.reject(new Error('Session closed.')); }
    this.pendingUpdates = [];
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    this.ownedMic?.close();
    this.ownedMic = null;
    this.dc = null;
    this.pc = null;
    this.sender = null;
    this.activeResponse = null;
    this.assistantItems.clear();
    this.itemPrev.clear();
    this.setState('closed');
  }

  private fail(message: string): void {
    this.emit('error', message);
    this.disconnect();
    this.setState('failed');
  }

  private async fetchSecret(): Promise<RealtimeSecret> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SECRET_TIMEOUT_MS);
    try {
      const init: RequestInit = { method: 'POST', signal: ctl.signal };
      if (this.opts.profileId) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify({ profileId: this.opts.profileId });
      }
      const res = await fetch(this.opts.sessionUrl, init);
      if (!res.ok) throw new Error(`Realtime session request failed (${res.status}).`);
      const j = (await res.json()) as RealtimeSecret;
      if (!j || typeof j.client_secret !== 'string' || !j.client_secret || typeof j.calls_url !== 'string') {
        throw new Error('Realtime session response was empty.');
      }
      return j;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- client events

  /** Send one client event. Returns false when the channel is not open. */
  send(event: Record<string, unknown>): boolean {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  private applyGates(): void {
    const track = this.sender?.track;
    if (track) track.enabled = !this.gates.practice && !this.gates.playback;
  }

  /** Mute the outgoing mic while Ava speaks (echo fallback when AEC is not enough; disables barge-in). */
  setPlaybackMute(on: boolean): void {
    this.gates.playback = on;
    this.applyGates();
  }

  /**
   * Practice gate. On: turn detection off (no auto responses, no barge-in), mic track disabled, buffer cleared,
   * any in-flight response cancelled. Off: mic restored and semantic VAD re-enabled. Resolves on session.updated.
   */
  setPracticeMode(on: boolean): Promise<void> {
    this.gates.practice = on;
    this.applyGates();
    if (on) {
      this.cancelResponse();
      this.send({ type: 'input_audio_buffer.clear' });
    }
    return this.updateSession({ audio: { input: { turn_detection: on ? null : this.opts.turnDetection } } });
  }

  /** session.update with a partial session; resolves on the next session.updated, rejects on timeout/error. */
  updateSession(partial: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const eventId = `upd_${++this.updateSeq}`;
      if (!this.send({ type: 'session.update', event_id: eventId, session: { type: 'realtime', ...partial } })) {
        reject(new Error('Realtime session is not open.'));
        return;
      }
      const entry = {
        eventId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingUpdates = this.pendingUpdates.filter((p) => p !== entry);
          reject(new Error('session.update was not acknowledged.'));
        }, this.opts.updateTimeoutMs),
      };
      this.pendingUpdates.push(entry);
    });
  }

  /** Cancel the response in progress, if any (barge-in, practice start). Harmless when idle. */
  cancelResponse(): void {
    if (!this.activeResponse) return;
    this.send({ type: 'response.cancel', response_id: this.activeResponse });
  }

  /** Add a typed learner message and ask for a response (text fallback when the mic is off). */
  sendUserText(text: string): void {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'response.create' });
  }

  /**
   * Hand Ava a result to relay: a system message with the result text (plus optional per-turn instructions,
   * appended so the session persona instructions stay in force), then response.create.
   */
  injectResult(text: string, instructions?: string): void {
    this.sendSystemMessage(instructions ? `${text}\n\n${instructions}` : text, true);
  }

  /** Add a system message from the app ("[app] " prefix, never doubled) and optionally ask for a response. */
  sendSystemMessage(text: string, respond: boolean): void {
    const body = text.startsWith('[app]') ? text : `[app] ${text}`;
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: body }] } });
    if (respond) this.send({ type: 'response.create' });
  }

  /**
   * Return a function result to the model. With respond (default), also asks for the follow-up response; when a
   * response carried several calls, submit all with respond:false and call requestResponse() once.
   */
  submitToolResult(callId: string, output: unknown, opts: { respond?: boolean } = {}): void {
    const json = typeof output === 'string' ? output : JSON.stringify(output);
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: json } });
    if (opts.respond ?? true) this.requestResponse();
  }

  requestResponse(): void {
    this.send({ type: 'response.create' });
  }

  /** Remove a conversation item (for example a learner turn that turned out to be Ava's own echo). */
  deleteItem(itemId: string): void {
    this.send({ type: 'conversation.item.delete', item_id: itemId });
  }

  /** The assistant message item (type 'message') of a response, once the server announced it. */
  assistantItemFor(responseId: string): string | null {
    return this.assistantItems.get(responseId) ?? null;
  }

  /**
   * Replace an assistant message with only what was heard: delete it, then (heard non-empty) re-create it at the same
   * position (previous_item_id of the deleted item, 'root' for the first item; position unknown = delete only) as "<heard> —".
   * The re-created item gets a client-generated id, and every item that followed the deleted one is re-pointed at it
   * (or at the deleted item's own predecessor on delete-only), so a second repair still knows its position.
   * Empty heard just deletes.
   */
  replaceAssistantText(itemId: string, heard: string): void {
    if (!itemId) return;
    const known = this.itemPrev.has(itemId);
    const prev = this.itemPrev.get(itemId);
    this.itemPrev.delete(itemId);
    for (const [r, i] of this.assistantItems) if (i === itemId) this.assistantItems.delete(r);
    this.send({ type: 'conversation.item.delete', item_id: itemId });
    const text = heard.trim();
    // Position unknown: re-creating would append the shortened reply after later items, so only delete.
    if (!known) return;
    if (!text) {
      for (const [k, v] of this.itemPrev) if (v === itemId) this.itemPrev.set(k, prev ?? null);
      return;
    }
    // "item_" prefix and <= 32 chars: the shape the server's own ids have (the SDK types only say the id may be client-provided).
    const newId = `item_rep${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`.slice(0, 32);
    for (const [k, v] of this.itemPrev) if (v === itemId) this.itemPrev.set(k, newId);
    this.itemPrev.set(newId, prev ?? null);
    const event: Record<string, unknown> = {
      type: 'conversation.item.create',
      item: { id: newId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${text} —` }] },
    };
    // First item of the conversation (previous_item_id null): 'root' inserts at the beginning (OpenAI client events).
    event.previous_item_id = prev ?? 'root';
    this.send(event);
  }

  /** Remember the first assistant message item of a response. */
  private noteAssistantItem(responseId: string, item: Record<string, unknown> | undefined): void {
    if (item && item.type === 'message' && responseId && str(item.id) && !this.assistantItems.has(responseId)) {
      this.assistantItems.set(responseId, str(item.id));
      this.remember(this.assistantItems);
    }
  }

  private remember(map: Map<string, unknown>): void {
    // Bounded: only recent items matter for a barge-in.
    while (map.size > 200) map.delete(map.keys().next().value as string);
  }

  // ---- server events

  private onServerMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    this.emit('event', ev);
    switch (ev.type) {
      case 'session.updated': {
        const p = this.pendingUpdates.shift();
        if (p) { clearTimeout(p.timer); p.resolve(); }
        break;
      }
      case 'response.created': {
        const r = ev.response as Record<string, unknown> | undefined;
        this.activeResponse = str(r?.id) || null;
        if (this.activeResponse) this.emit('responseCreated', { responseId: this.activeResponse });
        break;
      }
      case 'response.output_text.delta':
        this.emit('textDelta', { responseId: str(ev.response_id), itemId: str(ev.item_id), delta: str(ev.delta) });
        break;
      case 'response.output_text.done':
        this.emit('textDone', { responseId: str(ev.response_id), itemId: str(ev.item_id), text: str(ev.text) });
        break;
      case 'conversation.item.added':
      case 'conversation.item.created':
      case 'conversation.item.done': {
        // GA: added/done; beta: created. All carry previous_item_id.
        const item = ev.item as Record<string, unknown> | undefined;
        const id = str(item?.id);
        const prev = ev.previous_item_id;
        if (id && (typeof prev === 'string' || prev === null) && (prev !== null || !this.itemPrev.has(id))) {
          this.itemPrev.set(id, prev);
          this.remember(this.itemPrev);
        }
        break;
      }
      case 'response.output_item.added': {
        this.noteAssistantItem(str(ev.response_id), ev.item as Record<string, unknown> | undefined);
        break;
      }
      case 'response.output_item.done': {
        const item = ev.item as Record<string, unknown> | undefined;
        this.noteAssistantItem(str(ev.response_id), item);
        if (item && item.type === 'function_call') this.emit('functionCall', toCall(item, str(ev.response_id) || null));
        break;
      }
      case 'response.done': {
        const r = (ev.response ?? {}) as Record<string, unknown>;
        const id = str(r.id);
        if (this.activeResponse === id) this.activeResponse = null;
        const output = Array.isArray(r.output) ? (r.output as Record<string, unknown>[]) : [];
        const calls = output.filter((o) => o && o.type === 'function_call').map((o) => toCall(o, id || null));
        this.emit('responseDone', { responseId: id, status: str(r.status) || 'completed', functionCalls: calls });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
        this.emit('userTranscript', { itemId: str(ev.item_id), transcript: str(ev.transcript) });
        {
          const heard = str(ev.transcript).trim();
          sttTelemetry('stt', 'ui', 'stt.transcript', `heard ${heard.slice(0, 40)}`, { text: heard.slice(0, 80), final: true }, this.model);
        }
        break;
      case 'input_audio_buffer.speech_started':
        this.emit('speechStarted', { itemId: str(ev.item_id) || null });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('speechStopped', { itemId: str(ev.item_id) || null });
        break;
      case 'error': {
        const e = (ev.error ?? {}) as Record<string, unknown>;
        // response.cancel with nothing to cancel is expected noise.
        if (str(e.code) === 'response_cancel_not_active') break;
        const failed = this.pendingUpdates.find((p) => p.eventId === str(e.event_id));
        if (failed) {
          this.pendingUpdates = this.pendingUpdates.filter((p) => p !== failed);
          clearTimeout(failed.timer);
          failed.reject(new Error(str(e.message) || 'session.update was rejected.'));
        }
        this.emit('error', str(e.message) || 'Realtime error.');
        break;
      }
      default:
        break;
    }
  }
}
