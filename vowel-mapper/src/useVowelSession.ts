import { useCallback, useEffect, useRef, useState } from 'react';
import { createMicrophoneSession, type MicrophoneSession } from './audio/capture';
import { CueSummary, type CueReadout } from './audio/cues';
import { DEFAULT_SETTINGS, type EstimatorSettings } from './audio/estimator';
import type { TrackedFrame, VowelPoint } from './audio/tracker';

export type SessionPhase = 'idle' | 'requesting' | 'running' | 'finished' | 'error';

interface SessionState {
  phase: SessionPhase;
  frame: TrackedFrame | null;
  trace: VowelPoint[];
  frames: number;
  accepted: number;
  sampleRate: number | null;
  durationMs: number;
  error: string | null;
  stale: boolean;
  cues: CueReadout | null;
}

const emptyState = (): SessionState => ({
  phase: 'idle', frame: null, trace: [], frames: 0, accepted: 0,
  sampleRate: null, durationMs: 0, error: null, stale: false, cues: null,
});

function errorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Microphone access was blocked. Allow it in your browser’s site settings, then press Start.';
    if (error.name === 'NotFoundError') return 'No microphone was found. Check your system’s sound input settings, then press Start.';
    if (error.name === 'NotReadableError') return 'The microphone could not start. Check whether another app is using it, then try again.';
  }
  return error instanceof Error ? error.message : 'Could not start audio analysis. Press Start to try again.';
}

export function useVowelSession(settings: EstimatorSettings = DEFAULT_SETTINGS) {
  const [state, setState] = useState<SessionState>(emptyState);
  const session = useRef<MicrophoneSession | null>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const lastFrameAt = useRef(0);

  const release = useCallback(() => {
    generation.current++;
    pending.current?.abort();
    pending.current = null;
    session.current?.stop();
    session.current = null;
  }, []);

  useEffect(() => release, [release]);

  useEffect(() => {
    if (state.phase !== 'running') return;
    const timer = window.setInterval(() => {
      const stale = performance.now() - lastFrameAt.current > 400;
      setState((previous) => previous.stale === stale ? previous : { ...previous, stale });
    }, 100);
    return () => window.clearInterval(timer);
  }, [state.phase]);

  const start = useCallback(async () => {
    release();
    const token = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    const cueSummary = new CueSummary();
    setState({ ...emptyState(), phase: 'requesting' });
    try {
      const current = await createMicrophoneSession({
        settings,
        signal: controller.signal,
        onFrame: (frame) => {
          if (generation.current !== token) return;
          lastFrameAt.current = performance.now();
          const cues = cueSummary.push(frame.estimate, frame.cues, frame.timestampMs);
          setState((previous) => {
            const last = previous.trace.at(-1);
            const append = frame.point && (!last || frame.point.timestampMs - last.timestampMs >= 50);
            return {
              ...previous, frame, cues, stale: false, frames: previous.frames + 1,
              accepted: previous.accepted + (frame.point ? 1 : 0),
              durationMs: frame.timestampMs,
              trace: append ? [...previous.trace.filter((sample) => sample.timestampMs >= frame.timestampMs - 18000).slice(-359), frame.point!] : previous.trace,
            };
          });
        },
        onError: (error) => {
          if (generation.current !== token) return;
          release();
          setState((previous) => ({ ...previous, phase: 'error', error: error.message }));
        },
      });
      if (generation.current !== token) { current.stop(); return; }
      session.current = current;
      lastFrameAt.current = performance.now();
      setState((previous) => ({ ...previous, phase: 'running', sampleRate: current.sampleRate }));
    } catch (error) {
      if (generation.current !== token) return;
      release();
      setState((previous) => ({ ...previous, phase: 'error', error: errorMessage(error) }));
    }
  }, [release, settings]);

  const finish = useCallback(() => {
    release();
    setState((previous) => ({ ...previous, phase: 'finished' }));
  }, [release]);

  return { ...state, start, finish };
}
