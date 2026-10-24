import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { TrackedFrame, VowelPoint } from '../audio/tracker';
import { projectVowel } from '../components/plot';
import { VowelPlot } from '../components/VowelPlot';
import { EH_RADIUS_V1 } from '../reference/data';
import { HEAD_MODEL_V1 } from '../reference/headModel';
import type { useVowelSession } from '../useVowelSession';
import type { FrameListener } from './GameMode';
import { HeadPractice, MATCH_STREAK, targetPath, type HeadAttempt, type HeadModel, type HeadSnapshot } from './head';
import { CheckPanel, GROUPS, ago } from './TargetLesson';
import { VoiceCheck, type CheckPrompt, type VoiceCheckState, type VoiceGroup, type VoiceProfile } from './targets';
import './head.css';

type Formants = { f1: number; f2: number };

const MODEL: HeadModel = HEAD_MODEL_V1;
const MODEL_AUDIO = `${import.meta.env.BASE_URL}head-model.wav`;
/** Scoring pauses while the model plays: the microphone would otherwise hear the speakers. */
const AFTER_PLAYBACK_MS = 300;
const SHOWN_ATTEMPTS = 8;

type Stage =
  | { kind: 'intro' }
  | { kind: 'checking'; prompts: readonly CheckPrompt[]; state: VoiceCheckState | null }
  | { kind: 'failed' }
  | { kind: 'ready' }
  | { kind: 'practice'; snapshot: HeadSnapshot };

type Engine = { kind: 'check'; check: VoiceCheck } | { kind: 'practice'; practice: HeadPractice };

interface Props {
  session: ReturnType<typeof useVowelSession>;
  frames: MutableRefObject<FrameListener | null>;
  point: VowelPoint | null;
  tracking: boolean;
  lessonPicker: ReactNode;
  /** The last voice check from this page visit. Only an "uh" check is reused: "head" must never size its own target. */
  saved: VoiceProfile | null;
  onChecked: (profile: VoiceProfile) => void;
}

