import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareTeacher, unlockTeacherAudio } from '../../audio/teacher';
import type { SequenceLine, SequenceOptions } from '../../live/useCoachSequence';
import type { SoundId } from '../../state/types';
import type { ConversationAudio, SegmentResult } from '../audio/types';
import { sendTurn, startSession, type AttemptCoachSummary, type ControlKind, type SessionEvent, type SessionTurn } from './api';

/**
 * Session director: a hands-free, therapist-led conversation.
 *
 * States
 *   idle       nothing started; the "Begin session" button is shown
 *   starting   mic opening, POST /session/start in flight
 *   speaking   Ava is talking (lip sync, or side view + cue); learner speech can barge in
 *   listening  mic armed (listen('either')); waiting for the learner; an 8 s silence timer runs
 *   capturing  a voiced segment started; the attempt capture (mic, F1/F2 window, lips, recorder) is running
 *   analyzing  segment ended and we are grading it / waiting for the next turn ("Thinking…")
 *   ended      end_session spoken; onEnded() navigates to the summary
 *   error      start failed; retry button shown
 *
 * Transitions
 *   idle -> starting -> speaking(first turn)
 *   speaking -> listening            (line finished, or barge-in)
 *   listening -> capturing           (onSegmentStart)
 *   capturing -> analyzing           (onSegment: attempt => grade + feedback event; reply => discard + utterance event)
 *   listening -> analyzing           (silence timer or a tap control => event)
 *   analyzing -> speaking            (next SessionTurn arrives; a failed call becomes a scripted turn)
 *   speaking -> ended                (action end_session finished)
 * Every async step is guarded by runRef, which is bumped by anything that supersedes it (barge-in,
 * a tap control, a new turn, unmount), so lines never overlap and stale results are dropped.
 */
export type DirectorState = 'idle' | 'starting' | 'speaking' | 'listening' | 'capturing' | 'analyzing' | 'ended' | 'error';

export const SILENCE_SECONDS = 8;
const MAX_SILENCE_EVENTS = 2;
export const SCRIPTED_KEEP_GOING = 'Let’s keep going — try the sound when you’re ready.';
const SCRIPTED_END = 'Great work today. Let’s look at how it went.';

export interface CaptureOutcome {
  attemptId: string;
  coach: AttemptCoachSummary;
}

export interface DirectorDeps {
  audio: ConversationAudio;
  profileId: string;
  displayName: string;
  /** Sound currently shown by the screen. */
  sound: SoundId;
  setSound: (s: SoundId) => void;
  narration: boolean;
  /** Speak a line with captions + lip sync / side-view cue; resolves when done or cancelled. */
  speakLine: (line: SequenceLine, opts: SequenceOptions) => Promise<void>;
  cancelSpeech: () => void;
  /** Open the microphone inside the click gesture. Resolves false if unavailable. */
  prepare: () => Promise<boolean>;
  capture: {
    /** Start an attempt capture (mic window, tracking, lips, recorder, sink). */
    begin: () => Promise<void>;
    /** Finish like the old stopRecording: bridge line, grading, coach speech. Null if superseded or unusable. */
    finish: () => Promise<CaptureOutcome | null>;
    /** Throw the capture away (no attempt is stored). Safe when nothing is capturing. */
    discard: () => void;
  };
  onEnded: () => void;
}

const STATUS_LABEL: Record<DirectorState, string> = {
  idle: '',
  starting: 'Getting ready…',
  speaking: 'Ava is speaking',
  listening: 'Listening…',
  capturing: 'Hearing you…',
  analyzing: 'Thinking…',
  ended: 'Session complete',
  error: 'Could not start',
};

type Unsub = (() => void) | void;

