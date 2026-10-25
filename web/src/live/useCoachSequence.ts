import { useCallback, useEffect, useRef, useState } from 'react';
import { speakTeacher, type TeacherSpeech } from '../audio/teacher';
import { bakedEntry } from '../audio/bakedVoice';
import type { MouthReferenceHandle } from '../components/MouthReference';
import type { MouthCueId } from '@mouth-demo/src/mouth-demo.js';
import type { PartSound } from '../game/ghost/partSounds';
import type { LiveCoachResponse } from './liveCoach';

/**
 * Plays a live coach response: the teacher speaks the caption (Cartesia, browser fallback) while the
 * avatar lip-syncs it. The head never turns for a spoken line: every sentence is lip-synced in front view.
 * The only time Ava turns to the side is pronounce(): she turns, loops the part's cutaway cue, says the part
 * sound exactly when the cue reaches the phase where that sound belongs (sound.at), repeats, lets the last loop
 * relax, and turns back to front. A line with a cue but no sound shows the cue in front view after the line.
 * Every step checks a run token, so cancel() or a newer run() stops speech and resets the demo safely.
 */
export const CUE_MIN_MS = 3200; // at least one full cue loop (a two-pose tongue loop is up to 3000 ms)
export const CUE_SILENT_MS = 3000; // narration off: static captions, cue still shown
const DEMO_WAIT_MS = 4000;
const BRIDGE_DEMO_WAIT_MS = 2000;
const PRONOUNCE_GAP_MS = 700; // between repeats when there is no cue (front-view lip sync)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SequenceOptions {
  narration: boolean;
  /** Teacher voice speed (1 = default); passed to speakTeacher. Absent keeps the default. */
  speed?: number;
}

/** One part sound to pronounce: its cue (null = no tongue cue, lip-synced in front) and how many times. */
export interface PronounceSpec {
  cueId: MouthCueId | null;
  sound: PartSound;
  /** Default 2. */
  reps?: number;
  /** Called synchronously as each sound starts playing; durationMs is the baked clip length, null when unknown. */
  onSound?: (sound: PartSound, durationMs: number | null) => void;
}

/**
 * One therapist line: the caption, plus an optional cue that takes over the mouth (front view) once the line is spoken,
 * or an optional part sound pronounced (side view, with the cue) after the line. The head does not turn for the line itself.
 */
export interface SequenceLine {
  text: string;
  cueId: MouthCueId | null;
  /** Kept for callers that record whether a line was a demo; the line itself is always lip-synced in front. */
  showSideView: boolean;
  /** After the line, pronounce this part sound once with `cueId` (see pronounce). */
  sound?: PartSound | null;
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
        sp = speakTeacher(text, opts.speed === undefined ? undefined : { speed: opts.speed });
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

  /** Drive the avatar's mouth from the teacher's audio clock; cancel() and the line's end stop it. */
  const lipSync = useCallback((avatar: MouthReferenceHandle, sp: TeacherSpeech) => {
    const handle = avatar.speak({ clock: () => sp.clock(), timeline: { words: [...sp.words], phonemes: [...sp.phonemes] } });
    if (!handle) return;
    const offTimeline = sp.on('timeline', (added) => handle.append(added));
    const offEnd = sp.on('end', () => handle.end());
    live.current.stopLip = () => {
      offTimeline();
      offEnd();
      handle.stop();
    };
  }, []);

  /** Resolve the avatar once it is ready (waits up to DEMO_WAIT_MS); null when it never loads or the run is superseded. */
  const awaitAvatar = useCallback(async (alive: () => boolean): Promise<MouthReferenceHandle | null> => {
    ensureRef.current();
    let demo = getDemoRef.current();
    const until = Date.now() + DEMO_WAIT_MS;
    while (alive() && !demo?.ready && Date.now() < until) {
      await sleep(100);
      demo = getDemoRef.current();
    }
    if (!alive()) return null;
    demo = getDemoRef.current();
    return demo && demo.ready ? demo : null;
  }, []);

  /**
   * Speak one part sound. The IPA transcript is spoken only (never captioned or setSpeech'd); a browser-voice
   * fallback reads the plain caption. Baked clips play at speed 1, so no speed is passed.
   */
  const speakSound = useCallback((sound: PartSound, onSound?: PronounceSpec['onSound']): TeacherSpeech => {
    const sp = speakTeacher(sound.say, { fallbackText: sound.caption });
    live.current.speech = sp;
    const clip = bakedEntry(sound.say);
    onSound?.(sound, clip ? Math.round(clip.durationS * 1000) : null);
    return sp;
  }, []);