/** Say "head" until three paths in a row land within the model voice's own repeat-to-repeat range. */
export function HeadLesson({ session, frames, point, tracking, lessonPicker, saved, onChecked }: Props) {
  const reusable = saved?.sizing === 'approximate' ? saved : null;
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [group, setGroup] = useState<VoiceGroup | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'intro' });
  const [watching, setWatching] = useState(0);
  const [audioMissing, setAudioMissing] = useState(false);
  const engine = useRef<Engine | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const pausedUntil = useRef(0);

  const onFrame = useCallback((frame: TrackedFrame) => {
    const current = engine.current;
    if (!current) return;
    if (current.kind === 'check') {
      const state = current.check.push(frame);
      if (state.kind !== 'done') { setStage({ kind: 'checking', prompts: current.check.prompts, state }); return; }
      engine.current = null;
      if (state.ok) {
        onChecked(state.profile);
        setProfile(state.profile);
        setStage({ kind: 'ready' });
      } else setStage({ kind: 'failed' });
      return;
    }
    if (performance.now() < pausedUntil.current) return;
    const snapshot = current.practice.push(frame);
    if (snapshot.phase === 'matched') engine.current = null;
    setStage({ kind: 'practice', snapshot });
  }, [onChecked]);

  useEffect(() => {
    frames.current = onFrame;
    return () => { frames.current = null; };
  }, [frames, onFrame]);

  // Frame timestamps restart with the microphone, so an attempt in progress cannot continue.
  useEffect(() => {
    if ((session.phase === 'finished' || session.phase === 'error') && engine.current) {
      engine.current = null;
      setStage(profile ? { kind: 'ready' } : { kind: 'intro' });
    }
  }, [session.phase, profile]);

  const ensureMicrophone = () => {
    if (session.phase !== 'running' && session.phase !== 'requesting') void session.start();
  };
  const beginCheck = () => {
    if (!group) return;
    const check = new VoiceCheck(saved?.place ?? 'quiet', { kind: 'uh', group }, { starts: false });
    engine.current = { kind: 'check', check };
    setStage({ kind: 'checking', prompts: check.prompts, state: null });
    ensureMicrophone();
  };
  const reuse = () => {
    if (!reusable) return;
    setProfile(reusable);
    setStage({ kind: 'ready' });
  };
  const practise = () => {
    if (!profile) return;
    const practice = new HeadPractice(MODEL, profile);
    engine.current = { kind: 'practice', practice };
    setStage({ kind: 'practice', snapshot: practice.snapshot() });
    ensureMicrophone();
  };
  const watch = () => {
    setWatching((n) => n + 1);
    const element = audio.current;
    const lengthMs = element && Number.isFinite(element.duration) ? element.duration * 1000 : MODEL.durationMs ?? 1200;
    pausedUntil.current = performance.now() + lengthMs + AFTER_PLAYBACK_MS;
    if (element && !audioMissing) { element.currentTime = 0; void element.play().catch(() => setAudioMissing(true)); }
  };
  const stop = () => {
    engine.current = null;
    session.finish();
    setStage(profile ? { kind: 'ready' } : { kind: 'intro' });
  };

  const snapshot = stage.kind === 'practice' ? stage.snapshot : null;
  const target = profile ? targetPath(MODEL, profile.factor) : null;
  const micOn = session.phase === 'running' && !session.stale;
  const latest = session.frame?.timestampMs ?? 0;
  const trace = snapshot ? [] : session.trace.filter((sample) => sample.timestampMs >= latest - 3000);
  const canWatch = !!target && snapshot?.phase !== 'hearing';

  return (
    <div className="workspace game-workspace hd-workspace">
      <section className="map-panel" aria-labelledby="head-map-title">
        <div className="panel-heading">
          <h2 id="head-map-title">{target ? 'Your path and the model’s' : 'Your vowel space'}</h2>
          {target && <span className="trace-key"><i className="hd-key-model" />Model voice <i className="hd-key-you" />You</span>}
        </div>
        <VowelPlot trace={trace} point={point} faded={!tracking && session.phase !== 'finished'}
          overlay={target ? (textScale) => <HeadOverlay target={target} snapshot={snapshot} watching={watching} textScale={textScale} /> : undefined} />
        <div className="map-caption" data-testid="head-caption">
          {target ? <><span className="hd-zone-key" />Close zone: within the model voice’s own repeat-to-repeat range <span className="caption-divider">/</span> Sized to your voice (approximate)</>
            : <><span className="legend-dot" />Your sound. The model’s path appears after the voice check.</>}
        </div>
      </section>

      <aside className="practice-panel game-panel" aria-label="Say head">
        <div className="session-heading"><span className="eyebrow">{profile ? 'Say “head”' : '1 · Voice check'}</span>
          {snapshot && <span className="timer" data-testid="head-streak">{snapshot.streak} / {MATCH_STREAK} in a row</span>}</div>
        {session.phase === 'error' && session.error && <p className="game-error" role="alert">{session.error}</p>}
        <audio ref={audio} src={MODEL_AUDIO} preload="auto" onError={() => setAudioMissing(true)} />

        {stage.kind === 'intro' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Size the model to your voice</h2>
            <p>Hold one relaxed “uh” for about a second. It measures how big your voice is, not how well you speak.</p>
          </div>
          <p className="tg-question">Pick the closest voice.</p>
          <div className="tg-places tg-groups" role="group" aria-label="Closest voice">
            {GROUPS.map(([value, label]) => <button key={value} type="button" aria-pressed={group === value} onClick={() => setGroup(value)}>{label}</button>)}
          </div>
          <div className="controls"><button type="button" className="button-primary" onClick={beginCheck} disabled={!group}>Start voice check</button></div>
          {reusable && <div className="tg-reuse">
            <span>Use your last voice check? <small>{ago(reusable.measuredAt)}</small></span>
            <button type="button" className="button-secondary" onClick={reuse}>Skip, use last check</button>
          </div>}
          {lessonPicker}
        </>}

        {stage.kind === 'checking' && <CheckPanel prompts={stage.prompts} state={stage.state} micOn={micOn} requesting={session.phase === 'requesting'} onCancel={stop} />}

        {stage.kind === 'failed' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Voice check not finished</h2>
            <p>Didn’t hear “uh” clearly. Hold it a little longer, closer to the microphone.</p>
          </div>
          <div className="controls"><button type="button" className="button-primary" onClick={beginCheck}>Try the voice check again</button></div>
        </>}

        {stage.kind === 'ready' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Say “head” like the model voice</h2>
            <p>The teal line is the model voice saying “head”, sized to your voice. It starts at the hollow dot. Keep your path inside the shaded zone.</p>
          </div>
          <div className="controls">
            <button type="button" className="button-primary" onClick={practise}>Start</button>
            <WatchButton onClick={watch} disabled={!canWatch} audioMissing={audioMissing} />
          </div>
          <button type="button" className="game-text-button" onClick={() => setStage({ kind: 'intro' })}>Redo voice check</button>
          {lessonPicker}
        </>}

        {snapshot && <>
          <PracticeStatus snapshot={snapshot} threshold={MODEL.threshold} />
          <AttemptStrip attempts={snapshot.attempts} />
          {snapshot.phase !== 'matched' && <p className={`game-mic ${tracking ? 'is-tracking' : ''}`} data-testid="game-mic">
            {micOn ? (tracking ? 'Hearing a steady vowel' : 'No clear vowel right now') : session.phase === 'requesting' ? 'Allow microphone access' : session.stale ? 'Audio paused. Return to this tab.' : 'Microphone off'}</p>}
          <div className="controls">
            {snapshot.phase === 'matched'
              ? <button type="button" className="button-primary" onClick={practise}>Practise again</button>
              : <WatchButton onClick={watch} disabled={!canWatch} audioMissing={audioMissing} />}
            <button type="button" className="button-secondary" onClick={stop}>Stop</button>
          </div>
        </>}

        {session.phase === 'running' && !snapshot && stage.kind !== 'checking' && <button type="button" className="game-text-button" onClick={session.finish}>Turn off microphone</button>}
        <p className="game-boundary">Distances are measured against one American English model voice, sized to your voice. They are not a judgement of your speech, and this is not a substitute for a licensed speech-language pathologist.</p>
      </aside>
    </div>
  );
}

