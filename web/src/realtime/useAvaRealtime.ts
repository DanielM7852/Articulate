import { useCallback, useEffect, useRef, useState } from 'react';
import { speakTeacherStream, type TeacherSpeech, type TeacherStream } from '../audio/teacher';
import { RealtimeSession, type FunctionCall, type RealtimeSessionOptions, type RealtimeState } from './realtimeSession';
import { SentenceSplitter, revealedText, wordOverlap } from './sentences';
import { UtteranceQueue, planHistoryRepair } from './utteranceQueue';

/**
 * Ava as one realtime persona: OpenAI Realtime writes every line (text only), Cartesia speaks it through
 * speakTeacherStream: one stream per response, sentences pushed as they complete so prosody carries across them.
 * Captions and lip sync come from the TeacherSpeech word/phoneme timestamps (onSpeech / speech): a sentence shows
 * once its audio starts. Responses play in order (a stream cancels the current speech, so the next one is only created
 * when the previous is done). On barge-in or typed text, Ava's history is repaired to what was actually heard.
 *
 * Tools: review_attempt is answered by the caller's getCoaching (the lesson's notes on the attempt);
 * start_practice / end_practice are intercepted here and only notify the caller. stay_quiet is silent (notifies
 * onStayQuiet, no follow-up response, the rest of that response is discarded). learner_attempt is answered by the
 * caller's onLearnerAttempt (the lesson measures the try and writes the notes): the mic gate goes on while it runs and off
 * before the output is submitted, then Ava gives the feedback in her own words; a short filler before the call is spoken.
 * think_it_through is answered by the caller's askCoach and Ava answers from the result in her own words. The lesson owns the mic gate (the session
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
  /** Coaching for a finished attempt (the lesson posts to the backend). */
  getCoaching: (attemptId: string) => Promise<AvaCoaching>;
  /** Ava called start_practice(word): show the word and arm the attempt. */
  onStartPractice?: (word: string) => void;
  /** Ava called end_practice(). */
  onEndPractice?: () => void;
  /** Once per spoken reply (its stream, text grows as sentences are pushed), for guide lip sync via the stream's timeline events. */
  onSpeech?: (speech: TeacherSpeech, text: string) => void;
  onUserTranscript?: (text: string) => void;
  /** The learner started speaking (semantic VAD) while not in practice mode. Fires even when bargeIn is off. */
  onLearnerSpeech?: () => void;
  /** Ava may speak only while this returns true (default always). Checked per text delta, per queued sentence and on every spoken word of a playing stream (false stops playback). */
  canSpeak?: () => boolean;
  /**
   * Ava called learner_attempt(): the learner's last utterance was an attempt. Measure it and resolve with the
   * notes (submitted as the tool output). Absent, rejecting or undefined submits LEARNER_ATTEMPT_UNMEASURED.
   */
  onLearnerAttempt?: () => Promise<unknown>;
  /** Ava called stay_quiet(): echo or noise, nothing to do. */
  onStayQuiet?: () => void;
  /** Ava called think_it_through(question): answer it (the lesson asks the backend). */
  askCoach?: (question: string) => Promise<{ say: string }>;
  /** Ava called show_demo: play it with the same code path as the lesson's buttons. Resolve once started, not once finished. */
  onShowDemo?: (what: DemoKind, speed: DemoSpeed) => Promise<ActionResult>;
  /** Ava called lesson_control: do what the matching button does. Resolve once started. */
  onLessonControl?: (action: LessonAction) => Promise<ActionResult>;
  sessionOptions?: RealtimeSessionOptions;
  /** Learner profile, sent with the session request so Ava can remember them. */
  profileId?: string;
  speed?: number;
  /** Stop Ava when the learner starts speaking. Default true. */
  bargeIn?: boolean;
  /** Mute the outgoing mic while Ava speaks (disables barge-in). Default false. */
  muteMicWhileSpeaking?: boolean;
}

export type DemoKind = 'mouth_cue' | 'side_view' | 'ghost_path';
export type DemoSpeed = 'slow' | 'normal';
export type LessonAction = 'next_part' | 'repeat_part' | 'try_now' | 'next_word' | 'finish';
/** Result of an action tool: ok true needs no follow-up; ok false makes Ava follow the instructions. */
export type ActionResult = { ok: true } | { ok: false; reason: string; instructions?: string };

