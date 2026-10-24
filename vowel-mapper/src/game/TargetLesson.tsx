import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { TrackedFrame, VowelPoint } from '../audio/tracker';
import { projectVowel } from '../components/plot';
import { VowelPlot } from '../components/VowelPlot';
import { centre, outline } from '../reference/check';
import type { useVowelSession } from '../useVowelSession';
import type { FrameListener } from './GameMode';
import {
  RINGS, TARGET_STEPS, TargetRound, VoiceCheck,
  type CheckPrompt, type Place, type TargetNote, type TargetSnapshot, type TargetSound, type TargetStep, type VoiceCheckState, type VoiceGroup, type VoiceProfile,
} from './targets';
import './targets.css';

const RECENT_TRACE_MS = 3000;
const REF = { ee: 'iy', ah: 'ah' } as const;
const SOUND = { ee: 'eee', ah: 'ah' } as const;
export const GROUPS: [VoiceGroup, string][] = [['men', 'Man'], ['women', 'Woman'], ['boys', 'Boy'], ['girls', 'Girl']];

type Stage =
  | { kind: 'intro' }
  | { kind: 'checking'; prompts: readonly CheckPrompt[]; state: VoiceCheckState | null }
  | { kind: 'failed'; missed: string[] }
  | { kind: 'ready' }
  | { kind: 'playing'; snapshot: TargetSnapshot }
  | { kind: 'finished'; snapshot: TargetSnapshot };

type Engine = { kind: 'check'; check: VoiceCheck } | { kind: 'round'; round: TargetRound };

interface Props {
  session: ReturnType<typeof useVowelSession>;
  frames: MutableRefObject<FrameListener | null>;
  point: VowelPoint | null;
  tracking: boolean;
  lessonPicker: ReactNode;
  /** The last voice check from this page visit, offered as "Same place as last time?". Never stored. */
  saved: VoiceProfile | null;
  onChecked: (profile: VoiceProfile) => void;
}

