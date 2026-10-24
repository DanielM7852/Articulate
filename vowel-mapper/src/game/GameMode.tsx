import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { TrackedFrame, VowelPoint } from '../audio/tracker';
import { VowelPlot } from '../components/VowelPlot';
import type { useVowelSession } from '../useVowelSession';
import type { Step } from './beatmap';
import { WarmUp, type CalibrationProblem, type WarmUpState } from './calibration';
import { GameOverlay } from './GameOverlay';
import { LESSONS, calibrationKey, lessonAvailability, saveCalibration, zonesForLesson, type GameCalibrations } from './lessons';
import { GameRun, type GameOptions, type GameSnapshot, type NoteState, type Outcome } from './run';
import { TargetLesson } from './TargetLesson';
import type { VoiceProfile } from './targets';
import { VOWEL_LABEL, VOWELS, type VowelId } from './zones';
import './game.css';

export type FrameListener = (frame: TrackedFrame) => void;

interface GameModeProps {
  calibrations: GameCalibrations;
  setCalibrations: (calibrations: GameCalibrations) => void;
  voiceProfile: VoiceProfile | null;
  setVoiceProfile: (profile: VoiceProfile) => void;
  session: ReturnType<typeof useVowelSession>;
  frames: MutableRefObject<FrameListener | null>;
  point: VowelPoint | null;
  tracking: boolean;
}

type Stage =
  | { kind: 'intro' }
  | { kind: 'warmup'; state: WarmUpState | null }
  | { kind: 'failed'; problems: CalibrationProblem[] }
  | { kind: 'ready' }
  | { kind: 'playing'; snapshot: GameSnapshot; options: GameOptions }
  | { kind: 'finished'; snapshot: GameSnapshot };

type WarmUpSpec = { key: string; vowels: readonly VowelId[] };
type Engine =
  | { kind: 'warmup'; warmUp: WarmUp; spec: WarmUpSpec; saved: GameCalibrations }
  | { kind: 'play'; run: GameRun; lessonId: string };

const TEMPOS = [{ label: 'Relaxed · at least 5 s per word', spacingMs: 5000 }, { label: 'Steady · at least 3.5 s per word', spacingMs: 3500 }];
const sound = (vowel: keyof typeof VOWEL_LABEL) => VOWEL_LABEL[vowel].sound;
const RECENT_TRACE_MS = 3000;
const BASE_WARMUP: WarmUpSpec = { key: 'base', vowels: VOWELS };

/** The default lesson: voice-sized reference targets. Every other lesson uses zones set from the player's own voice. */
const TARGET_LESSON = 'targets';

export function GameMode(props: GameModeProps) {
  const [lessonId, setLessonId] = useState(TARGET_LESSON);
  const picker = <LessonPicker value={lessonId} onChange={setLessonId} />;
  return lessonId === TARGET_LESSON
    ? <TargetLesson session={props.session} frames={props.frames} point={props.point} tracking={props.tracking} lessonPicker={picker}
      saved={props.voiceProfile} onChecked={props.setVoiceProfile} />
    : <RouteGame {...props} lessonId={lessonId} lessonPicker={picker} />;
}

function LessonPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <label className="game-lesson">Lesson<select aria-label="Lesson" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value={TARGET_LESSON}>Reach the targets · eee and ah</option>
      {LESSONS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label>
  );
}

