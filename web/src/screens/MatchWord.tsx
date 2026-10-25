import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Mic, Square, Volume2 } from 'lucide-react';
import { MouthReference, type MouthReferenceHandle } from '../components/MouthReference';
import { TeacherCaptions } from '../components/TeacherCaptions';
import { OnboardingFrame, StepHeading } from '../components/Onboarding';
import { encodePcm16Wav } from '../live/articulationUpload';
import { useCoachSequence } from '../live/useCoachSequence';
import { learnerProfileId } from '../state/learnerId';
import { setCaptureBusy } from '../classroom/captureGate';
import { exerciseName } from '../classroom/labels';
import { loadSession } from '../classroom/session';
import { useAppState } from '../state/AppState';

/**
 * Later step: Cartesia says "head", the mouth speaks it, then the learner matches it.
 * The advice is the measured difference against that same reference word.
 */
const WORD = 'head';
const MAX_MS = 6000;

type Measure = { voicedMs?: number | null; f0Hz?: number | null; f1Hz?: number | null; f2Hz?: number | null };
type MatchResult = {
  advice: string;
  source: string;
  cue: string | null;
  learner: Measure | null;
  reference: Measure | null;
};

export default function MatchWord() {
  const navigate = useNavigate();
  const { lessonTarget } = useAppState();
  const mouthRef = useRef<MouthReferenceHandle | null>(null);
  const seq = useCoachSequence(
    () => mouthRef.current,
    () => undefined,
  );
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCaptureBusy(recording || busy);
    return () => setCaptureBusy(false);
  }, [recording, busy]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const capture = useRef<{ ctx: AudioContext; chunks: Float32Array[]; rate: number } | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const stopTimer = useRef(0);

  useEffect(() => () => {
    window.clearTimeout(stopTimer.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    capture.current?.ctx.close().catch(() => undefined);
  }, []);

  function hear() {
    setError(null);
    void seq.speakLine({ text: WORD, cueId: null, showSideView: false }, { narration: true });
  }

  async function startRecording() {
    seq.cancel();
    setResult(null);
    setError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      stream.current = media;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(media);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const chunks: Float32Array[] = [];
      proc.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(gain);
      gain.connect(ctx.destination);
      capture.current = { ctx, chunks, rate: ctx.sampleRate };
      setRecording(true);
      stopTimer.current = window.setTimeout(() => void stopRecording(), MAX_MS);
    } catch {
      setError('Microphone blocked. Allow it in site settings, then try again.');
    }
  }

  async function stopRecording() {
    window.clearTimeout(stopTimer.current);
    const taken = capture.current;
    capture.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setRecording(false);
    if (!taken) return;
    taken.ctx.close().catch(() => undefined);
    const pcm = floatsToPcm(taken.chunks);
    if (pcm.length < taken.rate * 0.3) {
      setError('That was too short. Say the whole word head.');
      return;
    }
    setBusy(true);
    try {
      const classroom = loadSession();
      const profileId = classroom?.role === 'learner' ? classroom.profileId : learnerProfileId();
      const res = await fetch(`/v1/word-match?profileId=${encodeURIComponent(profileId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: encodePcm16Wav(pcm, taken.rate),
      });
      if (!res.ok) {
        setError('The comparison did not finish. Try the word once more.');
        return;
      }
      const body = (await res.json()) as MatchResult;
      setResult(body);
      void seq.speakLine({ text: body.advice, cueId: null, showSideView: false }, { narration: true });
    } catch {
      setError('The comparison did not finish. Try the word once more.');
    } finally {
      setBusy(false);
    }
  }

  const caption = seq.caption ?? result?.advice ?? 'Listen to head, then say it the same way.';

  return (
    <OnboardingFrame
      step={1}
      total={1}
      bar="none"
      stageKey="match"
      className="lp ob-content--full"
      footer={
        <>
          <button type="button" className="ob-text-btn" onClick={() => navigate('/own')} disabled={recording || busy}>
            <ChevronLeft size={18} aria-hidden="true" />
            Back
          </button>
          <button type="button" className="ob-text-btn" onClick={hear} disabled={recording || busy || seq.running}>
            <Volume2 size={18} aria-hidden="true" />
            Hear head
          </button>
          <button
            type="button"
            className={`ob-cta ${recording ? 'ob-cta--stop' : ''}`}
            onClick={recording ? () => void stopRecording() : () => void startRecording()}
            disabled={busy}
          >
            {recording ? <Square size={16} fill="currentColor" aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
            {recording ? 'Stop' : busy ? 'Comparing' : 'Say head'}
          </button>
        </>
      }
    >
      <div className="lp-head">
        <StepHeading title={<>Advanced · <span className="navy">{lessonTarget ?? 'head'}</span></>} />
        {lessonTarget && lessonTarget !== 'head' && (
          <p className="own-sub">Your teacher assigned {exerciseName(lessonTarget)}. This page still records the word head.</p>
        )}
      </div>
      <div className="lp-stage is-solo">
        <section className="lp-pane" aria-label="Mouth reference">
          <MouthReference ref={mouthRef} cue={null} paused={false} />
          {seq.speech && seq.caption ? (
            <TeacherCaptions className="cap-text" speech={seq.speech} text={seq.caption} />
          ) : (
            <p className="own-sub lp-overlay lp-overlay--tl">{caption}</p>
          )}
          {result && (
            <p className="own-sub lp-overlay lp-overlay--br">
              {result.cue ? `Measured cue: ${result.cue}. ` : 'No mouth or tongue change. '}
              {result.source === 'agent' ? 'Claude phrased it. ' : 'The measured line is used. '}
              {result.learner?.voicedMs != null ? `Your sound ${result.learner.voicedMs} ms` : ''}
              {result.reference?.voicedMs != null ? ` · reference ${result.reference.voicedMs} ms` : ''}
            </p>
          )}
          {error && (
            <p className="own-sub lp-overlay lp-overlay--br" role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
    </OnboardingFrame>
  );
}

function floatsToPcm(chunks: Float32Array[]): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.max(-1, Math.min(1, chunk[i]));
      pcm[offset++] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
    }
  }
  return pcm;
}