export function useSessionDirector(deps: DirectorDeps) {
  const d = useRef(deps);
  d.current = deps;

  const [state, setStateRaw] = useState<DirectorState>('idle');
  const stateRef = useRef<DirectorState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [turnSource, setTurnSource] = useState<SessionTurn['source'] | null>(null);

  const runRef = useRef(0);
  const sessionId = useRef<string | null>(null);
  const soundRef = useRef<SoundId>(deps.sound);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceCount = useRef(0);
  const capturePromise = useRef<Promise<void> | null>(null);
  const startAbort = useRef<AbortController | null>(null);

  const setState = useCallback((s: DirectorState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  const clearSilence = useCallback(() => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    silenceTimer.current = null;
  }, []);

  /** Interrupt anything in flight: pending async steps go stale, speech stops, any capture is dropped. */
  const interrupt = useCallback(() => {
    runRef.current++;
    clearSilence();
    d.current.cancelSpeech();
    d.current.audio.setTeacherSpeaking(false);
    capturePromise.current = null;
    d.current.capture.discard();
  }, [clearSilence]);

  /* ---------------- listening + silence ---------------- */

  const dispatchRef = useRef<(e: SessionEvent) => Promise<void>>(async () => undefined);

  const beginListening = useCallback(() => {
    setState('listening');
    d.current.audio.listen('either');
    clearSilence();
    if (silenceCount.current >= MAX_SILENCE_EVENTS) return; // keep listening quietly
    const my = runRef.current;
    silenceTimer.current = setTimeout(() => {
      if (runRef.current !== my || stateRef.current !== 'listening') return;
      silenceCount.current++;
      void dispatchRef.current({ kind: 'silence', seconds: SILENCE_SECONDS });
    }, SILENCE_SECONDS * 1000);
  }, [clearSilence, setState]);

  /* ---------------- executing a therapist turn ---------------- */

  const executeTurn = useCallback(
    async (turn: SessionTurn) => {
      const my = ++runRef.current;
      const alive = () => runRef.current === my;
      clearSilence();
      setTurnSource(turn.source);
      if (turn.sound !== soundRef.current) {
        soundRef.current = turn.sound;
        d.current.setSound(turn.sound);
      }
      const a = d.current.audio;
      a.listen('off');
      setState('speaking');
      a.setTeacherSpeaking(true);
      const narration = d.current.narration;
      try {
        // demonstrate / next_sound: side view + cue owns the mouth while `say` plays, then front view.
        // prompt_attempt / await_reply / end_session: front view with lip sync. All via the same sequence.
        await d.current.speakLine({ text: turn.say, cueId: turn.cueId, showSideView: turn.showSideView }, { narration });
        if (alive() && !narration) {
          // No voice: give the learner time to read the caption before listening starts.
          await new Promise<void>((r) => setTimeout(r, Math.min(9000, 1500 + turn.say.length * 55)));
        }
      } catch {
        /* presentation only */
      }
      if (!alive()) return;
      a.setTeacherSpeaking(false);
      if (turn.action === 'end_session') {
        setState('ended');
        d.current.onEnded();
        return;
      }
      beginListening();
    },
    [beginListening, clearSilence, setState],
  );

  const scriptedTurn = useCallback(
    (action: SessionTurn['action'], say: string): SessionTurn => ({
      sessionId: sessionId.current ?? '',
      say,
      action,
      sound: soundRef.current,
      cueId: null,
      showSideView: false,
      source: 'scripted',
      timingsMs: null,
    }),
    [],
  );

  /** Send an event to the backend director and perform the turn it returns (scripted fallback on failure). */
  const dispatch = useCallback(
    async (event: SessionEvent) => {
      if (event.kind !== 'silence') silenceCount.current = 0;
      const my = ++runRef.current;
      clearSilence();
      setState('analyzing');
      d.current.audio.listen('off');
      let turn: SessionTurn;
      try {
        if (!sessionId.current) throw new Error('no session');
        turn = await sendTurn({ sessionId: sessionId.current, profileId: d.current.profileId, event });
      } catch {
        const ending = event.kind === 'control' && event.control === 'end';
        turn = ending ? scriptedTurn('end_session', SCRIPTED_END) : scriptedTurn('await_reply', SCRIPTED_KEEP_GOING);
      }
      if (runRef.current !== my) return;
      await executeTurn(turn);
    },
    [clearSilence, executeTurn, scriptedTurn, setState],
  );
  dispatchRef.current = dispatch;

  /* ---------------- audio events ---------------- */

  const onSegmentStart = useCallback(() => {
    if (stateRef.current !== 'listening') return;
    clearSilence();
    setState('capturing');
    capturePromise.current = d.current.capture.begin().catch(() => undefined);
  }, [clearSilence, setState]);

  const onSegment = useCallback(
    async (r: SegmentResult) => {
      const st = stateRef.current;
      if (st !== 'capturing' && st !== 'listening') return;
      const my = ++runRef.current;
      const started = capturePromise.current;
      capturePromise.current = null;
      if (started) await started;
      if (runRef.current !== my) return;

      if (r.kind === 'attempt' && started) {
        setState('analyzing');
        const a = d.current.audio;
        a.listen('off');
        a.setTeacherSpeaking(true); // bridge line + coach feedback are teacher speech
        let outcome: CaptureOutcome | null = null;
        try {
          outcome = await d.current.capture.finish();
        } catch {
          outcome = null;
        }
        if (runRef.current !== my) return;
        a.setTeacherSpeaking(false);
        if (!outcome) {
          beginListening();
          return;
        }
        await dispatch({ kind: 'attempt_feedback', attemptId: outcome.attemptId, currentSound: soundRef.current, coach: outcome.coach });
        return;
      }

      if (r.kind === 'reply') {
        d.current.capture.discard(); // a spoken reply is not an attempt
        setHeard(r.transcript ?? '');
        await dispatch({ kind: 'utterance', text: r.transcript ?? '', currentSound: soundRef.current });
        return;
      }
      // An attempt with no capture behind it (the start was missed): nothing to grade.
      beginListening();
    },
    [beginListening, dispatch, setState],
  );

  const onBargeIn = useCallback(() => {
    if (stateRef.current !== 'speaking') return;
    runRef.current++;
    d.current.cancelSpeech();
    d.current.audio.setTeacherSpeaking(false);
    beginListening();
  }, [beginListening]);

  // Register once; handlers read the latest closures through refs.
  const handlers = useRef({ onSegmentStart, onSegment, onBargeIn });
  handlers.current = { onSegmentStart, onSegment, onBargeIn };
  useEffect(() => {
    const a = d.current.audio;
    const offs: Unsub[] = [
      a.onSegmentStart(() => handlers.current.onSegmentStart()) as Unsub,
      a.onSegment((r: SegmentResult) => void handlers.current.onSegment(r)) as Unsub,
      a.onBargeIn(() => handlers.current.onBargeIn()) as Unsub,
    ];
    return () => {
      for (const off of offs) if (typeof off === 'function') off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- public actions ---------------- */

  /** Called from the "Begin session" click: unlocks audio, opens the mic, starts the backend session. */
  const begin = useCallback(async () => {
    void unlockTeacherAudio(); // must run inside the click gesture
    prepareTeacher();
    setError(null);
    setHeard(null);
    setState('starting');
    const my = ++runRef.current;
    startAbort.current?.abort();
    const ctl = new AbortController();
    startAbort.current = ctl;
    const micOk = await d.current.prepare();
    if (runRef.current !== my) return;
    if (!micOk) {
      setError('Ava needs your microphone to hear you. Allow it in site settings, then try again.');
      setState('error');
      return;
    }
    try {
      const turn = await startSession({ profileId: d.current.profileId, displayName: d.current.displayName, sounds: null }, ctl.signal);
      if (runRef.current !== my) return;
      sessionId.current = turn.sessionId;
      silenceCount.current = 0;
      await executeTurn(turn);
    } catch {
      if (runRef.current !== my) return;
      setError('Could not start the session. Check your connection and try again.');
      setState('error');
    }
  }, [executeTurn, setState]);

  /** Tap controls work without voice. They interrupt Ava and any capture, then ask the director what is next. */
  const control = useCallback(
    (c: ControlKind) => {
      const st = stateRef.current;
      if (st === 'idle' || st === 'starting' || st === 'ended' || st === 'error') return;
      interrupt();
      void dispatch({ kind: 'control', control: c });
    },
    [dispatch, interrupt],
  );

  // Leaving the screen ends listening, cancels speech and disposes audio (only if a session ever ran).
  useEffect(
    () => () => {
      runRef.current++;
      startAbort.current?.abort();
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
      if (sessionId.current || stateRef.current !== 'idle') {
        const a = d.current.audio;
        a.listen('off');
        a.setTeacherSpeaking(false);
        d.current.cancelSpeech();
        d.current.capture.discard();
        a.dispose();
      }
    },
    [],
  );

  return {
    state,
    active: state !== 'idle' && state !== 'error' && state !== 'ended',
    statusLabel: STATUS_LABEL[state],
    error,
    heard,
    turnSource,
    begin,
    control,
  };
}