/** Hold ee and ah towards reference targets sized to the player's voice; scored in graded rings. */
export function TargetLesson({ session, frames, point, tracking, lessonPicker, saved, onChecked }: Props) {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [place, setPlace] = useState<Place>(saved?.place ?? 'quiet');
  const [canSayWords, setCanSayWords] = useState(true);
  const [group, setGroup] = useState<VoiceGroup | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'intro' });
  const engine = useRef<Engine | null>(null);

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
      } else setStage({ kind: 'failed', missed: state.missed });
      return;
    }
    const snapshot = current.round.push(frame);
    if (snapshot.phase === 'finished') {
      engine.current = null;
      setStage({ kind: 'finished', snapshot });
    } else setStage({ kind: 'playing', snapshot });
  }, [onChecked]);

  useEffect(() => {
    frames.current = onFrame;
    return () => { frames.current = null; };
  }, [frames, onFrame]);

  // Frame timestamps restart with the microphone, so an interrupted check or round cannot continue.
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
    if (!canSayWords && !group) return;
    const check = new VoiceCheck(place, canSayWords ? { kind: 'words' } : { kind: 'uh', group: group! });
    engine.current = { kind: 'check', check };
    setStage({ kind: 'checking', prompts: check.prompts, state: null });
    ensureMicrophone();
  };
  const reuse = () => {
    if (!saved) return;
    setProfile(saved);
    setStage({ kind: 'ready' });
  };
  const play = () => {
    if (!profile) return;
    const round = new TargetRound(TARGET_STEPS, profile);
    engine.current = { kind: 'round', round };
    setStage({ kind: 'playing', snapshot: round.snapshot() });
    ensureMicrophone();
  };
  const beginAttempt = () => {
    const current = engine.current;
    if (current?.kind === 'round') setStage({ kind: 'playing', snapshot: current.round.beginAttempt() });
  };
  const stop = () => {
    engine.current = null;
    session.finish();
    setStage(profile ? { kind: 'ready' } : { kind: 'intro' });
  };

  const latest = session.frame?.timestampMs ?? 0;
  const trace = session.trace.filter((sample) => sample.timestampMs >= latest - RECENT_TRACE_MS);
  const micOn = session.phase === 'running' && !session.stale;
  const snapshot = stage.kind === 'playing' || stage.kind === 'finished' ? stage.snapshot : null;
  const currentIndex = stage.kind === 'playing' ? stage.snapshot.current : null;
  const step = currentIndex === null ? undefined : TARGET_STEPS[currentIndex];
  const note = currentIndex === null ? undefined : snapshot?.notes[currentIndex];
  const previous = currentIndex ? snapshot?.notes[currentIndex - 1] : undefined;
  const shown = profile;

  return (
    <div className={`workspace game-workspace${stage.kind === 'playing' ? ' is-playing' : ''}`}>
      <section className="map-panel" aria-labelledby="target-map-title">
        {stage.kind === 'playing' && step && note && snapshot && <div className="game-live-cue">
          <div className="session-heading"><span className="eyebrow">Reach the targets</span><span className="timer" data-testid="game-progress">{(currentIndex ?? 0) + 1} / {TARGET_STEPS.length}</span></div>
          <TargetStrip notes={snapshot.notes} current={currentIndex} />
          <div className="game-current"><TargetWord step={step} /><div><TargetPrompt step={step} note={note} previous={previous} noisy={profile?.place === 'noisy'} /></div></div>
        </div>}
        <div className="panel-heading">
          <h2 id="target-map-title">{shown ? 'Your targets' : 'Your vowel space'}</h2>
          <span className="trace-key"><i />Last 3 s of your sound</span>
        </div>
        <VowelPlot trace={trace} point={point} faded={!tracking && session.phase !== 'finished'} live={session.phase === 'running'}
          overlay={shown ? (textScale) => <TargetOverlay profile={shown} snapshot={snapshot} active={step?.sound} textScale={textScale} /> : undefined} />
        <div className="map-caption" data-testid="target-caption">
          {shown ? <><span className="tg-start-key" />Where you started <span className="caption-divider">/</span> Targets sized to your voice{shown.sizing === 'approximate' ? ' (approximate)' : ''} · American English reference</>
            : <><span className="legend-dot" />Your sound. Targets appear after the voice check.</>}
        </div>
      </section>

      <aside className="practice-panel game-panel" aria-label="Target practice">
        <div className="session-heading"><span className="eyebrow">{stage.kind === 'intro' || stage.kind === 'checking' || stage.kind === 'failed' ? '1 · Voice check' : 'Reach the targets'}</span></div>
        {session.phase === 'error' && session.error && <p className="game-error" role="alert">{session.error}</p>}

        {stage.kind === 'intro' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Size the targets to your voice</h2>
            <p>Hold a few short sounds for about a second each. This measures how big your voice is, not how well you speak.</p>
          </div>
          <div className="tg-places" role="group" aria-label="Where are you?">
            {(['quiet', 'noisy'] as const).map((value) => <button key={value} type="button" aria-pressed={place === value} onClick={() => setPlace(value)}>{value === 'quiet' ? 'Quiet room' : 'Noisy room'}</button>)}
          </div>
          {place === 'noisy' && <p className="game-caveat">In a noisy room, <strong>eee</strong> is shown but not scored. Noise and raised voices shift it. <strong>ah</strong> is still scored.</p>}
          <p className="tg-question">Can you say “head”, “had” and “heard”?</p>
          <div className="tg-places" role="group" aria-label="Can you say head, had and heard?">
            <button type="button" aria-pressed={canSayWords} onClick={() => setCanSayWords(true)}>Yes</button>
            <button type="button" aria-pressed={!canSayWords} onClick={() => setCanSayWords(false)}>Not yet</button>
          </div>
          {!canSayWords && <>
            <p className="tg-question">Pick the closest voice. You’ll hold one relaxed “uh”.</p>
            <div className="tg-places tg-groups" role="group" aria-label="Closest voice">
              {GROUPS.map(([value, label]) => <button key={value} type="button" aria-pressed={group === value} onClick={() => setGroup(value)}>{label}</button>)}
            </div>
          </>}
          <div className="controls"><button type="button" className="button-primary" onClick={beginCheck} disabled={!canSayWords && !group}>Start voice check</button></div>
          {saved && <div className="tg-reuse">
            <span>Same place as last time? <small>{saved.place === 'quiet' ? 'Quiet room' : 'Noisy room'} · {ago(saved.measuredAt)}</small></span>
            <button type="button" className="button-secondary" onClick={reuse}>Skip, use last check</button>
          </div>}
          {lessonPicker}
        </>}

        {stage.kind === 'checking' && <CheckPanel prompts={stage.prompts} state={stage.state} micOn={micOn} requesting={session.phase === 'requesting'} onCancel={stop} />}

        {stage.kind === 'failed' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Voice check not finished</h2>
            <p>Didn’t hear {stage.missed.map((word) => `“${word}”`).join(', ')} clearly. Hold the vowel a little longer, closer to the microphone.</p>
          </div>
          <div className="controls"><button type="button" className="button-primary" onClick={beginCheck}>Try the voice check again</button></div>
        </>}

        {stage.kind === 'ready' && profile && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Your targets are ready</h2>
            <p>Hold each vowel and see which ring you reach. Ring 1 is closest. The hollow dot is where you started.</p>
          </div>
          {profile.sizing === 'approximate' && <p className="game-caveat" data-testid="approximate-note">Targets are sized approximately, from your “uh” and the voice you picked. A speech-language pathologist can help check them.</p>}
          {profile.place === 'noisy' && <p className="game-caveat" data-testid="noisy-note">Noisy room: <strong>eee</strong> is shown but not scored.</p>}
          <div className="controls"><button type="button" className="button-primary" onClick={play}>Play</button></div>
          <button type="button" className="game-text-button" onClick={() => setStage({ kind: 'intro' })}>Redo voice check</button>
          {lessonPicker}
        </>}

        {stage.kind === 'playing' && note && <>
          <p className={`game-mic ${tracking ? 'is-tracking' : ''}`} data-testid="game-mic">{micOn ? (tracking ? 'Hearing a steady vowel' : 'No clear vowel right now') : session.phase === 'requesting' ? 'Allow microphone access' : session.stale ? 'Audio paused. Return to this tab.' : 'Microphone off'}</p>
          <div className="controls">{note.status === 'waiting' && <button type="button" className="button-primary" onClick={beginAttempt}>Try this word</button>}<button type="button" className="button-secondary" onClick={stop}>Stop</button></div>
        </>}

        {stage.kind === 'finished' && <TargetResults snapshot={stage.snapshot} onPlay={play} onRedo={() => setStage({ kind: 'intro' })} />}
        {session.phase === 'running' && stage.kind !== 'playing' && stage.kind !== 'checking' && <button type="button" className="game-text-button" onClick={session.finish}>Turn off microphone</button>}
        <p className="game-boundary">Rings show measured distance from an American English reference, sized to your voice. They are not a judgement of your speech, and this is not a substitute for a licensed speech-language pathologist.</p>
      </aside>
    </div>
  );
}

