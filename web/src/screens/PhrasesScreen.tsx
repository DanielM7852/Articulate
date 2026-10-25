import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Mic, RotateCcw, Square } from 'lucide-react';
import { useMicrophone } from '../audio/useMicrophone';
import { MAX_CLIP_MS, useAttemptAudio } from '../audio/attemptAudio';
import {
  PhrasesHttpError, assessPhrase, getAbout, makePhrases,
  type Phrase, type PhraseAssessment, type PhraseOverall, type PhraseWordResult,
} from '../live/phrases';
import { learnerProfileId } from '../state/learnerId';
import '../styles/recap.css';
import '../styles/phrases.css';

const ABOUT_MAX = 500;
// Must stay below MAX_CLIP_MS (7000) minus pre-roll, post-roll and the 100 ms tick so the clip covers the whole take.
const MAX_RECORD_MS = 6500;
const PRE_ROLL_MS = 200;
const POST_ROLL_MS = 150;

const OVERALL_TEXT: Record<PhraseOverall, string> = {
  clear: 'Nice and clear!',
  almost: 'Almost — try the marked words again.',
  try_again: "Let's try that one again, slowly.",
  unclear: "We couldn't make that out. Try again a little closer to the mic.",
};
const NOT_SCORED_TEXT = "Practice only — scoring isn't set up yet.";
const UNCLEAR_TEXT = "We couldn't make that out. Try again a little closer to the mic.";
const WORD_LABEL: Record<PhraseWordResult, string> = { clear: 'clear', try_again: 'try again', missed: 'missed' };

/** One mic for the whole screen; only one card records at a time. */
type Mic = { busyId: string | null; start: (id: string) => void; stop: () => void };

interface CardProps {
  phrase: Phrase;
  recorder: ReturnType<typeof useRecorder>;
}

type CardState =
  | { kind: 'idle' }
  | { kind: 'listening' }
  | { kind: 'thinking' }
  | { kind: 'done'; result: PhraseAssessment }
  | { kind: 'error'; message: string };

function useRecorder() {
  const mic = useMicrophone();
  const tapRef = useAttemptAudio(mic.stream);
  const [active, setActive] = useState<string | null>(null);
  const startedAt = useRef(0);
  const activeRef = useRef<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  /** Resolves with a base64 WAV clip, or a message to show. */
  const begin = useCallback(async (id: string): Promise<string | null> => {
    if (activeRef.current) return 'Another phrase is recording. Stop it first.';
    activeRef.current = id;
    setActive(id);
    const ok = mic.stream ? true : await mic.start();
    if (!ok) {
      activeRef.current = null;
      setActive(null);
      return 'We need the microphone to hear you. Allow it in your browser, then try again.';
    }
    for (let i = 0; i < 20 && !tapRef.current; i++) await new Promise((r) => setTimeout(r, 100));
    if (!tapRef.current) {
      activeRef.current = null;
      setActive(null);
      return "This browser can't record. Try another browser.";
    }
    startedAt.current = Date.now();
    setElapsed(0);
    return null;
  }, [mic, tapRef]);

  /** Drop the active state (card unmounted or list replaced) so the shared recorder never stays stuck. */
  const cancel = useCallback((id?: string) => {
    if (id !== undefined && activeRef.current !== id) return;
    activeRef.current = null;
    setActive(null);
  }, []);

  const end = useCallback(async (): Promise<string | null> => {
    await new Promise((r) => setTimeout(r, POST_ROLL_MS));
    const endAt = Date.now();
    const span = Math.min(MAX_CLIP_MS, endAt - startedAt.current + PRE_ROLL_MS);
    const clip = tapRef.current?.clip(endAt, span) ?? null;
    activeRef.current = null;
    setActive(null);
    return clip?.data ?? null;
  }, [tapRef]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 100);
    return () => clearInterval(t);
  }, [active]);

  return { active, elapsed, begin, end, cancel, release: mic.stop };
}