function RouteGame({ calibrations, setCalibrations, session, frames, point, tracking, lessonId, lessonPicker }: GameModeProps & { lessonId: string; lessonPicker: ReactNode }) {
  const [stage, setStage] = useState<Stage>(calibrations.base ? { kind: 'ready' } : { kind: 'intro' });
  const [warmUpSpec, setWarmUpSpec] = useState(BASE_WARMUP);
  const [summaries, setSummaries] = useState<Record<string, GameSnapshot['tally']>>({});
  const [pacing, setPacing] = useState<'self' | 'timed'>('self');
  const [spacingMs, setSpacingMs] = useState(TEMPOS[0].spacingMs);
  const engine = useRef<Engine | null>(null);
  const lesson = LESSONS.find((item) => item.id === lessonId)!;
  const steps = lesson.steps;
  const zones = zonesForLesson(lesson, calibrations);
  const availability = lessonAvailability(lesson, zones);

  const onFrame = useCallback((frame: TrackedFrame) => {
    const current = engine.current;
    if (!current) return;
    if (current.kind === 'warmup') {
      const state = current.warmUp.push(frame);
      if (state.kind !== 'done') { setStage({ kind: 'warmup', state }); return; }
      engine.current = null;
      if (state.result.ok) {
        setCalibrations(saveCalibration(current.saved, current.spec.key, state.result.zones));
        setStage({ kind: 'ready' });
      } else setStage({ kind: 'failed', problems: state.result.problems });
      return;
    }
    const snapshot = current.run.push(frame);
    if (snapshot.phase === 'finished') {
      engine.current = null;
      setSummaries((previous) => ({ ...previous, [current.lessonId]: snapshot.tally }));
      setStage({ kind: 'finished', snapshot });
    } else setStage({ kind: 'playing', snapshot, options: current.run.options });
  }, [setCalibrations]);

  useEffect(() => {
    frames.current = onFrame;
    return () => { frames.current = null; };
  }, [frames, onFrame]);

  // Frame timestamps restart with the microphone, so an interrupted round cannot continue.
  useEffect(() => {
    if ((session.phase === 'finished' || session.phase === 'error') && engine.current) {
      engine.current = null;
      setStage(calibrations.base ? { kind: 'ready' } : { kind: 'intro' });
    }
  }, [session.phase, calibrations.base]);

  const ensureMicrophone = () => {
    if (session.phase !== 'running' && session.phase !== 'requesting') void session.start();
  };
  const beginWarmUp = (spec: WarmUpSpec = BASE_WARMUP) => {
    setWarmUpSpec(spec);
    engine.current = { kind: 'warmup', warmUp: new WarmUp({ vowels: spec.vowels }), spec, saved: calibrations };
    setStage({ kind: 'warmup', state: null });
    ensureMicrophone();
  };
  const play = () => {
    if (availability.kind !== 'ready') return;
    const run = new GameRun(steps, zones, { pacing: pacing === 'self' ? { kind: 'self' } : { kind: 'timed', spacingMs } });
    engine.current = { kind: 'play', run, lessonId };
    setStage({ kind: 'playing', snapshot: run.snapshot(), options: run.options });
    ensureMicrophone();
  };
  const beginAttempt = () => {
    const current = engine.current;
    if (current?.kind === 'play') setStage({ kind: 'playing', snapshot: current.run.beginAttempt(), options: current.run.options });
  };
  const stop = () => {
    engine.current = null;
    session.finish();
    setStage(calibrations.base ? { kind: 'ready' } : { kind: 'intro' });
  };
  const chooseLesson = () => setStage({ kind: 'ready' });

  const latest = session.frame?.timestampMs ?? 0;
  const trace = session.trace.filter((sample) => sample.timestampMs >= latest - RECENT_TRACE_MS);
  const playing = stage.kind === 'playing' ? stage : null;
  const currentIndex = playing?.snapshot.current ?? null;
  const step = currentIndex === null ? undefined : steps[currentIndex];
  const note = currentIndex === null ? undefined : playing?.snapshot.notes[currentIndex];
  const micOn = session.phase === 'running' && !session.stale;
  const hasZones = Object.keys(zones).length > 0;
  const previousSummary = summaries[lessonId];

  return (
    <div className={`workspace game-workspace${playing ? ' is-playing' : ''}`}>
      <section className="map-panel" aria-labelledby="game-map-title">
        {playing && step && note && <div className="game-live-cue">
          <div className="session-heading"><span className="eyebrow">{lesson.title}</span><span className="timer" data-testid="game-progress">{(currentIndex ?? 0) + 1} / {steps.length}</span></div>
          <OutcomeStrip steps={steps} notes={playing.snapshot.notes} current={currentIndex} />
          <div className="game-current"><WordCard step={step} /><div><NotePrompt step={step} note={note} previous={currentIndex ? playing.snapshot.notes[currentIndex - 1] : undefined} timeMs={playing.snapshot.timeMs} /></div></div>
          {step.caveat && <p className="game-caveat" role="note">{step.caveat}</p>}
        </div>}
        <div className="panel-heading">
          <h2 id="game-map-title">{hasZones ? 'Your zones' : 'Your vowel space'}</h2>
          <span className="trace-key"><i />Last 3 s of your sound</span>
        </div>
        <VowelPlot trace={trace} point={point} faded={!tracking && session.phase !== 'finished'}
          overlay={hasZones ? (textScale) => <GameOverlay zones={zones} textScale={textScale} step={step} note={note} options={playing?.options} timeMs={playing?.snapshot.timeMs} /> : undefined} />
        <div className="map-caption"><span className="legend-dot" />Your sound, over the zones you set in the warm-up</div>
      </section>

      <aside className="practice-panel game-panel" aria-label="Zone game">
        <div className="session-heading"><span className="eyebrow">{stage.kind === 'warmup' || stage.kind === 'failed' || stage.kind === 'intro' ? '1 · Set personal zones' : stage.kind === 'finished' ? lesson.title : 'Zone game'}</span></div>
        {session.phase === 'error' && session.error && <p className="game-error" role="alert">{session.error}</p>}

        {stage.kind === 'intro' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Set your zones first</h2>
            <p>Hold <strong>eee</strong>, <strong>ah</strong> and <strong>oo</strong> comfortably for about a second each. Each zone comes from your own voice.</p>
          </div>
          <div className="controls"><button type="button" className="button-primary" onClick={() => beginWarmUp()}>Start warm-up</button></div>
          {lessonPicker}
        </>}

        {stage.kind === 'warmup' && <WarmUpPanel vowels={warmUpSpec.vowels} state={stage.state} micOn={micOn} requesting={session.phase === 'requesting'} onCancel={stop} />}

        {stage.kind === 'failed' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Zones not set</h2>
            <ul className="game-problems">{stage.problems.map((problem) => <li key={problemKey(problem)}>{problemCopy(problem)}</li>)}</ul>
          </div>
          <div className="controls"><button type="button" className="button-primary" onClick={() => beginWarmUp(warmUpSpec)}>Redo warm-up</button>{calibrations.base && <button type="button" className="button-secondary" onClick={chooseLesson}>Choose lesson</button>}</div>
          <p className="control-note">Try a quieter spot or move closer to the microphone. Saved zones stay available.</p>
        </>}

        {stage.kind === 'ready' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite"><h2 data-testid="game-status">Your zones are set</h2><p>Choose a route. Consonant letters are cues only and are never scored.</p></div>
          {lessonPicker}
          <p className="game-description">{lesson.description}</p>
          {lesson.caveat && <p className="game-caveat">{lesson.caveat}</p>}
          {availability.kind === 'locked' && <p className="game-lock" data-testid="lesson-lock" role="note">{availability.reason}</p>}
          {availability.kind === 'calibrate' && <p className="game-calibration-note">Set this lesson’s own {availability.vowels.map(sound).join(' / ')} zones. Your base zones stay unchanged.</p>}
          {previousSummary && <p className="game-last-result">Last round: {previousSummary.hit} zones hit · {previousSummary.unheard} not heard clearly.</p>}
          <fieldset className="game-pacing" disabled={availability.kind === 'locked'}>
            <legend>Pace</legend>
            <label><input type="radio" name="pacing" checked={pacing === 'self'} onChange={() => setPacing('self')} />Wait for me</label>
            <label><input type="radio" name="pacing" checked={pacing === 'timed'} onChange={() => setPacing('timed')} />Timed rings</label>
            {pacing === 'timed' && <select aria-label="Tempo" value={spacingMs} onChange={(event) => setSpacingMs(Number(event.target.value))}>{TEMPOS.map((tempo) => <option key={tempo.spacingMs} value={tempo.spacingMs}>{tempo.label}</option>)}</select>}
          </fieldset>
          <div className="controls">
            {availability.kind === 'calibrate' ? <button type="button" className="button-primary" onClick={() => beginWarmUp({ key: calibrationKey(lesson), vowels: availability.vowels })}>Set lesson zones</button> : <button type="button" className="button-primary" onClick={play} disabled={availability.kind === 'locked'}>Play</button>}
          </div>
          <button type="button" className="game-text-button" onClick={() => beginWarmUp()}>Redo base warm-up</button>
          <p className="control-note">Zones stay while this page is open. Redoing the base warm-up clears extra lesson zones.</p>
        </>}

        {playing && step && note && <>
          <p className={`game-mic ${tracking ? 'is-tracking' : ''}`} data-testid="game-mic">{micOn ? (tracking ? 'Hearing a steady vowel' : 'No clear vowel right now') : session.phase === 'requesting' ? 'Allow microphone access' : session.stale ? 'Audio paused. Return to this tab.' : 'Microphone off'}</p>
          <div className="controls">{note.status === 'waiting' && <button type="button" className="button-primary" onClick={beginAttempt}>Try this word</button>}<button type="button" className="button-secondary" onClick={stop}>Stop</button></div>
          <p className="game-description">{lesson.caveat}</p>
        </>}

        {stage.kind === 'finished' && <Results steps={steps} snapshot={stage.snapshot} onPlay={play} onChoose={chooseLesson} />}
        {session.phase === 'running' && stage.kind !== 'playing' && stage.kind !== 'warmup' && <button type="button" className="game-text-button" onClick={session.finish}>Turn off microphone</button>}
        <p className="game-boundary">A hit means your sound reached a zone you set. It is not a judgement of your speech. Timing is visual only.</p>
      </aside>
    </div>
  );
}

