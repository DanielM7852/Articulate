import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleHelp, Loader2, Mic, RotateCcw, Square, Volume2, VolumeX } from 'lucide-react';
import { useMicrophone } from '../audio/useMicrophone';
import { MAX_CLIP_MS, useAttemptAudio } from '../audio/attemptAudio';
import { requestConsonant, type ConsonantHistoryItem, type ConsonantPart, type ConsonantResponse, type ConsonantVerdict } from '../live/consonantCoach';
import '../styles/consonant-coach.css';
import { PhoneStrip } from '../components/PhoneStrip';

/**
 * Standalone "tr / ck" coach for the word "track". No ghost line, no board: the learner picks a part, says it, and the
 * backend's coach answers with a verdict, a large caption and a one-line cue. Everything is visual; speech is optional.
 */
type Phase = 'idle' | 'opening' | 'listening' | 'thinking';
interface Attempt extends ConsonantHistoryItem {
  cue: string;
  part: ConsonantPart;
}

const PRE_ROLL_MS = 200;
const POST_ROLL_MS = 150;
/** A recording left running stops here (the clip cap is MAX_CLIP_MS). */
const MAX_RECORD_MS = 6000;

const HOWTO: Record<ConsonantPart, string> = {
  tr: 'Tongue tip up behind your top teeth. Pop a puff of air, then slide straight into r (lips a little rounded).',
  ck: 'Lift the back of your tongue to the roof of your mouth. Stop the air, then let it pop.',
};

/** Matches the backend default CONSONANT_AZURE_PASS. */
const AZURE_PASS = 60;

const VERDICT_LABEL: Record<ConsonantVerdict, string> = { got_it: 'Got it', try_again: 'Try again', unclear: "Didn't catch that" };

function VerdictIcon({ verdict }: { verdict: ConsonantVerdict }) {
  if (verdict === 'got_it') return <Check aria-hidden size={22} />;
  if (verdict === 'try_again') return <RotateCcw aria-hidden size={22} />;
  return <CircleHelp aria-hidden size={22} />;
}