const DEMO_KINDS: readonly string[] = ['mouth_cue', 'side_view', 'ghost_path'];
const DEMO_SPEEDS: readonly string[] = ['slow', 'normal'];
const LESSON_ACTIONS: readonly string[] = ['next_part', 'repeat_part', 'try_now', 'next_word', 'finish'];

/** @internal for tests */
export type ParsedAction =
  | { tool: 'show_demo'; what: DemoKind; speed: DemoSpeed }
  | { tool: 'lesson_control'; action: LessonAction };

/** Validate an action tool's arguments against the enums. Null when the tool is not an action tool or the args are invalid. */
export function parseActionArgs(name: string, args: Record<string, unknown> | null | undefined): ParsedAction | null {
  const a = args ?? {};
  if (name === 'show_demo') {
    const speed = a.speed === undefined ? 'normal' : a.speed;
    if (typeof a.what === 'string' && DEMO_KINDS.includes(a.what) && typeof speed === 'string' && DEMO_SPEEDS.includes(speed)) {
      return { tool: 'show_demo', what: a.what as DemoKind, speed: speed as DemoSpeed };
    }
    return null;
  }
  if (name === 'lesson_control') {
    if (typeof a.action === 'string' && LESSON_ACTIONS.includes(a.action)) return { tool: 'lesson_control', action: a.action as LessonAction };
    return null;
  }
  return null;
}

export const ACTION_UNAVAILABLE: ActionResult = {
  ok: false,
  reason: 'unavailable',
  instructions: 'Say briefly you cannot do that right now.',
};
const ACTION_SPEECH_WAIT_MS = 8000;

const ECHO_WINDOW_MS = 4000;
const ECHO_OVERLAP = 0.6;

/** A response we asked for (or VAD will start) counts as pending this long while waiting for response.created. */
const PENDING_EXPIRY_MS = 6000;
const IDLE_POLL_MS = 80;

/** Tools that only classify what the learner said; the model must stay silent after them. */
const SILENT_TOOLS = new Set(['stay_quiet']);
/** Tools that make the app do something; the text of their response is kept and spoken, and ok:true needs no follow-up. */
const ACTION_TOOLS = new Set(['show_demo', 'lesson_control']);
/** learner_attempt output when the lesson has no measurement (hook absent, failed or empty). */
/** @internal for tests */
export const LEARNER_ATTEMPT_UNMEASURED = {
  measured: false,
  caption: 'The board did not catch that try, so nothing was measured.',
  instructions: 'Say briefly that nothing was measured this time and invite another try.',
};
/** @internal for tests */
export const ASK_UNAVAILABLE = { unavailable: true, say: "I lost the thread on that one. Let's keep practising." };

/** @internal for tests */
export const ATTEMPT_FINISHED_INSTRUCTIONS = 'Call review_attempt with this attemptId, then tell the learner your feedback in your own words.';