function WatchButton({ onClick, disabled, audioMissing }: { onClick: () => void; disabled: boolean; audioMissing: boolean }) {
  return <button type="button" className="button-secondary" onClick={onClick} disabled={disabled}>{audioMissing ? 'Watch the model' : 'Watch and hear the model'}</button>;
}

function PracticeStatus({ snapshot, threshold }: { snapshot: HeadSnapshot; threshold: number }) {
  const last = snapshot.attempts.at(-1);
  let [title, hint] = ['Say “heeead”, slowly', 'Stretch the vowel for about a second. Your path draws in blue as you speak.'];
  if (snapshot.phase === 'matched') [title, hint] = [`Matched the model voice: ${MATCH_STREAK} in a row`, 'Your last three paths stayed within the model voice’s own repeat-to-repeat range.'];
  else if (snapshot.phase === 'hearing') [title, hint] = ['Hearing you', 'Keep going to the “d”.'];
  else if (last?.outcome === 'unheard') [title, hint] = ['Not heard clearly', 'Not counted. Stretch the vowel a little longer, closer to the microphone.'];
  else if (last) [title, hint] = [last.matched ? 'Close to the model' : 'Outside the close zone',
    `Distance ${last.distance!.toFixed(2)} · close is ${threshold.toFixed(2)} or less. ${last.matched ? 'Say it again the same way.' : 'Watch the model, then try again.'}`];
  return (
    <div className="status-copy game-copy" role="status" aria-live="polite" aria-atomic="true">
      <h2 data-testid="game-status" data-phase={snapshot.phase} data-matched={last?.matched ?? ''}>{title}</h2>
      <p>{hint}</p>
    </div>
  );
}