export function ago(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
}

export function CheckPanel({ prompts, state, micOn, requesting, onCancel }: { prompts: readonly CheckPrompt[]; state: VoiceCheckState | null; micOn: boolean; requesting: boolean; onCancel: () => void }) {
  const index = state && state.kind !== 'done' ? state.index : 0;
  const prompt = prompts[index];
  const collecting = state?.kind === 'collecting' ? state : null;
  const [title, hint] = requesting ? ['Allow microphone access', 'Look for your browser’s microphone permission prompt.']
    : !state || !micOn ? ['Starting the microphone', 'The check begins as soon as audio arrives.']
    : collecting ? [`Say “${prompt.word}”, hold ${prompt.say}`, 'Keep it steady until the bar fills.']
    : [`Next: “${prompt.word}”`, 'Take a breath. Start when the prompt changes.'];
  return <>
    <ol className="game-phases tg-phases" aria-label="Voice check words">
      {prompts.map((p, i) => <li key={p.word} className={i < index ? 'is-done' : i === index ? 'is-active' : ''}>
        <strong>{p.word}</strong><small>{p.start ? 'start' : 'voice size'}</small>
      </li>)}
    </ol>
    <div className="status-copy game-copy" role="status" aria-live="polite" aria-atomic="true">
      <h2 data-testid="game-status">{title}</h2>
      <p>{hint}</p>
    </div>
    <div className="game-meter" aria-hidden={!collecting}>
      <span>Heard clearly</span>
      <span className="game-meter-count">{collecting ? `${collecting.collected} / ${collecting.target}` : '—'}</span>
      <div className="game-bar"><i style={{ width: `${collecting ? 100 * collecting.collected / collecting.target : 0}%` }} /></div>
    </div>
    <div className="controls"><button type="button" className="button-secondary" onClick={onCancel}>Cancel</button></div>
  </>;
}

