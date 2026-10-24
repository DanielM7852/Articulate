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
 * start_practice / end_practice are intercepted here and only notify the caller. The lesson owns the mic gate:
 * setPracticeMode(true) at attempt start, attemptFinished(attemptId) (or relayResult) at the end.
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
    for (const call of calls) {
      let output: unknown;
      try {
        switch (call.name) {
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
    if (sessionRef.current === session) session.requestResponse();
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
      if (dropped.current.has(responseId)) return;
      if (session.practiceMode) {
        // Ava stays silent while the board is live; a late response (for example after a relay fallback) is discarded.
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
      if (sp && !dropped.current.has(responseId)) enqueue(sp.flush());
    });
    session.on('responseDone', ({ responseId, status, functionCalls }) => {
      const sp = splitters.current.get(responseId);
      if (sp && !dropped.current.has(responseId)) enqueue(sp.flush());
      splitters.current.delete(responseId);
      const wasDropped = dropped.current.delete(responseId);
      if (status === 'completed' && !wasDropped && functionCalls.length) {
        awaitingSince.current = Date.now(); // the tool turn is followed by another response
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
    return !pending && !learnerSpeaking.current && !session.responding && !q.running && q.items.length === 0 && !q.current;
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
    session: () => sessionRef.current,
  };
}