function AttemptStrip({ attempts }: { attempts: HeadAttempt[] }) {
  if (!attempts.length) return null;
  return (
    <ol className="hd-strip" aria-label="Attempts">
      {attempts.slice(-SHOWN_ATTEMPTS).map((attempt) => (
        <li key={attempt.index} data-testid={`attempt-${attempt.index}`} data-outcome={attempt.outcome} data-matched={attempt.matched ?? ''}
          className={attempt.outcome === 'unheard' ? 'is-unheard' : attempt.matched ? 'is-close' : 'is-far'}>
          <i aria-hidden="true">{attempt.outcome === 'unheard' ? '?' : ''}</i>
          <span>{attempt.outcome === 'unheard' ? '—' : attempt.distance!.toFixed(2)}</span>
          <span className="sr-only">{attempt.outcome === 'unheard' ? 'Not heard clearly' : attempt.matched ? 'Close to the model' : 'Outside the close zone'}</span>
        </li>
      ))}
    </ol>
  );
}

const poly = (points: readonly Formants[]) => points.map((p) => { const q = projectVowel(p); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(' ');

/** The zone each model point allows: `threshold` /ɛ/ radii in log Hz, so the drawn edge is the scored edge. */
function zone(p: Formants, threshold: number, steps = 28): Formants[] {
  return Array.from({ length: steps }, (_, i) => {
    const angle = (2 * Math.PI * i) / steps;
    return { f1: p.f1 * Math.exp(threshold * EH_RADIUS_V1[0] * Math.sin(angle)), f2: p.f2 * Math.exp(threshold * EH_RADIUS_V1[1] * Math.cos(angle)) };
  });
}

function HeadOverlay({ target, snapshot, watching, textScale }: { target: Formants[]; snapshot: HeadSnapshot | null; watching: number; textScale: number }) {
  const measured = snapshot?.attempts.filter((attempt) => attempt.path) ?? [];
  const last = measured.at(-1);
  const earlier = measured.slice(-4, -1);
  const start = projectVowel(target[0]), end = projectVowel(target.at(-1)!);
  const top = Math.min(...target.flatMap((p) => zone(p, MODEL.threshold).map((q) => projectVowel(q).y)));
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const route = `M ${poly(target).replace(/ /g, ' L ')}`;
  return (
    <g className="hd-overlay" data-testid="head-overlay">
      <g className="hd-zone">{target.map((p, i) => <polygon key={i} points={poly(zone(p, MODEL.threshold))} />)}</g>
      <polyline className="hd-model" points={poly(target)} data-testid="head-model-path" />
      <circle className="hd-model-end" cx={end.x} cy={end.y} r={3} />
      <circle className="tg-start hd-model-start" cx={start.x} cy={start.y} r={6} />
      <text className="hd-label" x={start.x} y={top - 6 * textScale} textAnchor="middle" style={{ fontSize: 13 * textScale }}>head</text>
      {earlier.map((attempt) => <polyline key={attempt.index} className="hd-past" points={poly(attempt.path!)} />)}
      {last && <g className={`hd-last${last.matched ? ' is-close' : ''}`} data-testid="head-last-path">
        <polyline points={poly(last.path!)} />
        {last.path!.map((p, i) => { const q = projectVowel(p); return <circle key={i} cx={q.x} cy={q.y} r={i === 0 ? 4 : 2.2} />; })}
      </g>}
      {snapshot && snapshot.live.length > 1 && <polyline className="hd-live" points={poly(snapshot.live)} data-testid="head-live-path" />}
      {watching > 0 && !reduceMotion && <circle key={watching} className="hd-watch" r={7} cx={0} cy={0}>
        <animateMotion dur={`${(MODEL.durationMs ?? 1200) / 1000}s`} begin={`${(MODEL.audioLeadMs ?? 0) / 1000}s`} fill="freeze" path={route} />
      </circle>}
    </g>
  );
}
