import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { VowelPoint } from '../audio/tracker';
import { projectVowel } from '../components/plot';
import { VowelPlot } from '../components/VowelPlot';
import type { FrameListener } from '../game/GameMode';
import type { useVowelSession } from '../useVowelSession';
import { HOLD_MS, MIN_POINTS, PROMPTS, centre, distance, evaluate, holdValue, outline, resultsText, voiceFactor, type Hold, type Location, type TargetVowel } from './check';
import './reference.css';

type Session = ReturnType<typeof useVowelSession>;
type Saved = Partial<Record<Location, Hold[]>>;
const STORAGE_KEY = 'articulate.referenceCheck.v1';
const SPLIT: Record<string, [string, string, string]> = {
  head: ['h', 'ea', 'd'], had: ['h', 'a', 'd'], heard: ['h', 'ear', 'd'], heed: ['h', 'ee', 'd'], father: ['f', 'a', 'ther'],
};

function load(): Saved {
  try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Saved; } catch { return {}; }
}
function save(saved: Saved) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* results still show and copy */ }
}
const run = (location: Location, holds?: Hold[]) => holds?.length ? { location, holds } : undefined;
const closeness = (d: number) => d <= 1 ? 'close' : d <= 1.5 ? 'near' : 'far';

interface Props { session: Session; frames: MutableRefObject<FrameListener | null>; point: VowelPoint | null; tracking: boolean }

export function ReferenceCheck({ session, frames, point, tracking }: Props) {
  const [saved, setSaved] = useState<Saved>(load);
  const [location, setLocation] = useState<Location>('quiet');
  const [recording, setRecording] = useState<{ prompt: number; heard: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const buffer = useRef<VowelPoint[] | null>(null);
  const holds = saved[location] ?? [];
  const factor = voiceFactor(holds);
  const listening = session.phase === 'running' && !session.stale;
  const active = session.phase === 'running' || session.phase === 'requesting';

  useEffect(() => {
    frames.current = (frame) => { if (buffer.current && frame.point) buffer.current.push(frame.point); };
    return () => { frames.current = null; };
  }, [frames]);

  useEffect(() => {
    if (!recording) return;
    const tick = window.setInterval(() => setRecording((r) => r && { ...r, heard: buffer.current?.length ?? 0 }), 80);
    const done = window.setTimeout(() => {
      const value = holdValue(buffer.current ?? []);
      buffer.current = null;
      setRecording(null);
      setCopied(false);
      setSaved((previous) => {
        const list = (previous[location] ?? []).filter((h) => h.prompt !== recording.prompt);
        const hold: Hold = { prompt: recording.prompt, value: value && { f1: value.f1, f2: value.f2 }, count: value?.count ?? 0 };
        const next = { ...previous, [location]: [...list, hold].sort((a, b) => a.prompt - b.prompt) };
        save(next);
        return next;
      });
    }, HOLD_MS);
    return () => { window.clearInterval(tick); window.clearTimeout(done); };
  }, [recording?.prompt, location]);

  const record = (prompt: number) => { buffer.current = []; setRecording({ prompt, heard: 0 }); };
  const clear = () => { const next = { ...saved, [location]: [] }; setSaved(next); save(next); setCopied(false); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(resultsText(run('quiet', saved.quiet), run('hall', saved.hall))); setCopied(true); } catch { setCopied(false); }
  };
  const checks = evaluate(run('quiet', saved.quiet), run('hall', saved.hall));

  return <div className="workspace rc-workspace">
    <section className="map-panel" aria-labelledby="rc-map-title">
      <div className="panel-heading">
        <h2 id="rc-map-title">Reference for your voice</h2>
        <span className="trace-key">{factor === null ? 'Appears after head / had / heard' : 'American English reference · not a correctness score'}</span>
      </div>
      <VowelPlot trace={session.trace} point={point} faded={!tracking} overlay={(scale) => <ReferenceOverlay holds={holds} factor={factor} textScale={scale} />} />
    </section>

    <aside className="practice-panel rc" aria-label="Reference check">
      <div className="rc-places" role="group" aria-label="Where are you?">
        {(['quiet', 'hall'] as const).map((place) => <button key={place} type="button" aria-pressed={location === place} disabled={!!recording}
          onClick={() => { setLocation(place); setCopied(false); }}>{place === 'quiet' ? 'Quiet room' : 'Hall'}{saved[place]?.length === PROMPTS.length ? ' ✓' : ''}</button>)}
      </div>

      <ol className="rc-instructions">
        <li>Pick where you are, then press <b>Start mic</b>.</li>
        <li>For each word: press <b>Record</b>, then hold its vowel steadily until the button finishes (1.5 s).</li>
        <li>“Missed” means it didn’t hear enough. Move closer and record again.</li>
        <li>When every row has a result, press <b>Copy results</b> and paste them in the chat. Then repeat in the other place.</li>
      </ol>

      <div className="controls">
        <button type="button" className="button-primary" onClick={() => void session.start()} disabled={active}>Start mic</button>
        <button type="button" className="button-secondary" onClick={session.finish} disabled={!active || !!recording}>Stop mic</button>
      </div>

      <ul className="rc-rows">
        {PROMPTS.map((p, i) => {
          const hold = holds.find((h) => h.prompt === i);
          const now = recording?.prompt === i;
          const [a, v, b] = SPLIT[p.word];
          const d = p.kind === 'target' && hold?.value && factor !== null ? distance(hold.value, p.vowel as TargetVowel, factor) : null;
          return <li key={i} className={i === 6 ? 'rc-gap' : ''}>
            <span className="rc-word">{a}<em>{v}</em>{b}</span>
            <button type="button" className={`rc-record${now ? ' is-recording' : ''}`} disabled={!listening || (!!recording && !now)} onClick={() => record(i)}
              style={{ ['--heard' as string]: now ? Math.min(1, (recording?.heard ?? 0) / MIN_POINTS) : 0 }}>
              {now ? (recording!.heard ? `Hearing · ${recording!.heard}` : 'Listening…') : hold ? 'Redo' : 'Record'}
            </button>
            <span className={`rc-result${hold && !hold.value ? ' is-miss' : ''}`}>
              {!hold ? '' : !hold.value ? 'Missed' : d !== null ? `${closeness(d)} · ${d.toFixed(2)}` : 'Got it'}
            </span>
          </li>;
        })}
      </ul>

      <ul className="rc-checks">
        {checks.length === 0 && <li className="is-waiting"><b>—</b><div><strong>Results appear here as you record.</strong></div></li>}
        {checks.map((c) => <li key={c.id} className={c.pass === null ? 'is-waiting' : c.pass ? 'is-pass' : 'is-fail'}>
          <b>{c.pass === null ? 'Waiting' : c.pass ? 'Pass' : 'Fail'}</b>
          <div><strong>{c.label}</strong><span>{c.detail}</span></div>
        </li>)}
      </ul>

      <div className="controls">
        <button type="button" className="button-primary" onClick={() => void copy()} disabled={!checks.length}>{copied ? 'Copied' : 'Copy results'}</button>
        <button type="button" className="button-secondary" onClick={clear} disabled={!holds.length || !!recording}>Clear this place</button>
      </div>
      <p className="control-note">This checks the tracker with your voice, not your pronunciation.<br />Nothing is recorded or uploaded; results stay in this browser.</p>
    </aside>
  </div>;
}

