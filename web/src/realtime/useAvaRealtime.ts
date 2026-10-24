import { useCallback, useEffect, useRef, useState } from 'react';
import { speakTeacher, type TeacherSpeech } from '../audio/teacher';
import { RealtimeSession, type FunctionCall, type RealtimeSessionOptions, type RealtimeState } from './realtimeSession';
import { SentenceSplitter, wordOverlap } from './sentences';

/**
 * Ava as one realtime persona: OpenAI Realtime writes every line (text only), Cartesia speaks it through
 * speakTeacher, sentence by sentence as the text streams. Captions and lip sync come from the TeacherSpeech
 * word/phoneme timestamps (onSpeech / speech), never from the model text directly.
 *
 * teacher.ts opens one Cartesia context per call (continue: false) and speakTeacher cancels the previous speech,
 * so sentences are queued and each one starts when the previous one ends (the idle socket keeps the gap short).
 *
 * Tools: get_coaching is answered by the caller's getCoaching (the lesson posts to the backend coach);
 * start_practice / end_practice are intercepted here and only notify the caller. learner_attempt / stay_quiet are
 * silent (no follow-up response, the rest of that response is discarded); learner_attempt also notifies the caller.
 * ask_coach is answered by the caller's askCoach and then relayed by Ava. The lesson owns the mic gate (the session
 * starts gated): setPracticeMode(true) at attempt start, attemptFinished(attemptId) (or relayResult) at the end.
 *
 * One voice: canSpeak() is checked on every text delta and before every speakTeacher call. When it is false the
 * response is dropped and cancelled and the queue is cleared, so Ava can never talk over a scripted line.
 *
 * Echo: the mic sent to OpenAI is the echo-cancelled track from micAec, but Chrome AEC removes only ~8 dB of Web
 * Audio TTS, so Ava's own voice can trip semantic VAD. Two guards: a transcript that mostly repeats what Ava just
 * said is deleted and its response cancelled, and muteMicWhileSpeaking (off by default) mutes the mic during
 * playback at the cost of barge-in. Headphones avoid the problem entirely.
 */

export interface AvaCoaching {
  caption: string;
  focusZoneId: string | null;
  [key: string]: unknown;
}

export interface UseAvaRealtimeOptions {
  /** Coaching for a finished attempt (the lesson posts to the backend coach). */
  getCoaching: (attemptId: string) => Promise<AvaCoaching>;
  /** Ava called start_practice(word): show the word and arm the attempt. */
  onStartPractice?: (word: string) => void;
  /** Ava called end_practice(). */
  onEndPractice?: () => void;
  /** Every spoken sentence, for captions and guide lip sync (same pattern as useCoachSequence). */
  onSpeech?: (speech: TeacherSpeech, text: string) => void;
  onUserTranscript?: (text: string) => void;
  /** The learner started speaking (semantic VAD) while not in practice mode. Fires even when bargeIn is off. */
  onLearnerSpeech?: () => void;
  /** Ava may speak only while this returns true (default always). Checked per text delta and per queued sentence. */
  canSpeak?: () => boolean;
  /** Ava called learner_attempt(): the learner's last utterance was an attempt at the word (the board scores it). */
  onLearnerAttempt?: () => void;
  /** Ava called ask_coach(question): answer it (the lesson asks the backend coach). */
  askCoach?: (question: string) => Promise<{ say: string }>;
  sessionOptions?: RealtimeSessionOptions;
  speed?: number;
  /** Stop Ava when the learner starts speaking. Default true. */
  bargeIn?: boolean;
  /** Mute the outgoing mic while Ava speaks (disables barge-in). Default false. */
  muteMicWhileSpeaking?: boolean;
}

const ECHO_WINDOW_MS = 4000;
const ECHO_OVERLAP = 0.6;

/** A response we asked for (or VAD will start) counts as pending this long while waiting for response.created. */
const PENDING_EXPIRY_MS = 6000;
const IDLE_POLL_MS = 80;

/** Tools that only classify what the learner said; the model must stay silent after them. */
const SILENT_TOOLS = new Set(['learner_attempt', 'stay_quiet']);
const ASK_UNAVAILABLE = { unavailable: true, say: "I couldn't reach the coach just now. Let's keep practising." };

const RESULT_INSTRUCTIONS =
  'Relay this caption to the learner in your own words, in one or two short sentences. Keep its meaning and direction. ' +
  'Do not add numbers, anatomy or new instructions. End with a short invitation to try again.';