export default function ConsonantCoach() {
  const mic = useMicrophone();
  const tapRef = useAttemptAudio(mic.stream);
  const [part, setPart] = useState<ConsonantPart>('tr');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<ConsonantResponse | null>(null);
  const [error, setError] = useState(false);
  const [history, setHistory] = useState<Attempt[]>([]);
  const [speak, setSpeak] = useState(true);
  const [pressId, setPressId] = useState(0); // clears the live sounds strip on each Record press
  const debug = typeof window !== 'undefined' && /[?&]debug\b/.test(window.location.hash + window.location.search);

  const phaseRef = useRef<Phase>('idle');
  const pressRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const speakRef = useRef(speak);
  speakRef.current = speak;
  const partRef = useRef(part);
  partRef.current = part;
  const historyRef = useRef(history);
  historyRef.current = history;

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // Ava's voice from the backend (Cartesia, POST /v1/speech); the browser voice only if that fails.
  const clipRef = useRef<HTMLAudioElement | null>(null);
  const say = useCallback(async (text: string) => {
    if (!speakRef.current) return;
    clipRef.current?.pause();
    try {
      const res = await fetch('/v1/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, rate: null }),
        signal: AbortSignal.timeout(8000),
      });
      const blob = res.ok ? await res.blob() : null;
      if (blob?.size) {
        const url = URL.createObjectURL(blob);
        const el = new Audio(url);
        el.onended = el.onerror = () => URL.revokeObjectURL(url);
        clipRef.current = el;
        await el.play();
        return;
      }
    } catch {
      /* fall through to the browser voice */
    }
    try {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch {
      /* captions carry the message */
    }
  }, []);

  const finish = useCallback(async () => {
    setPhaseBoth('thinking');
    // Let the last 150 ms land in the tap's ring before cutting the clip.
    await new Promise((r) => setTimeout(r, POST_ROLL_MS));
    const endAt = Date.now();
    const spanMs = Math.min(MAX_CLIP_MS, endAt - pressRef.current + PRE_ROLL_MS);
    const clip = tapRef.current?.clip(endAt, spanMs) ?? null;
    const p = partRef.current;
    if (!clip) {
      setError(true);
      setPhaseBoth('idle');
      return;
    }
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const prior = historyRef.current
        .filter((h) => h.part === p)
        .slice(-6)
        .map(({ verdict, caption }) => ({ verdict, caption }));
      const r = await requestConsonant({ part: p, audioWav: clip.data, history: prior }, ctl.signal);
      if (ctl.signal.aborted) return;
      setResult(r);
      setHistory((h) => [...h, { part: p, verdict: r.verdict, caption: r.caption, cue: r.cue }].slice(-12));
      void say(r.caption);
    } catch {
      if (ctl.signal.aborted) return;
      setError(true); // network / 5xx: never counted as got_it
    }
    setPhaseBoth('idle');
  }, [say, tapRef]);

  // The learner decides when Ava listens: Record starts the clip and Stop sends it. No auto-stop on silence,
  // only a hard cap so a forgotten recording still ends (the server rejects a silent clip itself).
  const level = mic.levels[mic.levels.length - 1] ?? 0;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase !== 'listening') return;
    const timer = setInterval(() => {
      const ms = Date.now() - pressRef.current;
      setElapsed(ms);
      if (ms >= MAX_RECORD_MS && phaseRef.current === 'listening') void finish();
    }, 100);
    return () => clearInterval(timer);
  }, [phase, finish]);

  const startRef = useRef<() => Promise<void>>(async () => undefined);
  const start = async () => {
    if (phaseRef.current !== 'idle') return;
    setNotice(null);
    setError(false);
    setResult(null);
    setElapsed(0);
    setPhaseBoth('opening');
    // Ava stops talking so her voice is not in the clip.
    clipRef.current?.pause();
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    const ok = mic.stream ? true : await mic.start();
    if (!ok) {
      setNotice('I need the microphone to hear you. Allow it and try again.');
      setPhaseBoth('idle');
      return;
    }
    // The tap attaches a moment after the stream opens.
    for (let i = 0; i < 20 && !tapRef.current; i++) await new Promise((r) => setTimeout(r, 100));
    if (!tapRef.current) {
      setNotice("This browser can't record the clip. Try another browser.");
      setPhaseBoth('idle');
      return;
    }
    // The clip starts once recording is really live, so the mic warm-up is never sent.
    pressRef.current = Date.now();
    setPressId(pressRef.current);
    setPhaseBoth('listening');
  };

  startRef.current = start;

  const stopNow = () => {
    if (phaseRef.current !== 'listening') return;
    void finish();
  };

  // Space bar: Record, then Stop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || (e.target as HTMLElement)?.closest('button, input, textarea')) return;
      e.preventDefault();
      if (phaseRef.current === 'idle') void startRef.current();
      else if (phaseRef.current === 'listening') stopNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(
    () => () => {
      abortRef.current?.abort();
      clipRef.current?.pause();
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const other: ConsonantPart = part === 'tr' ? 'ck' : 'tr';
  let streak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].part === part && history[i].verdict === 'got_it'; i--) streak++;
  const celebrate = streak >= 2 && result?.verdict === 'got_it';
  const gotBoth = history.some((h) => h.part === 'tr' && h.verdict === 'got_it') && history.some((h) => h.part === 'ck' && h.verdict === 'got_it');

  const choose = (p: ConsonantPart) => {
    if (phaseRef.current !== 'idle') return;
    setPart(p);
    setResult(null);
    setError(false);
    setNotice(null);
  };

  const pct = Math.min(100, Math.round(level * 400));
  const busy = phase !== 'idle';

  return (
    <main className="cc">
      <header className="cc-head">
        <h1 className="cc-word" aria-label="track">
          <span className={part === 'tr' ? 'is-on' : ''}>TR</span>
          <span>A</span>
          <span className={part === 'ck' ? 'is-on' : ''}>CK</span>
        </h1>
        <div className="cc-toggle" role="radiogroup" aria-label="Part of the word">
          {(['tr', 'ck'] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={part === p} className={part === p ? 'is-on' : ''} onClick={() => choose(p)} disabled={busy}>
              {p}
            </button>
          ))}
        </div>
        <button type="button" className="cc-speak" aria-pressed={speak} onClick={() => setSpeak((s) => !s)}>
          {speak ? <Volume2 aria-hidden size={18} /> : <VolumeX aria-hidden size={18} />} Speak {speak ? 'on' : 'off'}
        </button>
      </header>

      <section className="cc-card" aria-label={`How to say ${part}`}>
        <h2>How to say "{part}"</h2>
        <p>{HOWTO[part]}</p>
      </section>

      {/* Live sounds from the local phone recognizer (services/phones): stays connected while the mic is open. */}
      <PhoneStrip stream={mic.stream} active={!!mic.stream} resetKey={pressId} />

      <section className="cc-stage" aria-live="polite">
        {phase === 'listening' || phase === 'opening' ? (
          <div className="cc-listen">
            <div className="cc-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <div className="cc-meter-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="cc-status">
              {phase === 'opening'
                ? 'Opening the microphone…'
                : `● Recording ${(elapsed / 1000).toFixed(1)} s — say "track" — focus on the ${part.toUpperCase()}, then press Stop`}
            </p>
            <button type="button" className="btn btn--primary cc-stop" onClick={stopNow} disabled={phase !== 'listening'}>
              <Square aria-hidden size={18} /> Stop and send
            </button>
          </div>
        ) : phase === 'thinking' ? (
          <p className="cc-status cc-thinking">
            <Loader2 aria-hidden className="cc-spin" size={28} /> Ava is listening…
          </p>
        ) : (
          <button type="button" className="btn btn--primary cc-start" onClick={start}>
            <Mic aria-hidden size={26} /> Record
          </button>
        )}

        {notice && phase === 'idle' && <p className="cc-notice">{notice}</p>}
        {error && phase === 'idle' && (
          <p className="cc-notice" role="alert">
            Ava couldn't reply. Try again.
          </p>
        )}

        {result && phase === 'idle' && (
          <div className={`cc-result is-${result.verdict}`}>
            <span className="cc-badge">
              <VerdictIcon verdict={result.verdict} /> {VERDICT_LABEL[result.verdict]}
            </span>
            <p className="cc-caption">{result.caption}</p>
            {result.cue && <p className="cc-cue">{result.cue}</p>}
            {result.azure.available && result.azure.phonemes.length > 0 && (
              <p className="cc-sounds" aria-label="Score for each sound">
                {result.azure.phonemes.map((p, i) => (
                  <span key={i} className={(p.accuracy ?? 0) >= AZURE_PASS ? 'is-ok' : 'is-low'}>
                    {p.phoneme} {p.accuracy === null ? '–' : Math.round(p.accuracy)}
                  </span>
                ))}
              </p>
            )}
          </div>
        )}

        {celebrate && phase === 'idle' && (
          <div className="cc-celebrate">
            <strong>Two in a row. Nice work!</strong>
            <span>{gotBoth ? 'Now try the whole word: track' : `Next, try "${other}".`}</span>
            {!gotBoth && (
              <button type="button" className="btn btn--sm" onClick={() => choose(other)}>
                Switch to {other}
              </button>
            )}
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="cc-history" aria-label="Recent attempts">
          <h2>Recent tries</h2>
          <ul>
            {history
              .slice(-5)
              .reverse()
              .map((h, i) => (
                <li key={history.length - i} className={`is-${h.verdict}`}>
                  <span className="cc-hpart">{h.part}</span>
                  <span className="cc-hverdict">
                    <VerdictIcon verdict={h.verdict} /> {VERDICT_LABEL[h.verdict]}
                  </span>
                  <span className="cc-hcue">{h.cue || h.caption}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {debug && result && (
        <pre className="cc-debug">{JSON.stringify({ model: result.model, fallback: result.fallback, timingsMs: result.timingsMs, acoustics: result.acoustics, azure: result.azure }, null, 2)}</pre>
      )}
    </main>
  );
}