function TargetWord({ step }: { step: TargetStep }) {
  const [before, vowel, after] = step.letters;
  return (
    <div className="game-word" data-testid="game-word" aria-label={`Word: ${step.word}`}>
      {before && <span className="is-cue"><b>{before}</b><small>not scored</small></span>}
      <span className="is-sound"><b>{vowel}</b><small>{SOUND[step.sound]}</small></span>
      {after && <span className="is-cue"><b>{after}</b><small>not scored</small></span>}
    </div>
  );
}

function noteResult(note: TargetNote): [string, string] {
  if (note.outcome === 'unheard') return ['Not heard clearly', 'Not counted. The microphone couldn’t follow a steady vowel.'];
  if (note.outcome === 'unscored') return ['Heard · not scored', 'eee isn’t scored in a noisy room.'];
  const ring = note.ring ? `Ring ${note.ring} of 3` : 'Beyond the rings';
  const trend = note.trend === 'closer' ? 'Closer than your start' : note.trend === 'farther' ? 'Farther than your start' : note.trend === 'similar' ? 'About the same as your start' : '';
  return [ring, trend];
}

function TargetPrompt({ step, note, previous, noisy }: { step: TargetStep; note: TargetNote; previous?: TargetNote; noisy: boolean }) {
  const sound = SOUND[step.sound];
  let [title, hint] = [`Say “${step.word}”, hold ${sound}`, `Aim for the middle of the ${sound} rings.`];
  if (noisy && step.sound === 'ee') hint = `Shown on the map, not scored in a noisy room.`;
  if (note.status === 'resting' && previous?.outcome) [title, hint] = noteResult(previous);
  else if (note.status === 'resting') [title, hint] = ['Get ready', `First word: “${step.word}”.`];
  else if (note.status === 'waiting') hint = `${hint} Start whenever you’re ready. If nothing happens, choose “Try this word”.`;
  const outcome = note.status === 'resting' ? previous?.outcome : undefined;
  return (
    <div className="status-copy game-copy" role="status" aria-live="polite" aria-atomic="true">
      <h2 data-testid="game-status" data-outcome={outcome}>{title}</h2>
      <p>{hint}</p>
    </div>
  );
}

/** Three nested rings; every ring from the outside in to the one reached fills. */
function RingGlyph({ note }: { note?: TargetNote }) {
  const ring = note?.outcome === 'measured' ? note.ring ?? 4 : null;
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={`game-glyph tg-glyph is-${note?.outcome ?? 'pending'}`}>
      {note?.outcome === 'unheard' ? <><circle cx="8" cy="8" r="5.5" className="glyph-unheard" /><text x="8" y="11" textAnchor="middle">?</text></>
        : note?.outcome === 'unscored' ? <circle cx="8" cy="8" r="5.5" className="tg-unscored" />
        : ring === null ? <circle cx="8" cy="8" r="2.5" className="glyph-pending" />
        : [7, 5, 3].map((r, i) => <circle key={r} cx="8" cy="8" r={r} className={3 - i >= ring ? 'is-reached' : ''} />)}
    </svg>
  );
}

