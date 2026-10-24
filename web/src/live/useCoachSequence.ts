import { useCallback, useEffect, useRef, useState } from 'react';
import { speakTeacher, type TeacherSpeech } from '../audio/teacher';
import type { MouthReferenceHandle } from '../components/MouthReference';
import type { CueId, LiveCoachResponse } from './liveCoach';

/**
 * Plays a live coach response: the teacher speaks the caption (Cartesia, browser fallback) while the
 * avatar either lip-syncs in front view, or, when the decision asks for a cue, swings to the side
 * cutaway and loops the cue (the cue owns the mouth, so no lip sync) and then returns to front view.
 * Every step checks a run token, so cancel() or a newer run() stops speech and resets the demo safely.
 */
export const CUE_MIN_MS = 2500; // at least one full cue loop
export const CUE_SILENT_MS = 3000; // narration off: static captions, cue still shown
const DEMO_WAIT_MS = 4000;
const BRIDGE_DEMO_WAIT_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SequenceOptions {
  narration: boolean;
}

/** One therapist line: the caption, plus an optional side-view cue that owns the mouth while it plays. */
export interface SequenceLine {
  text: string;
  cueId: CueId | null;
  showSideView: boolean;
}

export function useCoachSequence(getDemo: () => MouthReferenceHandle | null, ensureAvatarVisible: () => void) {
  const [speech, setSpeech] = useState<TeacherSpeech | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const token = useRef(0);
  const bridgePending = useRef<{ my: number; promise: Promise<void> } | null>(null);
  const live = useRef<{ speech: TeacherSpeech | null; stopLip: (() => void) | null; touchedDemo: boolean }>({
    speech: null,
    stopLip: null,
    touchedDemo: false,
  });
  const getDemoRef = useRef(getDemo);
  getDemoRef.current = getDemo;
  const ensureRef = useRef(ensureAvatarVisible);
  ensureRef.current = ensureAvatarVisible;

  /** Stop speech and lip sync and put the avatar back to a quiet front view. */
  const cancel = useCallback((clearCaption = true) => {
    token.current++;
    const l = live.current;
    live.current = { speech: null, stopLip: null, touchedDemo: false };
    l.speech?.cancel();
    l.stopLip?.();
    if (l.touchedDemo) {
      const demo = getDemoRef.current();
      if (demo?.ready) {
        demo.stop();
        void demo.setView('front').catch(() => undefined);
      }
    }
    setSpeech(null);
    setRunning(false);
    if (clearCaption) setCaption(null);
  }, []);

  useEffect(() => () => cancel(false), [cancel]);

  /** Resolves when any active bridge line has finished or been cancelled. */
  const whenIdle = useCallback((): Promise<void> => bridgePending.current?.promise ?? Promise.resolve(), []);

  /**
   * Say a short code-chosen line (the bridge) with captions and front-view lip sync. The next run()
   * waits for it to finish, so two utterances never overlap.
   */
  const say = useCallback(
    (text: string, opts: SequenceOptions): Promise<void> => {
      cancel(false);
      const my = token.current;
      const alive = () => token.current === my;
      setCaption(text);
      setRunning(true);
      let sp: TeacherSpeech | null = null;
      if (opts.narration) {
        sp = speakTeacher(text);
        live.current.speech = sp;
        setSpeech(sp);
      }
      const p = (async () => {
        try {
          if (!sp) return;
          ensureRef.current();
          let demo = getDemoRef.current();
          const until = Date.now() + BRIDGE_DEMO_WAIT_MS;
          while (alive() && !demo?.ready && Date.now() < until) {
            await sleep(100);
            demo = getDemoRef.current();
          }
          if (!alive()) return;
          if (demo?.ready) {
            live.current.touchedDemo = true;
            demo!.stop();
            const handle = demo!.speak({ clock: () => sp!.clock(), timeline: { words: [...sp.words], phonemes: [...sp.phonemes] } });
            if (handle) {
              const offTimeline = sp.on('timeline', (added) => handle.append(added));
              const offEnd = sp.on('end', () => handle.end());
              live.current.stopLip = () => {
                offTimeline();
                offEnd();
                handle.stop();
              };
            }
          }
          await sp.done;
        } catch {
          /* presentation only */
        } finally {
          if (alive()) {
            live.current.stopLip?.();
            live.current = { speech: null, stopLip: null, touchedDemo: live.current.touchedDemo };
            setRunning(false);
          }
          if (bridgePending.current?.my === my) bridgePending.current = null;
        }
      })();
      bridgePending.current = { my, promise: p };
      return p;
    },
    [cancel],
  );

  /** Speak any therapist line (coach feedback or a session-director turn). Resolves when finished or cancelled. */
  const speakLine = useCallback(
    async (line: SequenceLine, opts: SequenceOptions): Promise<void> => {
      const pending = bridgePending.current;
      if (pending && token.current === pending.my) {
        await pending.promise;
        if (token.current !== pending.my) return; // cancelled while the bridge was speaking
      }
      cancel(false);
      const my = token.current;
      const alive = () => token.current === my;
      const text = line.text;
      setCaption(text);
      setRunning(true);
      const wantCue = line.showSideView && line.cueId !== null;

      // Speak first; the avatar work happens in parallel with the audio.
      let sp: TeacherSpeech | null = null;
      if (opts.narration) {
        sp = speakTeacher(text);
        live.current.speech = sp;
        setSpeech(sp);
      }

      try {
        ensureRef.current();
        let demo = getDemoRef.current();
        if (!demo?.ready && (wantCue || opts.narration)) {
          const until = Date.now() + DEMO_WAIT_MS;
          while (alive() && Date.now() < until) {
            demo = getDemoRef.current();
            if (demo?.ready) break;
            await sleep(100);
          }
        }
        if (!alive()) return;
        demo = getDemoRef.current();
        const avatar = demo && demo.ready ? demo : null;

        if (wantCue && avatar && line.cueId) {
          live.current.touchedDemo = true;
          avatar.stop();
          await avatar.setView('side');
          if (!alive()) return;
          avatar.showCue(line.cueId);
          const cueStart = Date.now();
          if (sp) await sp.done;
          if (!alive()) return;
          const minMs = sp ? CUE_MIN_MS : CUE_SILENT_MS;
          const left = minMs - (Date.now() - cueStart);
          if (left > 0) await sleep(left);
          if (!alive()) return;
          avatar.stop();
          await avatar.setView('front');
        } else if (sp) {
          if (avatar) {
            live.current.touchedDemo = true;
            avatar.stop(); // a playing cue would own the mouth and block lip sync
            const handle = avatar.speak({ clock: () => sp!.clock(), timeline: { words: [...sp.words], phonemes: [...sp.phonemes] } });
            if (handle) {
              const offTimeline = sp.on('timeline', (added) => handle.append(added));
              const offEnd = sp.on('end', () => handle.end());
              live.current.stopLip = () => {
                offTimeline();
                offEnd();
                handle.stop();
              };
            }
          }
          await sp.done;
        } else if (wantCue) {
          // Cue requested but the avatar never loaded: captions alone carry the message.
          await sleep(CUE_SILENT_MS);
        }
      } catch {
        /* the sequence is a presentation layer; failures leave captions and the result sheet intact */
      } finally {
        if (alive()) {
          live.current.stopLip?.();
          live.current = { speech: null, stopLip: null, touchedDemo: false };
          setRunning(false);
        }
      }
    },
    [cancel],
  );

  const run = useCallback(
    (resp: LiveCoachResponse, opts: SequenceOptions): Promise<void> =>
      speakLine({ text: resp.caption, cueId: resp.cueId, showSideView: resp.showSideView }, opts),
    [speakLine],
  );

  return { speech, caption, running, run, speakLine, say, whenIdle, cancel };
}
