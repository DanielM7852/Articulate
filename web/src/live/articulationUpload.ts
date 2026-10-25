/**
 * Background upload of the learner's attempt audio (16 kHz mono PCM16 WAV) for articulation analysis.
 * Fire-and-forget: never throws, never rejects, never affects the coaching session.
 */

import { getLiveIdentity } from './transport';

const SAMPLE_RATE = 16000;
const MIN_SAMPLES = SAMPLE_RATE / 2; // 0.5 s
const MAX_SAMPLES = Math.round(SAMPLE_RATE * 8.5);
const TIMEOUT_MS = 30_000;

/** Wrap PCM16 mono samples in a standard 44-byte RIFF/WAVE header. */
export function encodePcm16Wav(samples: Int16Array, sampleRate = SAMPLE_RATE): Blob {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44, samples.length).set(samples); // little-endian hosts only (all browsers we target)
  return new Blob([buf], { type: 'audio/wav' });
}

export interface ArticulationUploadArgs {
  attemptId: string;
  profileId: string;
  sound: string;
  pcm: Int16Array;
  /** performance.now() clock time of the first sample. */
  captureStartMonotonicMs: number;
  /** performance.timeOrigin. */
  timeOriginUnixMs: number;
  /** Teacher asked for a Sonic reference of this word. */
  reference?: boolean;
  /** Word the Sonic reference speaks. Letters only, matching the backend limit. */
  word?: string;
  signal?: AbortSignal;
}

export async function uploadArticulation(args: ArticulationUploadArgs): Promise<boolean> {
  try {
    let pcm = args.pcm;
    if (pcm.length < MIN_SAMPLES) return false;
    let startMs = args.captureStartMonotonicMs;
    if (pcm.length > MAX_SAMPLES) {
      const drop = pcm.length - MAX_SAMPLES;
      pcm = pcm.subarray(drop);
      startMs += (drop / SAMPLE_RATE) * 1000; // keep the start time aligned with the first kept sample
    }
    let profileId = args.profileId;
    try {
      const principal = await getLiveIdentity();
      if (principal.shared && principal.profileId) profileId = principal.profileId;
    } catch { /* identity unavailable: keep the caller's profile */ }
    const q = new URLSearchParams({
      attemptId: args.attemptId,
      profileId,
      sound: args.sound,
      captureStartMonotonicMs: String(startMs),
      timeOriginUnixMs: String(args.timeOriginUnixMs),
    });
    if (args.reference && args.word && /^[a-z]{1,24}$/.test(args.word)) {
      q.set('reference', 'true');
      q.set('word', args.word);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    if (args.signal) {
      if (args.signal.aborted) ctl.abort();
      else args.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetch(`/v1/live/articulation?${q.toString()}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'audio/wav' },
        body: encodePcm16Wav(pcm),
        signal: ctl.signal,
      });
      if (!res.ok) {
        console.debug('articulation upload rejected', res.status);
        return false;
      }
      // 202 {accepted: true} means analysis was queued; 200 {accepted: false} means it was not.
      if (res.status !== 202) return false;
      const body = (await res.json()) as { accepted?: unknown };
      return body.accepted === true;
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    console.debug('articulation upload failed', e);
    return false;
  }
}