  /**
   * The pronounce behaviour under an existing run token: turn to the side, loop the part's cue, say the sound each time
   * the cue reaches `sound.at`, let the last loop relax, then turn back to front. No cue: lip-sync the sound in front.
   */
  const pronounceRun = useCallback(
    async (my: number, spec: PronounceSpec, opts: SequenceOptions): Promise<void> => {
      const alive = () => token.current === my;
      const { sound, cueId } = spec;
      const reps = Math.max(1, spec.reps ?? 2);
      setCaption(sound.caption);
      setRunning(true);
      let off: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let watcher: ReturnType<typeof setInterval> | null = null;
      try {
        const avatar = await awaitAvatar(alive);
        if (!alive()) return;

        if (avatar && cueId) {
          live.current.touchedDemo = true;
          avatar.stop();
          await avatar.setView('side');
          if (!alive()) return;
          let played = 0;
          let lastDone: Promise<void> = Promise.resolve();
          let release: () => void = () => undefined;
          const released = new Promise<void>((r) => (release = r));
          timer = setTimeout(() => release(), reps * 6500 + 3000);
          watcher = setInterval(() => {
            if (!alive()) release(); // cancelled: do not linger until the safety timeout
          }, 100);
          off = avatar.onCuePhase((id, phase) => {
            if (id !== cueId || !alive()) return;
            if (phase === sound.at && played < reps) {
              played++;
              if (opts.narration) {
                const sp = speakSound(sound, spec.onSound);
                lastDone = sp.done.then(
                  () => undefined,
                  () => undefined,
                );
              }
            } else if (phase === 'rest' && played >= reps) {
              release();
            }
          });
          avatar.showCue(cueId);
          await released; // the last sound's loop has relaxed (or the safety timeout hit)
          if (!alive()) return;
          await lastDone;
          if (!alive()) return;
          off();
          off = null;
          avatar.stop();
          await avatar.setView('front');
          live.current.touchedDemo = false;
          return;
        }

        for (let i = 0; i < reps; i++) {
          if (!alive()) return;
          if (opts.narration) {
            const sp = speakSound(sound, spec.onSound);
            if (avatar) {
              live.current.touchedDemo = true;
              avatar.stop();
              lipSync(avatar, sp);
            }
            await sp.done;
            live.current.stopLip?.();
            live.current.stopLip = null;
          }
          if (!alive()) return;
          if (i < reps - 1) await sleep(opts.narration ? PRONOUNCE_GAP_MS : CUE_SILENT_MS / reps);
        }
      } catch {
        /* presentation only: the caption carries the sound */
      } finally {
        off?.();
        if (timer) clearTimeout(timer);
        if (watcher) clearInterval(watcher);
        if (alive()) {
          live.current.stopLip?.();
          if (live.current.touchedDemo) {
            const demo = getDemoRef.current();
            if (demo?.ready) {
              demo.stop();
              void demo.setView('front').catch(() => undefined);
            }
          }
          live.current = { speech: null, stopLip: null, touchedDemo: false };
          setRunning(false);
        }
      }
    },
    [awaitAvatar, lipSync, speakSound],
  );

  /** Pronounce one part sound with its cutaway cue (see pronounceRun). Interrupts any current line. */
  const pronounce = useCallback(
    async (spec: PronounceSpec, opts: SequenceOptions): Promise<void> => {
      const pending = bridgePending.current;
      if (pending && token.current === pending.my) {
        await pending.promise;
        if (token.current !== pending.my) return;
      }
      cancel(false);
      await pronounceRun(token.current, spec, opts);
    },
    [cancel, pronounceRun],
  );

  /** Speak any therapist line (coach feedback or a session-director turn). Resolves when finished or cancelled. The head never turns for a line. */
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
      const wantCue = line.showSideView && line.cueId !== null && !line.sound;

      // Speak first; the avatar work happens in parallel with the audio.
      let sp: TeacherSpeech | null = null;
      if (opts.narration) {
        sp = speakTeacher(text, opts.speed === undefined ? undefined : { speed: opts.speed });
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

        if (sp && avatar) {
          live.current.touchedDemo = true;
          avatar.stop(); // a playing cue would own the mouth and block lip sync
          lipSync(avatar, sp);
        }
        if (sp) {
          await sp.done;
          if (!alive()) return;
          live.current.stopLip?.();
          live.current.stopLip = null;
        }
        if (wantCue && line.cueId) {
          if (avatar) {
            // Front-view cue after the line (no head turn): the cue takes over the mouth for at least one loop.
            live.current.touchedDemo = true;
            avatar.stop();
            avatar.showCue(line.cueId);
            await sleep(sp ? CUE_MIN_MS : CUE_SILENT_MS);
            if (!alive()) return;
            avatar.stop();
          } else {
            await sleep(CUE_SILENT_MS); // the avatar never loaded: captions alone carry the message
          }
        }
      } catch {
        /* the sequence is a presentation layer; failures leave captions and the result sheet intact */
      } finally {
        if (alive()) {
          live.current.stopLip?.();
          live.current = { speech: null, stopLip: null, touchedDemo: live.current.touchedDemo };
          setRunning(false);
        }
      }
      if (alive() && line.sound) await pronounceRun(my, { cueId: line.cueId, sound: line.sound, reps: 1 }, opts);
    },
    [cancel, lipSync, pronounceRun],
  );

  const run = useCallback(
    (resp: LiveCoachResponse, opts: SequenceOptions): Promise<void> =>
      speakLine({ text: resp.caption, cueId: resp.cueId, showSideView: resp.showSideView }, opts),
    [speakLine],
  );

  return { speech, caption, running, run, speakLine, pronounce, say, whenIdle, cancel };
}
