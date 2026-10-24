import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { TrackedFrame, VowelPoint } from '../audio/tracker';
import { VowelPlot } from '../components/VowelPlot';
import type { useVowelSession } from '../useVowelSession';
import { FIRST_BEATMAP, type Step } from './beatmap';
import { WarmUp, type CalibrationProblem, type WarmUpState } from './calibration';
import { GameOverlay } from './GameOverlay';
import { GameRun, type GameOptions, type GameSnapshot, type NoteState, type Outcome } from './run';
import { VOWEL_LABEL, VOWELS, type ZoneSet } from './zones';
import './game.css';

export type FrameListener = (frame: TrackedFrame) => void;

interface GameModeProps {
  zones: ZoneSet | null;
  setZones: (zones: ZoneSet) => void;
  session: ReturnType<typeof useVowelSession>;
  /** App forwards every tracked frame here; see `useVowelSession`'s `onFrame`. */
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

type Engine = { kind: 'warmup'; warmUp: WarmUp } | { kind: 'play'; run: GameRun };

const TEMPOS = [{ label: 'Relaxed · at least 5 s per word', spacingMs: 5000 }, { label: 'Steady · at least 3.5 s per word', spacingMs: 3500 }];
const sound = (vowel: keyof typeof VOWEL_LABEL) => VOWEL_LABEL[vowel].sound;
const RECENT_TRACE_MS = 3000;

export function GameMode({ zones, setZones, session, frames, point, tracking }: GameModeProps) {
  const [stage, setStage] = useState<Stage>(zones ? { kind: 'ready' } : { kind: 'intro' });
  const [pacing, setPacing] = useState<'self' | 'timed'>('self');
  const [spacingMs, setSpacingMs] = useState(TEMPOS[0].spacingMs);
  const engine = useRef<Engine | null>(null);

  const onFrame = useCallback((frame: TrackedFrame) => {
    const current = engine.current;
    if (!current) return;
    if (current.kind === 'warmup') {
      const state = current.warmUp.push(frame);
      if (state.kind !== 'done') { setStage({ kind: 'warmup', state }); return; }
      engine.current = null;
      if (state.result.ok) { setZones(state.result.zones); setStage({ kind: 'ready' }); }
      else setStage({ kind: 'failed', problems: state.result.problems });
      return;
    }
    const snapshot = current.run.push(frame);
    if (snapshot.phase === 'finished') { engine.current = null; setStage({ kind: 'finished', snapshot }); }
    else setStage({ kind: 'playing', snapshot, options: current.run.options });
  }, [setZones]);

  useEffect(() => {
    frames.current = onFrame;
    return () => { frames.current = null; };
  }, [frames, onFrame]);

  // Frame timestamps restart with the microphone, so an interrupted round cannot continue.
  useEffect(() => {
    if ((session.phase === 'finished' || session.phase === 'error') && engine.current) {
      engine.current = null;
      setStage(zones ? { kind: 'ready' } : { kind: 'intro' });
    }
  }, [session.phase, zones]);

  const ensureMicrophone = () => {
    if (session.phase !== 'running' && session.phase !== 'requesting') void session.start();
  };
  const beginWarmUp = () => {
    engine.current = { kind: 'warmup', warmUp: new WarmUp() };
    setStage({ kind: 'warmup', state: null });
    ensureMicrophone();
  };
  const play = () => {
    if (!zones) return;
    const run = new GameRun(FIRST_BEATMAP, zones, { pacing: pacing === 'self' ? { kind: 'self' } : { kind: 'timed', spacingMs } });
    engine.current = { kind: 'play', run };
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
    setStage(zones ? { kind: 'ready' } : { kind: 'intro' });
  };

  const latest = point?.timestampMs ?? 0;
  const trace = session.trace.filter((sample) => sample.timestampMs >= latest - RECENT_TRACE_MS);
  const playing = stage.kind === 'playing' ? stage : null;
  const currentIndex = playing?.snapshot.current ?? null;
  const step = currentIndex === null ? undefined : FIRST_BEATMAP[currentIndex];
  const note = currentIndex === null ? undefined : playing?.snapshot.notes[currentIndex];
  const micOn = session.phase === 'running' && !session.stale;

  return (
    <div className="workspace game-workspace">
      <section className="map-panel" aria-labelledby="game-map-title">
        <div className="panel-heading">
          <h2 id="game-map-title">{zones ? 'Your zones' : 'Your vowel space'}</h2>
          <span className="trace-key"><i />Last 3 s of your sound</span>
        </div>
        <VowelPlot
          trace={trace}
          point={point}
          faded={!tracking && session.phase !== 'finished'}
          overlay={zones ? (textScale) => <GameOverlay zones={zones} textScale={textScale} step={step} note={note} options={playing?.options} timeMs={playing?.snapshot.timeMs} /> : undefined}
        />
        <div className="map-caption"><span className="legend-dot" />Your sound, over the zones you set in the warm-up</div>
      </section>

      <aside className="practice-panel game-panel" aria-label="Zone game">
        <div className="session-heading">
          <span className="eyebrow">{stage.kind === 'warmup' || stage.kind === 'failed' || stage.kind === 'intro' ? 'Warm-up' : stage.kind === 'finished' ? 'Results' : 'Zone game'}</span>
          {playing && <span className="timer" data-testid="game-progress">{Math.min((currentIndex ?? FIRST_BEATMAP.length - 1) + 1, FIRST_BEATMAP.length)} / {FIRST_BEATMAP.length}</span>}
        </div>

        {session.phase === 'error' && session.error && <p className="game-error" role="alert">{session.error}</p>}

        {stage.kind === 'intro' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Set your zones first</h2>
            <p>Hold <strong>eee</strong>, <strong>ah</strong> and <strong>oo</strong> for about a second each. Each zone is placed where your own voice lands, so it fits how you speak.</p>
          </div>
          <div className="controls"><button type="button" className="button-primary" onClick={beginWarmUp}>Start warm-up</button></div>
        </>}

        {stage.kind === 'warmup' && <WarmUpPanel state={stage.state} micOn={micOn} requesting={session.phase === 'requesting'} onCancel={stop} />}

        {stage.kind === 'failed' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Zones not set</h2>
            <ul className="game-problems">{stage.problems.map((problem) => <li key={problemKey(problem)}>{problemCopy(problem)}</li>)}</ul>
          </div>
          <div className="controls"><button type="button" className="button-primary" onClick={beginWarmUp}>Redo warm-up</button></div>
          <p className="control-note">A quieter spot or moving closer to the microphone helps.</p>
        </>}

        {stage.kind === 'ready' && <>
          <div className="status-copy game-copy" role="status" aria-live="polite">
            <h2 data-testid="game-status">Your zones are set</h2>
            <p>Say four short words by moving between your zones. Letters like <strong>h</strong> are shown as cues and never scored.</p>
          </div>
          <fieldset className="game-pacing">
            <legend>Pace</legend>
            <label><input type="radio" name="pacing" checked={pacing === 'self'} onChange={() => setPacing('self')} />Wait for me</label>
            <label><input type="radio" name="pacing" checked={pacing === 'timed'} onChange={() => setPacing('timed')} />Timed rings</label>
            {pacing === 'timed' && <select aria-label="Tempo" value={spacingMs} onChange={(event) => setSpacingMs(Number(event.target.value))}>
              {TEMPOS.map((tempo) => <option key={tempo.spacingMs} value={tempo.spacingMs}>{tempo.label}</option>)}
            </select>}
          </fieldset>
          <div className="controls">
            <button type="button" className="button-primary" onClick={play}>Play</button>
            <button type="button" className="button-secondary" onClick={beginWarmUp}>Redo warm-up</button>
          </div>
        </>}

        {playing && step && note && <>
          <OutcomeStrip notes={playing.snapshot.notes} current={currentIndex} />
          <WordCard step={step} />
          <NotePrompt step={step} note={note} previous={currentIndex ? playing.snapshot.notes[currentIndex - 1] : undefined} timeMs={playing.snapshot.timeMs} />
          <p className={`game-mic ${tracking ? 'is-tracking' : ''}`} data-testid="game-mic">{micOn ? (tracking ? 'Hearing a steady vowel' : 'No clear vowel right now') : session.phase === 'requesting' ? 'Allow microphone access' : session.stale ? 'Audio paused. Return to this tab.' : 'Microphone off'}</p>
          <div className="controls">{note.status === 'waiting' && <button type="button" className="button-primary" onClick={beginAttempt}>Try this word</button>}<button type="button" className="button-secondary" onClick={stop}>Stop</button></div>
        </>}

        {stage.kind === 'finished' && <Results snapshot={stage.snapshot} onPlay={play} onRedo={beginWarmUp} />}

        <p className="game-boundary">A hit means your sound reached a zone you set. It is not a judgement of your speech. Timing is visual only.</p>
      </aside>
    </div>
  );
}

function WarmUpPanel({ state, micOn, requesting, onCancel }: { state: WarmUpState | null; micOn: boolean; requesting: boolean; onCancel: () => void }) {
  const active = state?.kind === 'collecting' ? state.vowel : state?.kind === 'rest' ? state.next : 'ee';
  const index = VOWELS.indexOf(active);
  const collecting = state?.kind === 'collecting' ? state : null;
  const [title, hint] = requesting ? ['Allow microphone access', 'Look for your browser’s microphone permission prompt.']
    : !state || !micOn ? ['Starting the microphone', 'The warm-up begins as soon as audio arrives.']
    : collecting ? [`Hold ${sound(collecting.vowel)}`, `As in “${VOWEL_LABEL[collecting.vowel].example}”. Keep it steady.`]
    : [`Next: ${sound(active)}`, 'Take a breath. Start when the prompt changes.'];
  return <>
    <ol className="game-phases" aria-label="Warm-up sounds">
      {VOWELS.map((vowel, i) => <li key={vowel} className={i < index ? 'is-done' : i === index ? 'is-active' : ''}>
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

function OutcomeStrip({ notes, current }: { notes: NoteState[]; current: number | null }) {
  return (
    <ol className="game-strip" aria-label="Words">
      {notes.map((note, i) => (
        <li key={i} className={`${note.outcome ? `is-${note.outcome}` : ''} ${i === current ? 'is-current' : ''}`} data-testid={`outcome-${i}`} data-outcome={note.outcome ?? ''}>
          <OutcomeGlyph outcome={note.outcome} />
          <span>{FIRST_BEATMAP[i].word}</span>
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

function Results({ snapshot, onPlay, onRedo }: { snapshot: GameSnapshot; onPlay: () => void; onRedo: () => void }) {
  const { hit, miss, unheard } = snapshot.tally;
  const judged = hit + miss;
  return <>
    <div className="status-copy game-copy" role="status" aria-live="polite" aria-atomic="true">
      <h2 data-testid="game-status">{judged ? `${hit} of ${judged} zones hit` : 'Nothing heard clearly enough to judge'}</h2>
      <p data-testid="game-tally">{unheard ? `${unheard} not heard clearly, so not counted.` : 'Every word was heard clearly enough to judge.'}</p>
    </div>
    <ul className="game-results">
      {snapshot.notes.map((note, i) => (
        <li key={i} data-testid={`result-${i}`}><OutcomeGlyph outcome={note.outcome} /><b>{FIRST_BEATMAP[i].word}</b><span>{note.outcome ? OUTCOME_LABEL[note.outcome] : ''}</span></li>
      ))}
    </ul>
    <div className="controls">
      <button type="button" className="button-primary" onClick={onPlay}>Play again</button>
      <button type="button" className="button-secondary" onClick={onRedo}>Redo warm-up</button>
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
  return `${a} and ${b} landed in the same place, so the game can’t tell them apart. Make them more different.`;
}