/** @internal for tests */
export const RESULT_INSTRUCTIONS =
  'These are your own notes on the try. Say them in your own words, as yourself, in one or two short sentences. Keep their meaning and direction. ' +
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
  const uq = useRef<UtteranceQueue<TeacherStream> | null>(null);
  /** Stream whose captions are on screen; late events of older streams are ignored. */
  const captionStream = useRef<TeacherStream | null>(null);
  const splitters = useRef(new Map<string, SentenceSplitter>());
  const dropped = useRef(new Set<string>());
  /** Responses that carried a silent tool call (stay_quiet): their text is discarded. */
  const silent = useRef(new Set<string>());
  /** Tool calls being answered; the session counts as busy meanwhile (think_it_through can outlast the pending expiry). */
  const toolsBusy = useRef(0);
  const recentAva = useRef<{ text: string; at: number }[]>([]);
  const lastAttemptId = useRef<string | null>(null);
  /** Time we asked for a response (or the learner's turn ended) and response.created has not arrived yet; 0 = none. */
  const awaitingSince = useRef(0);
  const learnerSpeaking = useRef(false);
  /** Count of sentences handed to a stream; compare before/after a relay to see whether Ava started speaking. */
  const spokenCount = useRef(0);

  // ---- speech queue

  const queue = (): UtteranceQueue<TeacherStream> => {
    if (uq.current) return uq.current;
    const q = new UtteranceQueue<TeacherStream>({
      createStream: () => speakTeacherStream(opts.current.speed === undefined ? undefined : { speed: opts.current.speed }),
      canSpeak: () => opts.current.canSpeak?.() ?? true,
      onBusy: (busy) => {
        setSpeaking(busy);
        if (busy) { if (opts.current.muteMicWhileSpeaking) sessionRef.current?.setPlaybackMute(true); }
        else sessionRef.current?.setPlaybackMute(false);
      },
      onStream: (u) => {
        const st = u.stream!;
        captionStream.current = st;
        let reached = -1; // highest word index whose audio has started
        const show = () => {
          if (captionStream.current !== st) return;
          const t = revealedText(st.segments, reached);
          setCaption((prev) => (prev === t ? prev : t));
        };
        setSpeech(st);
        setCaption('');
        st.on('start', () => { if (!q.check()) return; reached = Math.max(reached, 0); show(); });
        st.on('word', (i) => { if (!q.check()) return; if (i > reached) { reached = i; show(); } });
        st.on('end', (why) => {
          if (why === 'finished' && captionStream.current === st) setCaption(st.text);
        });
        try { opts.current.onSpeech?.(st, st.text); } catch { /* caller errors never stop speech */ }
      },
      onSentence: (text, u) => {
        spokenCount.current += 1;
        recentAva.current.push({ text, at: Date.now() });
        // The browser fallback may give no word timing: reveal what has been pushed once playback has begun.
        const st = u.stream!;
        if (st.source === 'browser' && u.spoken.length > 1 && captionStream.current === st) setCaption(st.text);
      },
      onUtteranceDone: (u) => {
        const now = Date.now();
        for (const text of u.spoken) recentAva.current.push({ text, at: now }); // refresh: echo can trail the end of playback
      },
    });
    uq.current = q;
    return q;
  };

  const enqueue = useCallback((responseId: string, sentences: string[]) => {
    queue().add(responseId, sentences);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endResponse = useCallback((responseId: string) => {
    queue().end(responseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Cancel playback and forget the queue, without touching the conversation history. */
  const stopPlayback = useCallback(() => {
    queue().stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dropResponse = useCallback((responseId: string | null) => {
    if (!responseId) return;
    dropped.current.add(responseId);
    splitters.current.delete(responseId);
  }, []);

  /** What must change in the history so it matches what was heard. Compute BEFORE playback stops (streams know it until cancelled). */
  const planRepair = (session: RealtimeSession | null) =>
    session ? planHistoryRepair(queue().utterances, session.responding, (r) => session.assistantItemFor(r)) : [];

  /** Apply a plan AFTER the server's response was cancelled (it must stop writing an item before it is deleted). */
  const applyRepair = (session: RealtimeSession | null, plan: ReturnType<typeof planRepair>) => {
    for (const step of plan) session?.replaceAssistantText(step.itemId, step.heard);
  };

  /**
   * Cut Ava off: plan the history repair, stop playback, drop and cancel the server's response, then apply the repair.
   * Every cut-off goes through this sequence. The plan only covers utterances still in the queue, which is empty after
   * the stop, so a second cut-off does not repair twice.
   */
  const interrupt = useCallback((session: RealtimeSession | null) => {
    const plan = planRepair(session);
    stopPlayback();
    dropResponse(session?.responding ?? null);
    session?.cancelResponse();
    applyRepair(session, plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropResponse, stopPlayback]);

  /** Stop Ava's speech. When something was playing, the cut reply is also repaired in the history (and its response cancelled). */
  const stopSpeaking = useCallback(() => {
    const session = sessionRef.current;
    if (session && session.state === 'open' && queue().busy) interrupt(session);
    else stopPlayback();
  }, [interrupt, stopPlayback]);

  // ---- tools

  /** Resolves once Ava's own speech (queued or playing) is done, or after timeoutMs. Looks only at speech, not at pending responses. */
  const waitForSpeechDone = (timeoutMs: number): Promise<void> => new Promise<void>((resolve) => {
    const started = Date.now();
    let first = true;
    const check = () => {
      if (!first && !queue().busy) return true;
      first = false;
      return Date.now() - started >= timeoutMs;
    };
    // The first look comes one poll later so sentences just handed to the queue have started it.
    const timer = setInterval(() => { if (check()) { clearInterval(timer); resolve(); } }, IDLE_POLL_MS);
  });

  const runTools = useCallback(async (session: RealtimeSession, calls: FunctionCall[]) => {
    toolsBusy.current += 1;
    let needsReply = false;
    for (const call of calls) {
      let output: unknown;
      if (SILENT_TOOLS.has(call.name)) {
        // Classification only: tell the lesson, acknowledge, no follow-up response.
        try { opts.current.onStayQuiet?.(); } catch { /* caller errors never break the session */ }
        session.submitToolResult(call.callId, { ok: true }, { respond: false });
        continue;
      }
      if (ACTION_TOOLS.has(call.name)) {
        let result: ActionResult;
        try {
          const parsed = parseActionArgs(call.name, call.args);
          const hook = parsed?.tool === 'show_demo' ? opts.current.onShowDemo : opts.current.onLessonControl;
          if (!parsed) result = { ok: false, reason: 'invalid_request' };
          else if (!hook) result = ACTION_UNAVAILABLE;
          else {
            await waitForSpeechDone(ACTION_SPEECH_WAIT_MS); // her short preamble finishes before the screen changes
            if (sessionRef.current !== session) result = ACTION_UNAVAILABLE;
            else if (parsed.tool === 'show_demo') result = await opts.current.onShowDemo!(parsed.what, parsed.speed);
            else result = await opts.current.onLessonControl!(parsed.action);
          }
        } catch {
          result = { ok: false, reason: 'failed' };
        }
        if (!result.ok) needsReply = true;
        session.submitToolResult(call.callId, result, { respond: false });
        continue;
      }
      needsReply = true;
      try {
        switch (call.name) {
          case 'learner_attempt': {
            // Gate on (board owns the mic) while the lesson measures and Claude coaches, off again so the reply is not dropped.
            // No stopSpeaking: a short "Let me look." may finish playing.
            const gate = sessionRef.current === session;
            if (gate) {
              await session.setPracticeMode(true).catch(() => undefined);
              setPractice(true);
            }
            try {
              const hook = opts.current.onLearnerAttempt;
              if (!hook) output = LEARNER_ATTEMPT_UNMEASURED;
              else {
                const r = await hook();
                output = typeof r === 'string' ? r : r === undefined ? LEARNER_ATTEMPT_UNMEASURED : r;
              }
            } catch {
              output = LEARNER_ATTEMPT_UNMEASURED;
            }
            if (gate && sessionRef.current === session) {
              await session.setPracticeMode(false).catch(() => undefined);
              setPractice(false);
            }
            break;
          }
          case 'think_it_through': {
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
          case 'review_attempt': {
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
    const session = new RealtimeSession({ ...opts.current.sessionOptions, profileId: opts.current.profileId ?? opts.current.sessionOptions?.profileId });
    sessionRef.current = session;
    session.on('state', setState);
    session.on('error', (m) => setError(m));
    session.on('textDelta', ({ responseId, delta }) => {
      if (dropped.current.has(responseId) || silent.current.has(responseId)) return;
      if (session.practiceMode || !(opts.current.canSpeak?.() ?? true)) {
        // Ava stays silent while the board is live or a scripted line has the floor; a late response (for example
        // after a relay fallback) is discarded.
        const plan = planRepair(session);
        stopPlayback();
        dropResponse(responseId);
        session.cancelResponse();
        applyRepair(session, plan);
        return;
      }
      let sp = splitters.current.get(responseId);
      if (!sp) { sp = new SentenceSplitter(); splitters.current.set(responseId, sp); }
      enqueue(responseId, sp.push(delta));
    });
    session.on('responseCreated', () => { awaitingSince.current = 0; });
    session.on('textDone', ({ responseId }) => {
      const sp = splitters.current.get(responseId);
      if (sp && !dropped.current.has(responseId) && !silent.current.has(responseId)) {
        enqueue(responseId, sp.flush());
        endResponse(responseId);
      }
    });
    session.on('functionCall', (call) => {
      // A silent tool call discards whatever text of its response has not been spoken yet.
      if (SILENT_TOOLS.has(call.name) && call.responseId) {
        silent.current.add(call.responseId);
        splitters.current.delete(call.responseId);
        endResponse(call.responseId); // what was already handed to the stream still plays; nothing more follows
      }
    });
    session.on('responseDone', ({ responseId, status, functionCalls }) => {
      const sp = splitters.current.get(responseId);
      const isSilent = silent.current.delete(responseId) || functionCalls.some((c) => SILENT_TOOLS.has(c.name));
      if (sp && !dropped.current.has(responseId) && !isSilent) enqueue(responseId, sp.flush());
      endResponse(responseId); // idempotent; also closes a dropped/silent/cancelled response's stream
      splitters.current.delete(responseId);
      const wasDropped = dropped.current.delete(responseId);
      if (status === 'completed' && !wasDropped && functionCalls.length) {
        // Only a tool that needs an answer is followed by another response.
        if (functionCalls.some((c) => !SILENT_TOOLS.has(c.name) && !ACTION_TOOLS.has(c.name))) awaitingSince.current = Date.now();
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
      if (queue().busy || session.responding) {
        interrupt(session);
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
  }, [dropResponse, endResponse, enqueue, interrupt, runTools, stopPlayback]);

  const disconnect = useCallback(() => {
    stopPlayback();
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    splitters.current.clear();
    dropped.current.clear();
    silent.current.clear();
    toolsBusy.current = 0;
    awaitingSince.current = 0;
    learnerSpeaking.current = false;
    setPractice(false);
  }, [stopPlayback]);

  useEffect(() => () => {
    uq.current?.stop();
    sessionRef.current?.disconnect();
    sessionRef.current = null;
  }, []);

  // ---- practice gate and result relay

  /** Attempt start: true (VAD off, mic gated, Ava silent). Usually ended via attemptFinished. */
  const setPracticeMode = useCallback(async (on: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    setPractice(on);
    try {
      if (on) {
        // Same cut-off sequence as interrupt(): the session's own setPracticeMode(true) cancels the response.
        const plan = planRepair(session);
        stopPlayback();
        dropResponse(session.responding);
        const update = session.setPracticeMode(true);
        applyRepair(session, plan);
        await update;
      } else {
        await session.setPracticeMode(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch practice mode.');
    }
  }, [dropResponse, stopPlayback]);

  /** Attempt end, tool path: leave practice and let Ava call review_attempt(attemptId) herself. */
  const attemptFinished = useCallback(async (attemptId: string) => {
    lastAttemptId.current = attemptId;
    await setPracticeMode(false);
    sessionRef.current?.injectResult(
      `The learner finished a practice attempt. attemptId: ${attemptId}.`,
      ATTEMPT_FINISHED_INSTRUCTIONS,
    );
  }, [setPracticeMode]);

  /** Attempt end, direct path: the lesson already has the notes; skip the tool turn and hand them to Ava. */
  const relayResult = useCallback(async (coaching: AvaCoaching, attemptId?: string, instructions?: string) => {
    if (attemptId) lastAttemptId.current = attemptId;
    await setPracticeMode(false);
    const session = sessionRef.current;
    if (!session || session.state !== 'open') throw new Error('Realtime session is not open.');
    awaitingSince.current = Date.now(); // pending until response.created, so waitForIdle cannot slip through the gap
    session.injectResult(
      `Your notes on the try the learner just finished: ${JSON.stringify(coaching)}`,
      instructions ?? RESULT_INSTRUCTIONS,
    );
  }, [setPracticeMode]);

  /** No response pending or generating, no learner turn in progress, sentence queue empty, nothing playing. */
  const isIdle = useCallback(() => {
    const session = sessionRef.current;
    const q = queue();
    if (!session) return true;
    const pending = awaitingSince.current !== 0 && Date.now() - awaitingSince.current < PENDING_EXPIRY_MS;
    return !pending && toolsBusy.current === 0 && !learnerSpeaking.current && !session.responding && !q.busy;
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
    return queue().busy;
  }, []);

  /** Tell Ava something as the app (system message, "[app] " prefix added once); with respond she answers it. */
  const sendAppMessage = useCallback((text: string, respond: boolean) => {
    const session = sessionRef.current;
    if (!session || session.state !== 'open') return;
    if (respond) awaitingSince.current = Date.now(); // pending until response.created, so waitForIdle cannot slip through
    session.sendSystemMessage(text, respond);
  }, []);

  const sendUserText = useCallback((text: string) => {
    interrupt(sessionRef.current);
    sessionRef.current?.sendUserText(text);
  }, [interrupt]);

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