export function useAvaRealtime(options: UseAvaRealtimeOptions) {
  const opts = useRef(options);
  opts.current = options;

  const [state, setState] = useState<RealtimeState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [speech, setSpeech] = useState<TeacherSpeech | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [practice, setPractice] = useState(false);
  const [lastUserTranscript, setLastUserTranscript] = useState<string | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const queue = useRef<{ items: string[]; running: boolean; current: TeacherSpeech | null; gen: number }>({
    items: [], running: false, current: null, gen: 0,
  });
  const splitters = useRef(new Map<string, SentenceSplitter>());
  const dropped = useRef(new Set<string>());
  /** Responses that carried a silent tool call (learner_attempt / stay_quiet): their text is discarded. */
  const silent = useRef(new Set<string>());
  /** Tool calls being answered; the session counts as busy meanwhile (ask_coach can outlast the pending expiry). */
  const toolsBusy = useRef(0);
  const recentAva = useRef<{ text: string; at: number }[]>([]);
  const lastAttemptId = useRef<string | null>(null);
  /** Time we asked for a response (or the learner's turn ended) and response.created has not arrived yet; 0 = none. */
  const awaitingSince = useRef(0);
  const learnerSpeaking = useRef(false);
  /** Count of sentences that have started playing; compare before/after a relay to see whether Ava started speaking. */
  const spokenCount = useRef(0);

  // ---- speech queue

  const pump = useCallback(async () => {
    const q = queue.current;
    if (q.running) return;
    q.running = true;
    const gen = q.gen;
    setSpeaking(true);
    if (opts.current.muteMicWhileSpeaking) sessionRef.current?.setPlaybackMute(true);
    while (q.items.length && gen === q.gen) {
      if (!(opts.current.canSpeak?.() ?? true)) {
        q.items = []; // the floor is not Ava's: speak nothing
        break;
      }
      const text = q.items.shift()!;
      const sp = speakTeacher(text, opts.current.speed === undefined ? undefined : { speed: opts.current.speed });
      q.current = sp;
      spokenCount.current += 1;
      setSpeech(sp);
      setCaption(text);
      recentAva.current.push({ text, at: Date.now() });
      try { opts.current.onSpeech?.(sp, text); } catch { /* caller errors never stop speech */ }
      await sp.done;
      if (q.current === sp) q.current = null;
      recentAva.current.push({ text, at: Date.now() }); // refresh: echo can trail the end of playback
    }
    if (gen !== q.gen) return; // stopSpeaking already reset the queue
    q.running = false;
    setSpeaking(false);
    sessionRef.current?.setPlaybackMute(false);
  }, []);

  const enqueue = useCallback((sentences: string[]) => {
    if (!sentences.length) return;
    queue.current.items.push(...sentences);
    void pump();
  }, [pump]);

  const stopSpeaking = useCallback(() => {
    const q = queue.current;
    q.gen += 1;
    q.items = [];
    q.running = false;
    const cur = q.current;
    q.current = null;
    cur?.cancel();
    setSpeaking(false);
    sessionRef.current?.setPlaybackMute(false);
  }, []);

  const dropResponse = useCallback((responseId: string | null) => {
    if (!responseId) return;
    dropped.current.add(responseId);
    splitters.current.delete(responseId);
  }, []);

  // ---- tools

  const runTools = useCallback(async (session: RealtimeSession, calls: FunctionCall[]) => {
    toolsBusy.current += 1;
    let needsReply = false;
    for (const call of calls) {
      let output: unknown;
      if (SILENT_TOOLS.has(call.name)) {
        // Classification only: acknowledge, no follow-up response. learner_attempt tells the lesson.
        if (call.name === 'learner_attempt') {
          try { opts.current.onLearnerAttempt?.(); } catch { /* caller errors never break the session */ }
        }
        session.submitToolResult(call.callId, { ok: true }, { respond: false });
        continue;
      }
      needsReply = true;
      try {
        switch (call.name) {
          case 'ask_coach': {
            const question = typeof call.args.question === 'string' ? call.args.question : '';
            const ask = opts.current.askCoach;
            if (!ask) {
              output = ASK_UNAVAILABLE;
              break;
            }
            try {
              const r = await ask(question);
              output = r && typeof r.say === 'string' && r.say.trim() ? { say: r.say } : ASK_UNAVAILABLE;
            } catch {
              output = ASK_UNAVAILABLE;
            }
            break;
          }
          case 'get_coaching': {
            const asked = typeof call.args.attempt_id === 'string' ? call.args.attempt_id : 'latest';
            const id = asked === 'latest' || !asked ? lastAttemptId.current ?? 'latest' : asked;
            output = await opts.current.getCoaching(id);
            break;
          }
          case 'start_practice': {
            const word = typeof call.args.word === 'string' ? call.args.word : '';
            opts.current.onStartPractice?.(word);
            output = { ok: true, word };
            break;
          }
          case 'end_practice':
            if (session.practiceMode) {
              await session.setPracticeMode(false).catch(() => undefined);
              setPractice(false);
            }
            opts.current.onEndPractice?.();
            output = { ok: true };
            break;
          default:
            output = { error: 'unknown_tool' };
        }
      } catch {
        output = { unavailable: true, caption: 'The measurement did not work this time, so nothing was scored.' };
      }
      session.submitToolResult(call.callId, output, { respond: false });
    }
    toolsBusy.current -= 1;
    if (needsReply && sessionRef.current === session) {
      awaitingSince.current = Date.now(); // the follow-up response is pending until response.created
      session.requestResponse();
    }
  }, []);

  // ---- connection

  const connect = useCallback(async () => {
    if (sessionRef.current && (sessionRef.current.state === 'open' || sessionRef.current.state === 'connecting')) return;
    setError(null);
    awaitingSince.current = 0;
    learnerSpeaking.current = false;
    const session = new RealtimeSession(opts.current.sessionOptions);
    sessionRef.current = session;
    session.on('state', setState);
    session.on('error', (m) => setError(m));
    session.on('textDelta', ({ responseId, delta }) => {
      if (dropped.current.has(responseId) || silent.current.has(responseId)) return;
      if (session.practiceMode || !(opts.current.canSpeak?.() ?? true)) {
        // Ava stays silent while the board is live or a scripted line has the floor; a late response (for example
        // after a relay fallback) is discarded.
        dropResponse(responseId);
        session.cancelResponse();
        return;
      }
      let sp = splitters.current.get(responseId);
      if (!sp) { sp = new SentenceSplitter(); splitters.current.set(responseId, sp); }
      enqueue(sp.push(delta));
    });
    session.on('responseCreated', () => { awaitingSince.current = 0; });
    session.on('textDone', ({ responseId }) => {
      const sp = splitters.current.get(responseId);
      if (sp && !dropped.current.has(responseId) && !silent.current.has(responseId)) enqueue(sp.flush());
    });
    session.on('functionCall', (call) => {
      // A silent tool call discards whatever text of its response has not been spoken yet.
      if (SILENT_TOOLS.has(call.name) && call.responseId) {
        silent.current.add(call.responseId);
        splitters.current.delete(call.responseId);
      }
    });
    session.on('responseDone', ({ responseId, status, functionCalls }) => {
      const sp = splitters.current.get(responseId);
      const isSilent = silent.current.delete(responseId) || functionCalls.some((c) => SILENT_TOOLS.has(c.name));
      if (sp && !dropped.current.has(responseId) && !isSilent) enqueue(sp.flush());
      splitters.current.delete(responseId);
      const wasDropped = dropped.current.delete(responseId);
      if (status === 'completed' && !wasDropped && functionCalls.length) {
        // Only a tool that needs an answer is followed by another response.
        if (functionCalls.some((c) => !SILENT_TOOLS.has(c.name))) awaitingSince.current = Date.now();
        void runTools(session, functionCalls);
      }
    });
    session.on('speechStopped', () => {
      learnerSpeaking.current = false;
      if (!session.practiceMode) awaitingSince.current = Date.now(); // VAD is about to start a response
    });
    session.on('speechStarted', () => {
      if (!session.practiceMode) {
        learnerSpeaking.current = true;
        try { opts.current.onLearnerSpeech?.(); } catch { /* caller errors never break the session */ }
      }
      if (!(opts.current.bargeIn ?? true)) return;
      if (queue.current.running || session.responding) {
        stopSpeaking();
        dropResponse(session.responding);
        session.cancelResponse();
      }
    });
    session.on('userTranscript', ({ itemId, transcript }) => {
      const now = Date.now();
      recentAva.current = recentAva.current.filter((r) => now - r.at < ECHO_WINDOW_MS);
      const ava = recentAva.current.map((r) => r.text).join(' ');
      if (ava && wordOverlap(ava, transcript) >= ECHO_OVERLAP) {
        // Ava's own voice came back through the mic: forget the turn and whatever it triggered.
        session.deleteItem(itemId);
        dropResponse(session.responding);
        session.cancelResponse();
        return;
      }
      setLastUserTranscript(transcript);
      opts.current.onUserTranscript?.(transcript);
    });
    try {
      await session.connect();
      // disconnect() or unmount while connecting: do not leave an orphaned live session behind.
      if (sessionRef.current !== session) session.disconnect();
      else setPractice(true); // the session opens gated; the lesson hands over the floor with setPracticeMode(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Realtime connection failed.');
    }
  }, [dropResponse, enqueue, runTools, stopSpeaking]);

  const disconnect = useCallback(() => {
    stopSpeaking();
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    splitters.current.clear();
    dropped.current.clear();
    silent.current.clear();
    toolsBusy.current = 0;
    awaitingSince.current = 0;
    learnerSpeaking.current = false;
    setPractice(false);
  }, [stopSpeaking]);

  useEffect(() => () => {
    queue.current.gen += 1;
    queue.current.current?.cancel();
    sessionRef.current?.disconnect();
    sessionRef.current = null;
  }, []);

  // ---- practice gate and result relay

  /** Attempt start: true (VAD off, mic gated, Ava silent). Usually ended via attemptFinished. */
  const setPracticeMode = useCallback(async (on: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    if (on) {
      stopSpeaking();
      dropResponse(session.responding);
    }
    setPractice(on);
    try {
      await session.setPracticeMode(on);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch practice mode.');
    }
  }, [dropResponse, stopSpeaking]);

  /** Attempt end, tool path: leave practice and let Ava call get_coaching(attemptId) herself. */
  const attemptFinished = useCallback(async (attemptId: string) => {
    lastAttemptId.current = attemptId;
    await setPracticeMode(false);
    sessionRef.current?.injectResult(
      `The learner finished a practice attempt. attemptId: ${attemptId}.`,
      'Call get_coaching with this attemptId, then relay its caption.',
    );
  }, [setPracticeMode]);

  /** Attempt end, direct path: the lesson already has the coaching; skip the tool turn and relay it. */
  const relayResult = useCallback(async (coaching: AvaCoaching, attemptId?: string, instructions?: string) => {
    if (attemptId) lastAttemptId.current = attemptId;
    await setPracticeMode(false);
    const session = sessionRef.current;
    if (!session || session.state !== 'open') throw new Error('Realtime session is not open.');
    awaitingSince.current = Date.now(); // pending until response.created, so waitForIdle cannot slip through the gap
    session.injectResult(
      `Coaching result for the attempt the learner just finished: ${JSON.stringify(coaching)}`,
      instructions ?? RESULT_INSTRUCTIONS,
    );
  }, [setPracticeMode]);

  /** No response pending or generating, no learner turn in progress, sentence queue empty, nothing playing. */
  const isIdle = useCallback(() => {
    const session = sessionRef.current;
    const q = queue.current;
    if (!session) return true;
    const pending = awaitingSince.current !== 0 && Date.now() - awaitingSince.current < PENDING_EXPIRY_MS;
    return !pending && toolsBusy.current === 0 && !learnerSpeaking.current && !session.responding && !q.running && q.items.length === 0 && !q.current;
  }, []);

  /**
   * Resolves true once idle (see isIdle); false on timeout or when the session is not open (closed, failed or never
   * connected). timeoutMs 0 is a single non-blocking check.
   */
  const waitForIdle = useCallback((timeoutMs: number): Promise<boolean> => new Promise<boolean>((resolve) => {
    const started = Date.now();
    const check = () => {
      const session = sessionRef.current;
      if (!session || session.state !== 'open') { resolve(false); return true; }
      if (isIdle()) { resolve(true); return true; }
      if (Date.now() - started >= timeoutMs) { resolve(false); return true; }
      return false;
    };
    if (check()) return;
    const timer = setInterval(() => { if (check()) clearInterval(timer); }, IDLE_POLL_MS);
  }), [isIdle]);

  /** Number of sentences that have started playing; read it before a relay and compare to see if Ava began speaking. */
  const speechCount = useCallback(() => spokenCount.current, []);

  /** Ava's voice is playing or queued right now (a response still generating does not count). */
  const speakingNow = useCallback(() => {
    const q = queue.current;
    return q.running || q.items.length > 0 || !!q.current;
  }, []);

  /** Tell Ava something as the app (system message, "[app] " prefix added once); with respond she answers it. */
  const sendAppMessage = useCallback((text: string, respond: boolean) => {
    const session = sessionRef.current;
    if (!session || session.state !== 'open') return;
    if (respond) awaitingSince.current = Date.now(); // pending until response.created, so waitForIdle cannot slip through
    session.sendSystemMessage(text, respond);
  }, []);

  const sendUserText = useCallback((text: string) => {
    stopSpeaking();
    dropResponse(sessionRef.current?.responding ?? null);
    sessionRef.current?.cancelResponse();
    sessionRef.current?.sendUserText(text);
  }, [dropResponse, stopSpeaking]);

  return {
    state,
    error,
    speaking,
    speech,
    caption,
    practice,
    lastUserTranscript,
    connect,
    disconnect,
    setPracticeMode,
    attemptFinished,
    relayResult,
    sendUserText,
    stopSpeaking,
    waitForIdle,
    speechCount,
    speakingNow,
    sendAppMessage,
    session: () => sessionRef.current,
  };
}