/** Soft, edgeless reference regions: graded feedback only, so no boundary line is drawn. */
function ReferenceOverlay({ holds, factor, textScale }: { holds: Hold[]; factor: number | null; textScale: number }) {
  if (factor === null) return null;
  const poly = (points: { f1: number; f2: number }[]) => points.map((p) => { const q = projectVowel(p); return `${q.x},${q.y}`; }).join(' ');
  const oo = projectVowel(centre('uw', factor));
  return <g className="rc-overlay">
    {(['iy', 'ah'] as const).map((v) => {
      const c = projectVowel(centre(v, factor));
      return <g key={v} className={`rc-region rc-${v}`}>
        {[1.5, 1, 0.5].map((r) => <polygon key={r} points={poly(outline(v, factor, r))} />)}
        <text x={c.x} y={c.y + 4 * textScale} textAnchor="middle" style={{ fontSize: 12 * textScale }}>{v === 'iy' ? 'ee' : 'ah'}</text>
      </g>;
    })}
    <text className="rc-unscored" x={oo.x} y={oo.y} textAnchor="middle" style={{ fontSize: 11 * textScale }}>oo · not scored</text>
    {holds.flatMap((h) => {
      const p = PROMPTS[h.prompt];
      if (p.kind !== 'target' || !h.value) return [];
      const q = projectVowel(h.value);
      return [<circle key={h.prompt} cx={q.x} cy={q.y} r={5} className={`rc-hold rc-${p.vowel}`} />];
    })}
  </g>;
}
