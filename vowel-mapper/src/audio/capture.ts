import { DEFAULT_SETTINGS, type EstimatorSettings } from './estimator';
import type { SpectralCues } from './cues';
import type { TrackedFrame } from './tracker';

/** A tracked frame plus experimental diagnostic cues. */
export type AnalyzedFrame = TrackedFrame & { cues?: SpectralCues | null };

export interface MicrophoneSession {
  stop(): void;
  sampleRate: number;
  deviceLabel: string;
}

export interface CaptureOptions {
  /** A supplied stream belongs to the caller and is never stopped here. */
  stream?: MediaStream;
  settings?: EstimatorSettings;
  signal?: AbortSignal;
  onFrame(frame: AnalyzedFrame): void;
  onError(error: Error): void;
}

/** Owns the audio graph and worker; owns the microphone only when it requests it. */
export async function createMicrophoneSession(options: CaptureOptions): Promise<MicrophoneSession> {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    throw new Error('Microphone access needs a supported browser on localhost or HTTPS.');
  }
  const context = new AudioContext({ latencyHint: 'interactive' });
  let stream: MediaStream | undefined = options.stream;
  let source: MediaStreamAudioSourceNode | undefined;
  let capture: AudioWorkletNode | undefined;
  let worker: Worker | undefined;
  let closed = false;
  let busy = false;
  const ended = () => {
    if (!closed) {
      cleanup();
      options.onError(new Error('The microphone disconnected. Check your input device and press Start again.'));
    }
  };
  const cleanup = () => {
    closed = true;
    options.signal?.removeEventListener('abort', cleanup);
    stream?.getAudioTracks().forEach((track) => track.removeEventListener('ended', ended));
    if (!options.stream) stream?.getTracks().forEach((track) => track.stop());
    source?.disconnect();
    capture?.disconnect();
    capture?.port.close();
    worker?.terminate();
    if (context.state !== 'closed') void context.close().catch(() => {});
  };
  const assertActive = () => {
    if (closed || options.signal?.aborted) throw new DOMException('Capture cancelled', 'AbortError');
  };
  options.signal?.addEventListener('abort', cleanup, { once: true });
  try {
    assertActive();
    await context.resume();
    assertActive();
    stream ??= await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Browser speech enhancement can distort the spectral envelope.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    assertActive();
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      throw new Error('No active microphone track was found. Check your input device.');
    }
    await context.audioWorklet.addModule(new URL('./capture.worklet.js', import.meta.url));
    assertActive();
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, 'vowel-capture', { channelCount: 1 });
    const failure = () => {
      if (!closed) {
        cleanup();
        options.onError(new Error('Audio analysis stopped unexpectedly. Press Start to try again.'));
      }
    };
    worker.onerror = failure;
    capture.onprocessorerror = failure;
    worker.onmessage = (event: MessageEvent<AnalyzedFrame>) => {
      busy = false;
      if (!closed) options.onFrame(event.data);
    };
    capture.port.onmessage = (event: MessageEvent<{ frame: Float32Array; timestampMs: number }>) => {
      // Drop frames under load rather than queue delayed cursor positions.
      if (closed || busy) return;
      busy = true;
      worker!.postMessage({ ...event.data, sampleRate: context.sampleRate, settings: options.settings ?? DEFAULT_SETTINGS }, [event.data.frame.buffer]);
    };
    stream.getAudioTracks().forEach((track) => track.addEventListener('ended', ended));
    source.connect(capture);
    capture.connect(context.destination);
    return {
      stop: cleanup,
      sampleRate: context.sampleRate,
      deviceLabel: stream.getAudioTracks()[0]?.label || 'Default microphone',
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
