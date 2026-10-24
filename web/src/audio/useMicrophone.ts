import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Browser-side capture for the practice loop.
 *
 * What this measures: input amplitude and a voiced-duration estimate, used only for
 * capture quality (silence, clipping, too short). It does NOT measure formants.
 * F1/F2 tracking belongs to the separate measurement service and graph component;
 * they can subscribe to the same MediaStream via `stream`.
 */

export type MicStatus = 'idle' | 'requesting' | 'ready' | 'recording' | 'denied' | 'unsupported';

export interface CaptureSummary {
  durationSec: number;
  usableVoicedSec: number;
  quality: 'usable' | 'unclear';
  qualityReason?: 'silence' | 'clipping' | 'too-short';
  recordingUrl: string | null;
  /** RMS envelope sampled about every 150 ms, for a post-attempt amplitude view. */
  envelope: number[];
}

const BAR_COUNT = 25;
const VOICED_RMS = 0.02; // heuristic threshold, tuned for laptop mics; not a validated value
const CLIP_PEAK = 0.98;
const MIN_USABLE_SEC = 0.6;

export function useMicrophone() {
  const [status, setStatus] = useState<MicStatus>(() =>
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'idle' : 'unsupported',
  );
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [elapsed, setElapsed] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [noiseLevel, setNoiseLevel] = useState<'quiet' | 'noisy' | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const statsRef = useRef({ start: 0, last: 0, voiced: 0, clipped: 0, frames: 0, lastEnv: 0 });
  const envelopeRef = useRef<number[]>([]);
  const recordingRef = useRef(false);
  const levelHistory = useRef<number[]>(Array(BAR_COUNT).fill(0));
  const noiseSamples = useRef<number[]>([]);

  const loop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();

    levelHistory.current = [...levelHistory.current.slice(1), rms];
    setLevels(levelHistory.current);

    if (recordingRef.current) {
      const s = statsRef.current;
      const dt = (now - s.last) / 1000;
      s.last = now;
      s.frames++;
      if (peak >= CLIP_PEAK) s.clipped++;
      if (rms >= VOICED_RMS && peak < CLIP_PEAK) s.voiced += dt;
      if (now - s.lastEnv >= 150) {
        s.lastEnv = now;
        envelopeRef.current.push(rms);
      }
      setElapsed((now - s.start) / 1000);
    } else if (noiseSamples.current.length < 90) {
      noiseSamples.current.push(rms);
      if (noiseSamples.current.length === 90) {
        const avg = noiseSamples.current.reduce((a, b) => a + b, 0) / 90;
        setNoiseLevel(avg < VOICED_RMS * 0.6 ? 'quiet' : 'noisy');
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const start = useCallback(
    async (deviceId?: string) => {
      if (status === 'unsupported') return false;
      stopStream();
      setStatus('requesting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        streamRef.current = stream;
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);
        analyserRef.current = analyser;
        noiseSamples.current = [];
        setNoiseLevel(null);
        setStatus('ready');
        rafRef.current = requestAnimationFrame(loop);
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          setDevices(all.filter((d) => d.kind === 'audioinput'));
        } catch {
          /* ignore */
        }
        return true;
      } catch {
        setStatus('denied');
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loop, status],
  );

  function stopStream() {
    cancelAnimationFrame(rafRef.current);
    recorderRef.current?.state === 'recording' && recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    analyserRef.current = null;
    recordingRef.current = false;
  }

  const beginRecording = useCallback(async () => {
    if (!streamRef.current) {
      const ok = await start();
      if (!ok) return false;
    }
    const stream = streamRef.current!;
    chunksRef.current = [];
    try {
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.start();
      recorderRef.current = rec;
    } catch {
      recorderRef.current = null; // replay unavailable, measurement still works
    }
    const now = performance.now();
    statsRef.current = { start: now, last: now, voiced: 0, clipped: 0, frames: 0, lastEnv: 0 };
    envelopeRef.current = [];
    recordingRef.current = true;
    setElapsed(0);
    setStatus('recording');
    return true;
  }, [start]);

  const endRecording = useCallback(async (): Promise<CaptureSummary> => {
    recordingRef.current = false;
    const s = statsRef.current;
    const durationSec = (performance.now() - s.start) / 1000;
    const recordingUrl = await new Promise<string | null>((resolve) => {
      const rec = recorderRef.current;
      if (!rec || rec.state !== 'recording') return resolve(null);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        resolve(blob.size ? URL.createObjectURL(blob) : null);
      };
      rec.stop();
    });
    setStatus('ready');
    const clippedRatio = s.frames ? s.clipped / s.frames : 0;
    let qualityReason: CaptureSummary['qualityReason'];
    if (s.voiced < 0.15) qualityReason = 'silence';
    else if (clippedRatio > 0.2) qualityReason = 'clipping';
    else if (s.voiced < MIN_USABLE_SEC) qualityReason = 'too-short';
    return {
      durationSec,
      usableVoicedSec: Math.round(s.voiced * 10) / 10,
      quality: qualityReason ? 'unclear' : 'usable',
      qualityReason,
      recordingUrl,
      envelope: [...envelopeRef.current],
    };
  }, []);

  const stop = useCallback(() => {
    stopStream();
    setStatus((st) => (st === 'unsupported' ? st : 'idle'));
    setLevels(Array(BAR_COUNT).fill(0));
  }, []);

  useEffect(() => () => stopStream(), []);

  return {
    status,
    levels,
    elapsed,
    devices,
    noiseLevel,
    stream: streamRef.current,
    start,
    stop,
    beginRecording,
    endRecording,
  };
}

export type Microphone = ReturnType<typeof useMicrophone>;
