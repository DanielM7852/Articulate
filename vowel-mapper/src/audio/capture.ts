import { DEFAULT_SETTINGS, type EstimatorSettings } from './estimator';
import type { BurstOnset } from './bursts';
import type { SpectralCues } from './cues';
import type { TrackedFrame } from './tracker';

/**
 * A tracked frame plus experimental diagnostic cues and, on the one frame whose new samples hold a stop
 * release, the burst onset. Frames arrive every 25 ms (50 ms windows), voiced or not; `timestampMs` is the
 * end of the frame on the capture's sample clock, counted from when the engine started receiving audio.
 */
export type AnalyzedFrame = TrackedFrame & { cues?: SpectralCues | null; burst?: BurstOnset | null };

export interface MicrophoneSession {
  stop(): void;
  sampleRate: number;
  deviceLabel: string;
}

export interface CaptureOptions {
  /**
   * A supplied stream belongs to the caller and is never stopped here. Sessions on the same supplied stream
   * with the same settings share one audio graph and worker, so they receive identical frames and timestamps.
   */
  stream?: MediaStream;
  settings?: EstimatorSettings;
  signal?: AbortSignal;
  onFrame(frame: AnalyzedFrame): void;
  onError(error: Error): void;
}

interface SharedEngine {
  settings: EstimatorSettings;
  listeners: Set<Pick<CaptureOptions, 'onFrame' | 'onError'>>;
  controller: AbortController;
  ready: Promise<MicrophoneSession>;
}

const sharedEngines = new Map<MediaStream, SharedEngine>();

const cancelled = () => new DOMException('Capture cancelled', 'AbortError');

/** Owns the audio graph and worker; owns the microphone only when it requests it. */
export async function createMicrophoneSession(options: CaptureOptions): Promise<MicrophoneSession> {
  const { stream, signal } = options;
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const engine = stream && sharedEngines.get(stream);
  if (!stream || (engine && (engine.settings.ceilingHz !== settings.ceilingHz || engine.settings.minimumRms !== settings.minimumRms))) {
    return openEngine(options);
  }
  if (signal?.aborted) throw cancelled();
  const shared = engine ?? shareEngine(stream, settings);
  const listener = { onFrame: options.onFrame, onError: options.onError };
  shared.listeners.add(listener);
  // The last session to leave stops the engine; aborting its signal runs the engine's cleanup at any stage.
  const leave = () => {
    signal?.removeEventListener('abort', leave);
    if (!shared.listeners.delete(listener) || shared.listeners.size) return;
    if (sharedEngines.get(stream) === shared) sharedEngines.delete(stream);
    shared.controller.abort();
  };
  signal?.addEventListener('abort', leave, { once: true });
  try {
    const session = await new Promise<MicrophoneSession>((resolve, reject) => {
      const abort = () => reject(cancelled());
      signal?.addEventListener('abort', abort, { once: true });
      shared.ready.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
    return { stop: leave, sampleRate: session.sampleRate, deviceLabel: session.deviceLabel };
  } catch (error) {
    leave();
    throw error;
  }
}

function shareEngine(stream: MediaStream, settings: EstimatorSettings): SharedEngine {
  const listeners: SharedEngine['listeners'] = new Set();
  const controller = new AbortController();
  const forget = () => {
    if (sharedEngines.get(stream)?.listeners === listeners) sharedEngines.delete(stream);
  };
  const ready = openEngine({
    stream,
    settings,
    signal: controller.signal,
    onFrame: (frame) => listeners.forEach((listener) => {
      // One subscriber's failure must not starve the others; rethrow outside the loop so it still surfaces.
      try { listener.onFrame(frame); } catch (error) { setTimeout(() => { throw error; }); }
    }),
    onError: (error) => {
      forget();
      const notified = [...listeners];
      listeners.clear();
      notified.forEach((listener) => listener.onError(error));
    },
  });
  ready.catch(forget);
  const shared = { settings, listeners, controller, ready };
  sharedEngines.set(stream, shared);
  return shared;
}

async function openEngine(options: CaptureOptions): Promise<MicrophoneSession> {
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
