import { useMemo, useRef, useState } from 'react';
import { DEFAULT_SETTINGS } from './audio/estimator';
import { VowelPlot } from './components/VowelPlot';
import { GameMode, type FrameListener } from './game/GameMode';
import { useVowelSession } from './useVowelSession';

const trackingCopy = {
  tracking: ['Tracking vowel', 'Hold your sound, or glide slowly to the next one.'],
  acquiring: ['Finding your vowel', 'Keep a steady vowel for a moment.'],
  quiet: ['Waiting for a vowel', 'Hold “eee,” “ah,” or “oo” near your microphone.'],
  unvoiced: ['Hold a steady vowel', 'Try a sustained vowel. Chatter and breath can interrupt tracking.'],
  clipped: ['Input is too loud', 'Move a little further from the microphone.'],
  uncertain: ['Finding your vowel', 'Hold a comfortable, steady sound. Move away from nearby voices.'],
  invalid: ['Unsupported audio', 'Try desktop Chrome and check your microphone input.'],
} as const;

export default function App() {
  const [ceilingHz, setCeilingHz] = useState(DEFAULT_SETTINGS.ceilingHz);
  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, ceilingHz }), [ceilingHz]);
  const [mode, setMode] = useState<'map' | 'game'>('map');
  const gameFrames = useRef<FrameListener | null>(null);
  const session = useVowelSession(settings, { onFrame: (frame) => gameFrames.current?.(frame) });
  const active = session.phase === 'running' || session.phase === 'requesting';
  const point = session.frame?.point ?? session.trace.at(-1) ?? null;
  const tracking = session.phase === 'running' && !session.stale && session.frame?.status === 'tracking';
  const [status, hint] = session.phase === 'idle' ? ['Ready when you are', 'Press Start to enable your microphone.']
    : session.phase === 'requesting' ? ['Allow microphone access', 'Look for your browser’s microphone permission prompt.']
    : session.phase === 'error' ? ['Microphone paused', session.error ?? 'Press Start to try again.']
    : session.phase === 'finished' ? [session.trace.length ? 'Trace held' : 'No trace captured', 'Your microphone is off. Start again for a fresh trace.']
    : session.stale ? ['Audio paused', 'Audio delivery paused. Return to this tab, or Finish and Start again.']
    : session.frame ? trackingCopy[session.frame.status] : ['Listening', 'Hold a vowel to begin.'];
  const estimate = session.frame?.estimate;
  const displayMeasurement = estimate?.valid && (tracking || session.phase === 'finished');
  const seconds = Math.floor(session.durationMs / 1000);

  return (
    <main className="app-shell">
      <header className="masthead">
        <a className="brand" href="./" aria-label="Articulate home"><span className="brand-mark" aria-hidden="true">a<span>·</span></span>articulate</a>
        <span className="privacy-note"><span className="privacy-dot" />Audio stays on this device</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <div className="mode-switch" role="group" aria-label="Mode">
          <button type="button" aria-pressed={mode === 'map'} onClick={() => setMode('map')}>Map</button>
          <button type="button" aria-pressed={mode === 'game'} onClick={() => setMode('game')}>Game</button>
        </div>
        {mode === 'map' ? <>
          <p className="eyebrow">Vowel explorer</p>
          <h1 id="page-title">See your voice<br className="mobile-break" /> take shape.</h1>
          <p className="intro-copy">Hold a vowel. Watch its position change as you move between sounds.</p>
        </> : <>
          <p className="eyebrow">Zone game</p>
          <h1 id="page-title">Glide between<br className="mobile-break" /> the zones you set.</h1>
          <p className="intro-copy">Set three zones with your own voice, then move between them to say short words. Everything is shown on screen; nothing depends on hearing.</p>
        </>}
      </section>

      {mode === 'game' && <GameMode session={session} frames={gameFrames} point={point} tracking={tracking} />}
      {mode === 'map' && <div className="workspace">
        <section className="map-panel" aria-labelledby="map-title">
          <div className="panel-heading">
            <h2 id="map-title">Your vowel space</h2>
            <span className="trace-key"><i />Recent trace · up to 18s</span>
          </div>
          <VowelPlot trace={session.trace} point={point} faded={!tracking && session.phase !== 'finished'} />
          <div className="map-caption"><span className="legend-dot" />Your latest reliable position <span className="caption-divider">/</span> Fades when tracking is uncertain</div>
        </section>

        <aside className="practice-panel" aria-label="Microphone controls">
          <div className="session-heading"><span className="eyebrow">Live microphone</span><span className="timer" aria-label="Captured duration">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</span></div>
          <div className={`status-mark ${tracking ? 'is-tracking' : ''}`} aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <div className="status-copy" role="status" aria-live="polite" aria-atomic="true">
            <h2 data-testid="tracking-status">{status}</h2>
            <p>{hint}</p>
          </div>
          <div className="mic-level"><label htmlFor="mic-level">Microphone level</label><meter id="mic-level" min="0" max="0.25" value={session.phase === 'running' && !session.stale ? estimate?.rms ?? 0 : 0} /></div>
          <div className="controls">
            <button type="button" className="button-primary" onClick={() => void session.start()} disabled={active}><span aria-hidden="true">▶</span> Start</button>
            <button type="button" className="button-secondary" onClick={session.finish} disabled={!active}><span aria-hidden="true">■</span> Finish</button>
          </div>
          <p className="control-note">Finish turns off the microphone<br />and keeps your trace on screen.</p>
          <div className="try-sounds">
            <h3>Try a slow glide</h3>
            <div className="sound-sequence"><span><strong>eee</strong><small>sheep</small></span><b aria-hidden="true">→</b><span><strong>ah</strong><small>father</small></span><b aria-hidden="true">→</b><span><strong>oo</strong><small>boot</small></span></div>
            <p>Use a comfortable voice. A quieter spot helps the microphone follow you.</p>
          </div>
        </aside>
      </div>}

      <details className="diagnostics">
        <summary>Tracking details <span>For testing & tuning</span></summary>
        <div className="diagnostic-grid">
          <div><span>F1 · raw estimate</span><strong>{displayMeasurement ? Math.round(estimate.f1) : '—'}<small> Hz</small></strong></div>
          <div><span>F2 · raw estimate</span><strong>{displayMeasurement ? Math.round(estimate.f2) : '—'}<small> Hz</small></strong></div>
          <div><span>Accepted frames</span><strong data-testid="accepted-frames">{session.accepted}</strong></div>
          <div><span>Analyzed frames</span><strong>{session.frames}</strong></div>
          <div><span>Input sample rate</span><strong>{session.sampleRate ? session.sampleRate / 1000 : '—'}<small> kHz</small></strong></div>
          <div><span>Low vs mid · nasal cue</span><strong data-testid="cue-low-mid">{session.cues ? session.cues.lowVsMidDb.toFixed(1) : '—'}<small> dB</small></strong></div>
          <div><span>Low vs high · nasal cue</span><strong data-testid="cue-low-high">{session.cues ? session.cues.lowVsHighDb.toFixed(1) : '—'}<small> dB</small></strong></div>
          <div><span>Loudness vs loudest (3 s)</span><strong data-testid="cue-loudness">{session.cues ? session.cues.loudnessDb.toFixed(1) : '—'}<small> dB</small></strong></div>
          <label className="ceiling-control">Analysis ceiling<select aria-label="Analysis ceiling" value={ceilingHz} disabled={active} onChange={(event) => setCeilingHz(Number(event.target.value))}><option value="5000">5,000 Hz</option><option value="5500">5,500 Hz · default</option><option value="6000">6,000 Hz</option></select></label>
        </div>
        <p>Changing the ceiling can help different voices. These measurements are experimental; accepted frames are not a pronunciation score. Unreliable frames are excluded. Nasal cues are experimental half-second medians over voiced frames (bands 80–400, 400–1,200, 1,200–3,000 Hz); they do not affect tracking.</p>
      </details>
      <footer><span>Articulate / 2D mapper prototype</span><p>This maps vowel acoustics, not exact tongue position. No audio is saved or uploaded.</p></footer>
    </main>
  );
}