function WarmUpPanel({ vowels, state, micOn, requesting, onCancel }: { vowels: readonly VowelId[]; state: WarmUpState | null; micOn: boolean; requesting: boolean; onCancel: () => void }) {
  const active = state?.kind === 'collecting' ? state.vowel : state?.kind === 'rest' ? state.next : vowels[0];
  const index = vowels.indexOf(active);
  const collecting = state?.kind === 'collecting' ? state : null;
  const [title, hint] = requesting ? ['Allow microphone access', 'Look for your browser’s microphone permission prompt.']
    : !state || !micOn ? ['Starting the microphone', 'The warm-up begins as soon as audio arrives.']
    : collecting ? [`Hold ${sound(collecting.vowel)}`, `As in “${VOWEL_LABEL[collecting.vowel].example}”. Keep it steady.`]
    : [`Next: ${sound(active)}`, 'Take a breath. Start when the prompt changes.'];
  return <>
    <ol className="game-phases" aria-label="Warm-up sounds">
      {vowels.map((vowel, i) => <li key={vowel} className={i < index ? 'is-done' : i === index ? 'is-active' : ''}>
        <strong>{sound(vowel)}</strong><small>{VOWEL_LABEL[vowel].example}</small>
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

function WordCard({ step }: { step: Step }) {
  return (
    <div className="game-word" data-testid="game-word" aria-label={`Word: ${step.word}`}>
      {step.segments.map((segment, i) => (
        <span key={i} className={segment.cue ? 'is-cue' : 'is-sound'}>
          <b>{segment.letters}</b>
          <small>{segment.cue ? `${segment.cue} · not scored` : segment.sounds!.map(sound).join(' → ')}</small>
        </span>
      ))}
    </div>
  );
}

function NotePrompt({ step, note, previous, timeMs }: { step: Step; note: NoteState; previous?: NoteState; timeMs: number }) {
  const spec = step.note;
  const action = spec.kind === 'glide' ? `Glide ${sound(spec.from)} → ${sound(spec.to)}` : `Hold ${sound(spec.vowel)}`;
  const detail = spec.kind === 'glide'
    ? `Start in ${sound(spec.from)}, end in ${sound(spec.to)}.`
    : `Keep ${sound(spec.vowel)} in its zone until the outline fills.`;
  let title = `Say “${step.word}”`;
  let hint = detail;
  if (note.status === 'resting' && previous?.outcome) [title, hint] = outcomeCopy(previous.outcome);
  else if (note.status === 'resting') [title, hint] = ['Get ready', `First word: “${step.word}”.`];
  else if (note.status === 'waiting') hint = `${detail} Start whenever you’re ready. If no vowel appears, choose “Try this word”.`;
  else if (note.status === 'approaching' || note.status === 'upcoming') [title, hint] = [`Say “${step.word}” as the ring closes`, detail];
  else if (note.status === 'open') [title, hint] = [action, detail];
  const remaining = note.status === 'open' ? Math.max(0, Math.min(1, (note.windowEndMs - timeMs) / (note.windowEndMs - note.windowStartMs))) : null;
  const outcome = note.status === 'resting' ? previous?.outcome : undefined;
  return <>
    <div className="status-copy game-copy" role="status" aria-live="polite" aria-atomic="true">
      <h2 data-testid="game-status" data-outcome={outcome}>{title}</h2>
      <p>{hint}</p>
    </div>
    <div className="game-window" aria-hidden="true"><i style={{ width: `${(remaining ?? 0) * 100}%` }} /></div>
  </>;
}

function outcomeCopy(outcome: Outcome): [string, string] {
  if (outcome === 'hit') return ['Hit', 'Your sound reached the zones you set.'];
  if (outcome === 'miss') return ['Missed the zone', 'You were heard, but the sound didn’t reach the zones in order.'];
  return ['Not heard clearly', 'Not counted. The microphone couldn’t follow a steady vowel.'];
}

const OUTCOME_LABEL: Record<Outcome, string> = { hit: 'Hit', miss: 'Missed', unheard: 'Not heard clearly' };

function OutcomeStrip({ steps, notes, current }: { steps: Step[]; notes: NoteState[]; current: number | null }) {
  return (
    <ol className="game-strip" aria-label="Words">
      {notes.map((note, i) => (
        <li key={i} className={`${note.outcome ? `is-${note.outcome}` : ''} ${i === current ? 'is-current' : ''}`} data-testid={`outcome-${i}`} data-outcome={note.outcome ?? ''}>
          <OutcomeGlyph outcome={note.outcome} />
          <span>{steps[i].word}</span>
          <span className="sr-only">{note.outcome ? OUTCOME_LABEL[note.outcome] : i === current ? 'Now' : 'Coming up'}</span>
        </li>
      ))}
    </ol>
  );
}

function OutcomeGlyph({ outcome }: { outcome?: Outcome }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="game-glyph">
      {outcome === 'hit' && <circle cx="8" cy="8" r="6" className="glyph-hit" />}
      {outcome === 'miss' && <><circle cx="8" cy="8" r="5.5" className="glyph-miss" /><path d="M4.5 11.5 11.5 4.5" className="glyph-miss" /></>}
      {outcome === 'unheard' && <><circle cx="8" cy="8" r="5.5" className="glyph-unheard" /><text x="8" y="11" textAnchor="middle">?</text></>}
      {!outcome && <circle cx="8" cy="8" r="2.5" className="glyph-pending" />}
    </svg>
  );
}

function Results({ steps, snapshot, onPlay, onChoose }: { steps: Step[]; snapshot: GameSnapshot; onPlay: () => void; onChoose: () => void }) {
  const { hit, miss, unheard } = snapshot.tally;
  const judged = hit + miss;
  return <>
    <div className="status-copy game-copy" role="status" aria-live="polite" aria-atomic="true">
      <h2 data-testid="game-status">{judged ? `${hit} of ${judged} zones hit` : 'Nothing heard clearly enough to judge'}</h2>
      <p data-testid="game-tally">{unheard ? `${unheard} not heard clearly, so not counted.` : 'Every word was heard clearly enough to judge.'}</p>
    </div>
    <ul className="game-results">
      {snapshot.notes.map((note, i) => (
        <li key={i} data-testid={`result-${i}`}><OutcomeGlyph outcome={note.outcome} /><b>{steps[i].word}</b><span>{note.outcome ? OUTCOME_LABEL[note.outcome] : ''}</span></li>
      ))}
    </ul>
    <div className="controls">
      <button type="button" className="button-primary" onClick={onPlay}>Play again</button>
      <button type="button" className="button-secondary" onClick={onChoose}>Choose lesson</button>
    </div>
  </>;
}

function problemKey(problem: CalibrationProblem) {
  return problem.kind === 'too-few-points' ? `few-${problem.vowel}` : `close-${problem.vowels.join('-')}`;
}

function problemCopy(problem: CalibrationProblem) {
  if (problem.kind === 'too-few-points') {
    return `${sound(problem.vowel)}: heard clearly for ${problem.count} of the ${problem.needed} frames needed. Hold it longer and steadier.`;
  }
  const [a, b] = problem.vowels.map(sound);
  return `${a} and ${b} landed in the same place, so the game can’t separate these zones. Try again comfortably; this lesson may not fit your voice or microphone.`;
}
