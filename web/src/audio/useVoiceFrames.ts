import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createMicrophoneSession, type AnalyzedFrame, type MicrophoneSession } from '@vowel-mapper/audio/capture';
import { VOICING_THRESHOLD } from '@vowel-mapper/audio/estimator';
import type { VoiceFrame } from '../game/types';

/**
 * Every analysis frame of the vowel-mapper engine, voiced or not, on a stream the caller owns.
 *
 * Frames arrive every 25 ms (50 ms windows). `timestampMs` is the engine's sample clock; sessions on the
 * same stream share one engine, so it is the same clock as useVowelTracking's `VowelPoint.timestampMs`.
 * F1/F2/F3 are the frame's own (unsmoothed) estimates and are present only while the tracker accepts the
 * vowel; F3 is also withheld when its resonance is not sharp enough to trust. Acoustic orientation only.
 */
export interface VoiceFrames {
  /** Latest frame, null before the first. Read it when needed; it changes without re-rendering. */
  latest: VoiceFrame | null;
  /** Register a per-frame listener (for the board's rAF loop); returns an unsubscribe. */
  subscribe(listener: (frame: VoiceFrame) => void): () => void;
  status: 'off' | 'starting' | 'tracking' | 'paused' | 'error';
}

/** What a burst frame also carries, beyond the contract. */
export interface VoiceFrameDetail extends VoiceFrame {
  /** Burst onset time on the frame clock (within the flagged frame's last 25 ms). */
  burstOnsetMs?: number;
  /** RMS frequency of the onset (a spectral-centroid proxy), Hz; an orientation cue only, not a place-of-articulation verdict. */
  burstHz?: number;
}

type Status = VoiceFrames['status'];

/** No frame for this long while tracking means the engine stalled (tab hidden, device paused). */
const STALE_MS = 400;

export function toVoiceFrame({ estimate, status, timestampMs, burst }: AnalyzedFrame): VoiceFrameDetail {
  const frame: VoiceFrameDetail = {
    timestampMs,
    rms: estimate.rms,
    periodicity: estimate.periodicity,
    voiced: estimate.periodicity >= VOICING_THRESHOLD,
    burst: Boolean(burst),
    clipped: !estimate.valid && estimate.reason === 'clipped',
  };
  if (estimate.valid && status === 'tracking') {
    frame.f1 = estimate.f1;
    frame.f2 = estimate.f2;
    if (estimate.f3 !== undefined) frame.f3 = estimate.f3;
  }
  if (burst) {
    frame.burstOnsetMs = burst.timestampMs;
    frame.burstHz = burst.frequencyHz;
  }
  return frame;
}

export function useVoiceFrames(stream: MediaStream | null): VoiceFrames {
  const [status, setStatus] = useState<Status>('off');
  const statusRef = useRef<Status>('off');
  const latest = useRef<VoiceFrameDetail | null>(null);
  const listeners = useRef(new Set<(frame: VoiceFrame) => void>());
  const lastFrameAt = useRef(0);

  // Only status changes re-render; frames go to the ref and the listeners.
  const update = useCallback((next: Status) => {
    if (statusRef.current === next) return;
    statusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    latest.current = null;
    if (!stream) {
      update('off');
      return;
    }
    let session: MicrophoneSession | null = null;
    let cancelled = false;
    const controller = new AbortController();
    update('starting');
    createMicrophoneSession({
      stream,
      signal: controller.signal,
      onFrame: (analyzed) => {
        if (cancelled) return;
        lastFrameAt.current = performance.now();
        const frame = toVoiceFrame(analyzed);
        latest.current = frame;
        if (statusRef.current !== 'error') update('tracking');
        listeners.current.forEach((listener) => {
          try {
            listener(frame);
          } catch {
            /* a listener's error never breaks the stream of frames */
          }
        });
      },
      onError: () => {
        if (!cancelled) update('error');
      },
    })
      .then((s) => {
        if (cancelled) s.stop();
        else session = s;
      })
      .catch((err: unknown) => {
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) update('error');
      });
    const stale = setInterval(() => {
      if (statusRef.current === 'tracking' && performance.now() - lastFrameAt.current > STALE_MS) update('paused');
    }, 150);
    return () => {
      cancelled = true;
      controller.abort();
      session?.stop();
      clearInterval(stale);
    };
  }, [stream, update]);

  const subscribe = useCallback((listener: (frame: VoiceFrame) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return useMemo<VoiceFrames>(
    () => ({
      get latest() {
        return latest.current;
      },
      subscribe,
      status,
    }),
    [subscribe, status],
  );
}