function TargetStrip({ notes, current }: { notes: TargetNote[]; current: number | null }) {
  return (
    <ol className="game-strip" aria-label="Words">
      {notes.map((note, i) => (
        <li key={i} className={i === current ? 'is-current' : ''} data-testid={`outcome-${i}`} data-outcome={note.outcome ?? ''} data-ring={note.ring ?? ''}>
          <RingGlyph note={note} />
          <span>{TARGET_STEPS[i].word}</span>
          <span className="sr-only">{note.outcome ? noteResult(note)[0] : i === current ? 'Now' : 'Coming up'}</span>
        </li>
      ))}
    </ol>
  );
}

function TargetResults({ snapshot, onPlay, onRedo }: { snapshot: TargetSnapshot; onPlay: () => void; onRedo: () => void }) {
  const scored = snapshot.notes.filter((note) => note.outcome === 'measured');
  const closer = scored.filter((note) => note.trend === 'closer').length;
  return <>
    <div className="status-copy game-copy" role="status" aria-live="polite" aria-atomic="true">
      <h2 data-testid="game-status">{scored.length ? `${closer} of ${scored.length} closer than your start` : 'Nothing scored this round'}</h2>
      <p>Rings measure distance only. Ring 1 is the closest band.</p>
    </div>
    <ul className="game-results tg-results">
      {snapshot.notes.map((note, i) => {
        const [result, detail] = noteResult(note);
        return <li key={i} data-testid={`result-${i}`} data-outcome={note.outcome ?? ''} data-ring={note.ring ?? ''}>
          <RingGlyph note={note} /><b>{TARGET_STEPS[i].word}</b><span>{result}{note.outcome === 'measured' && detail && <small>{detail}</small>}</span>
        </li>;
      })}
    </ul>
    <div className="controls">
      <button type="button" className="button-primary" onClick={onPlay}>Play again</button>
      <button type="button" className="button-secondary" onClick={onRedo}>Redo voice check</button>
    </div>
  </>;
}

/** Graded rings around each voice-sized target, the starting position, and a line to the latest attempt. */
function TargetOverlay({ profile, snapshot, active, textScale }: { profile: VoiceProfile; snapshot: TargetSnapshot | null; active?: TargetSound; textScale: number }) {
  const poly = (points: { f1: number; f2: number }[]) => points.map((p) => { const q = projectVowel(p); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(' ');
  const latest = (sound: TargetSound) => snapshot?.notes.filter((note) => note.value && TARGET_STEPS[note.index].sound === sound).at(-1)?.value;
  return (
    <g className="tg-overlay" data-testid="target-overlay">
      {(['ee', 'ah'] as const).map((sound) => {
        const unscored = sound === 'ee' && profile.place === 'noisy';
        const c = projectVowel(centre(REF[sound], profile.factor));
        // Labels sit above the outer ring so the start and attempt dots never hide them.
        const top = Math.min(...outline(REF[sound], profile.factor, RINGS[2]).map((p) => projectVowel(p).y));
        const bottom = Math.max(...outline(REF[sound], profile.factor, RINGS[2]).map((p) => projectVowel(p).y));
        const start = profile.start[sound] && projectVowel(profile.start[sound]!);
        const last = latest(sound), end = last && projectVowel(last);
        return (
          <g key={sound} className={`tg-target tg-${sound}${active === sound ? ' is-active' : ''}${unscored ? ' is-unscored' : ''}`} data-testid={`target-${sound}`}>
            {[...RINGS].reverse().map((r) => <polygon key={r} points={poly(outline(REF[sound], profile.factor, r))} />)}
            <text x={c.x} y={top - 6 * textScale} textAnchor="middle" style={{ fontSize: 13 * textScale }}>{SOUND[sound]}</text>
            {unscored && <text className="tg-note" x={c.x} y={bottom + 14 * textScale} textAnchor="middle" style={{ fontSize: 10 * textScale }}>not scored in noise</text>}
            {start && end && <line className="tg-path" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />}
            {start && <circle className="tg-start" cx={start.x} cy={start.y} r={6} data-testid={`start-${sound}`} />}
            {end && <circle className="tg-latest" cx={end.x} cy={end.y} r={4.5} />}
          </g>
        );
      })}
    </g>
  );
}