function PhraseCard({ phrase, recorder }: CardProps) {
  const [state, setState] = useState<CardState>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const phraseId = phrase.id;

  useEffect(() => () => {
    abortRef.current?.abort();
    if (stateRef.current.kind === 'listening') recorderRef.current.cancel(phraseId);
  }, [phraseId]);

  const stop = useCallback(async () => {
    if (stateRef.current.kind !== 'listening') return;
    setState({ kind: 'thinking' });
    const wav = await recorder.end();
    if (!wav) {
      setState({ kind: 'error', message: "We didn't catch a recording. Tap the mic and try again." });
      return;
    }
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const result = await assessPhrase({ profileId: learnerProfileId(), text: phrase.text, audioWav: wav }, ctl.signal);
      if (!ctl.signal.aborted) setState({ kind: 'done', result });
    } catch (err) {
      if (ctl.signal.aborted) return;
      setState({
        kind: 'error',
        message: err instanceof PhrasesHttpError && err.status === 429
          ? "You've tried a lot of phrases this hour. Try again later."
          : "Couldn't check that one. Tap the mic to try again.",
      });
    }
  }, [recorder, phrase.text]);

  // Hard cap so a forgotten recording still ends.
  useEffect(() => {
    if (state.kind === 'listening' && recorder.elapsed >= MAX_RECORD_MS) void stop();
  }, [state.kind, recorder.elapsed, stop]);

  async function start() {
    setState({ kind: 'listening' });
    const problem = await recorder.begin(phrase.id);
    if (problem) setState({ kind: 'error', message: problem });
  }

  const done = state.kind === 'done' ? state.result : null;
  const overallKind = !done ? '' : done.scoringAvailable === false ? 'practice' : !done.scored ? 'unclear' : done.overall;
  const overallText = !done ? '' : done.scoringAvailable === false ? NOT_SCORED_TEXT
    : !done.scored ? UNCLEAR_TEXT : OVERALL_TEXT[done.overall] ?? '';
  const listening = state.kind === 'listening';

  return (
    <li className="recap-card phrase" data-state={state.kind}>
      <p className="phrase__text" lang="en">
        {done && done.scored && done.words.length > 0
          ? done.words.map((w, i) => (
            <span key={i} className="phrase__word" data-result={w.result}>
              {w.word}
              <span className="phrase__label">{WORD_LABEL[w.result] ?? w.result}</span>
            </span>
          ))
          : phrase.text}
      </p>
      {phrase.targets.length > 0 && <p className="recap-targets">Works on: {phrase.targets.join(', ')}</p>}
      <p className="phrase__tip">{phrase.tip}</p>

      {done && (
        <p className="phrase__overall" role="status" data-overall={overallKind}>
          {overallText}
        </p>
      )}
      {state.kind === 'error' && <p className="recap-error" role="alert">{state.message}</p>}
      {state.kind === 'thinking' && (
        <p className="phrase__status" role="status"><Loader2 size={18} className="phrase__spin" aria-hidden="true" /> Checking…</p>
      )}
      {listening && <p className="phrase__rec" role="status">Recording… tap to stop</p>}

      <div className="phrase__actions">
        {(state.kind === 'idle' || state.kind === 'error' || listening) && (
          <button
            type="button"
            className={`btn phrase__mic${listening ? ' phrase__mic--live' : ' btn--primary'}`}
            onClick={listening ? () => void stop() : () => void start()}
            disabled={!listening && recorder.active !== null}
            aria-label={listening ? 'Stop recording' : `Record: ${phrase.text}`}
          >
            {listening ? <Square size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
            {listening ? 'Stop' : 'Say it'}
          </button>
        )}
        {done && (
          <button type="button" className="btn" onClick={() => setState({ kind: 'idle' })}>
            <RotateCcw size={16} aria-hidden="true" /> Try again
          </button>
        )}
      </div>
    </li>
  );
}

export default function PhrasesScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const recapId = params.get('recap');
  const recorder = useRecorder();
  const [about, setAbout] = useState('');
  const [phrases, setPhrases] = useState<Phrase[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const touched = useRef(false);
  // True once the saved text loaded or the learner typed; otherwise we must not overwrite it.
  const [aboutKnown, setAboutKnown] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    getAbout(learnerProfileId(), ctl.signal).then(
      (saved) => {
        if (touched.current) return;
        if (saved) setAbout(saved);
        setAboutKnown(true);
      },
      () => undefined, // no saved text: the box just starts empty
    );
    return () => ctl.abort();
  }, []);

  useEffect(() => { headingRef.current?.focus(); recorder.cancel(); }, [phrases]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => recorder.release(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = about.trim();
    setBusy(true);
    setError(null);
    try {
      const profileId = learnerProfileId();
      // The server saves the text; null means "use what is stored" when it never loaded.
      setPhrases(await makePhrases({ profileId, recapId, aboutMe: aboutKnown ? text : null }));
    } catch (err) {
      setError(err instanceof PhrasesHttpError && err.status === 429
        ? "You've made a lot of phrases this hour. Try again later."
        : "We couldn't make your phrases just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const back = recapId ? (
    <button type="button" className="btn" onClick={() => navigate(`/recap/${encodeURIComponent(recapId)}`)}>
      <ArrowLeft size={16} aria-hidden="true" /> Back to recap
    </button>
  ) : (
    <button type="button" className="btn" onClick={() => navigate('/')}><ArrowLeft size={16} aria-hidden="true" /> Home</button>
  );

  if (!phrases) {
    return (
      <main className="recap phrases">
        <header className="recap-head">
          <p className="recap-eyebrow">Your own words</p>
          <h1 className="recap-title" tabIndex={-1} ref={headingRef}>Tell us about you</h1>
          <p className="recap-lede">We'll write five short phrases you might really say.</p>
        </header>
        <form className="recap-email phrases__form" onSubmit={submit}>
          <label htmlFor="about-me" className="recap-email__label">About you</label>
          <textarea
            id="about-me" className="phrases__about" rows={5} maxLength={ABOUT_MAX} value={about}
            onChange={(e) => { touched.current = true; setAboutKnown(true); setAbout(e.target.value); }}
            aria-describedby="about-help about-privacy"
          />
          <p id="about-help" className="phrases__help">
            Try your job, people you talk to, or things you order or say often.
            <span className="phrases__count"> {about.length} of {ABOUT_MAX} letters</span>
          </p>
          <p id="about-privacy" className="phrases__help">
            Saved to your account so your phrases stay personal. You can change it any time.
          </p>
          <div className="btn-row">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Making your phrases…' : 'Make my phrases'}
            </button>
            {back}
          </div>
          {busy && <p className="phrases__help" role="status">This can take a few seconds.</p>}
          {error && <p className="recap-error" role="alert">{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="recap phrases">
      <header className="recap-head">
        <p className="recap-eyebrow">Your own words</p>
        <h1 className="recap-title" tabIndex={-1} ref={headingRef}>Say these out loud</h1>
        <p className="recap-lede">Tap Say it, speak the phrase, then tap Stop.</p>
      </header>
      <ul className="recap-focus">
        {phrases.map((p) => <PhraseCard key={p.id} phrase={p} recorder={recorder} />)}
      </ul>
      <div className="recap-foot btn-row">
        <button type="button" className="btn btn--primary" onClick={() => setPhrases(null)}>New phrases</button>
        {back}
      </div>
    </main>
  );
}
