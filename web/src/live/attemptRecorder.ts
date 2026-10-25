import type { TrackedFrame } from '@vowel-mapper/audio/tracker';
import type { LipFrame } from '../vision/lipTelemetry';
import type { SoundId } from '../state/types';
import { offlineSink, type MetricSink } from './metricSink';
import { emit, throttledEmit } from '../telemetry/client';

/**
 * Records one attempt's real tracker output: F1/F2 frames from the vowel engine and lip frames
 * from the camera tracker. Nothing is synthesised; if a source never ran, its list stays empty.
 *
 * - Timestamps are performance.now() at receipt minus the attempt start, rounded to 1 ms.
 * - Frames are kept locally up to the caps (first N kept, the rest counted as dropped).
 * - When the sink is connected, frames are also pushed in 250 ms batches with a per-kind
 *   sequence counter starting at 0. Only frames within the caps are pushed.
 */
export const AUDIO_CAP = 1500;
export const VIDEO_CAP = 600;
export const BATCH_MS = 250;

export interface AudioFrame {
  t: number;
  f1: number | null;
  f2: number | null;
  conf: number | null;
  rms: number;
  valid: boolean;
  reason: string | null;
}

export type RecordedLipFrame = LipFrame;

export interface RecordedAttempt {
  attemptId: string;
  audio: AudioFrame[];
  video: RecordedLipFrame[];
  droppedAudio: number;
  droppedVideo: number;
  /** True only if the sink was connected and confirmed every batch. */
  streamed: boolean;
}

export function toAudioFrame(frame: TrackedFrame, t: number): AudioFrame {
  const e = frame.estimate;
  return e.valid
    ? { t, f1: e.f1, f2: e.f2, conf: e.confidence, rms: e.rms, valid: true, reason: null }
    : { t, f1: null, f2: null, conf: null, rms: e.rms, valid: false, reason: String(e.reason) };
}

export class AttemptRecorder {
  private attemptId: string | null = null;
  private start = 0;
  private audio: AudioFrame[] = [];
  private video: RecordedLipFrame[] = [];
  private droppedAudio = 0;
  private droppedVideo = 0;
  private pendingAudio: AudioFrame[] = [];
  private pendingVideo: RecordedLipFrame[] = [];
  private seq = { audio: 0, video: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private sinkReady = false;
  private sinkMissed = false;
  private rmsRing: number[] = [];

  constructor(private readonly sink: MetricSink = offlineSink) {}

  get active() {
    return this.attemptId !== null;
  }

  async begin(attemptId: string, sound: SoundId): Promise<void> {
    this.discard();
    this.attemptId = attemptId;
    this.start = performance.now();
    this.sinkReady = false;
    this.timer = setInterval(() => this.flush(), BATCH_MS);
    if (this.sink.connected) {
      try {
        await this.sink.beginAttempt(attemptId, sound);
        if (this.attemptId === attemptId) this.sinkReady = true;
      } catch {
        this.sinkReady = false;
      }
    }
  }

  pushAudio(frame: TrackedFrame): void {
    if (!this.attemptId) return;
    const t = Math.round(performance.now() - this.start);
    if (this.audio.length >= AUDIO_CAP) {
      this.droppedAudio++;
      return;
    }
    const f = toAudioFrame(frame, t);
    this.rmsRing.push(f.rms);
    if (this.rmsRing.length > 32) this.rmsRing.shift();
    throttledEmit('audio.frame', 200, 'audio', 'db', 'audio.frame', 'audio frame', {
      f1: f.f1,
      f2: f.f2,
      rms: f.rms,
      env: this.envelope(),
    });
    this.audio.push(f);
    this.pendingAudio.push(f);
  }

  pushVideo(frame: LipFrame): void {
    if (!this.attemptId) return;
    const t = Math.round(performance.now() - this.start);
    if (this.video.length >= VIDEO_CAP) {
      this.droppedVideo++;
      return;
    }
    const f: RecordedLipFrame = { ...frame, t };
    this.video.push(f);
    this.pendingVideo.push(f);
  }

  /** 32 values 0..1 from the recent rms history (oldest first, left-padded with 0); no raw PCM is available here. */
  private envelope(): number[] {
    const out = new Array<number>(32).fill(0);
    const off = 32 - this.rmsRing.length;
    for (let i = 0; i < this.rmsRing.length; i++) {
      const v = this.rmsRing[i];
      out[off + i] = Math.round(Math.min(1, Math.max(0, v * 4)) * 1000) / 1000;
    }
    return out;
  }

  private flush(): void {
    const useSink = this.sink.connected && this.sinkReady;
    if (this.sink.connected && !useSink && (this.pendingAudio.length || this.pendingVideo.length)) this.sinkMissed = true;
    const attempt = this.attemptId ? { attemptId: this.attemptId } : {};
    if (this.pendingAudio.length) {
      if (useSink) {
        const seq = this.seq.audio++;
        this.sink.push('audio', seq, this.pendingAudio);
        emit('audio', 'db', 'audio.batch', `audio batch ${seq}`, { frames: this.pendingAudio.length, seq, ...attempt });
      }
      this.pendingAudio = [];
    }
    if (this.pendingVideo.length) {
      if (useSink) {
        const seq = this.seq.video++;
        this.sink.push('video', seq, this.pendingVideo);
        emit('mediapipe', 'db', 'lip.batch', `lip batch ${seq}`, { frames: this.pendingVideo.length, seq, ...attempt });
      }
      this.pendingVideo = [];
    }
  }

  /** Stop recording, flush the last batch, and ask the sink whether everything was confirmed. */
  async end(): Promise<RecordedAttempt> {
    const attemptId = this.attemptId;
    if (!attemptId) throw new Error('No attempt in progress');
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
    this.attemptId = null; // later frames are ignored
    let streamed = false;
    if (this.sink.connected && this.sinkReady && !this.sinkMissed) {
      try {
        streamed = (await this.sink.endAttempt(attemptId)) === true;
      } catch {
        streamed = false;
      }
    }
    return {
      attemptId,
      audio: this.audio,
      video: this.video,
      droppedAudio: this.droppedAudio,
      droppedVideo: this.droppedVideo,
      streamed,
    };
  }

  /** Abandon the current attempt without sending anything. */
  discard(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.attemptId = null;
    this.rmsRing = [];
    this.audio = [];
    this.video = [];
    this.pendingAudio = [];
    this.pendingVideo = [];
    this.droppedAudio = 0;
    this.droppedVideo = 0;
    this.seq = { audio: 0, video: 0 };
    this.sinkMissed = false;
    this.sinkReady = false;
  }
}
