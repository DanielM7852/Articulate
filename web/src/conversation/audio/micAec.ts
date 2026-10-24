/**
 * Second microphone track with browser echo cancellation, used for barge-in detection and as the
 * speech-to-text source. The raw formant track (echoCancellation false) is opened elsewhere.
 * Measured on Chrome 155 (Windows): two differently-processed tracks of one device are honoured;
 * echoCancellation "all" is accepted. Chrome AEC removes only ~8 dB of Web Audio TTS.
 */
export interface AecMic {
  stream: MediaStream;
  close(): void;
}

export async function openAecMic(deviceId?: string): Promise<AecMic> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unsupported.');
  const base = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  let stream: MediaStream;
  try {
    // "all" also cancels audio from other tabs/Web Audio output; not in all TS lib typings.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...base, echoCancellation: 'all' } as unknown as MediaTrackConstraints,
    });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, echoCancellation: true } });
  }
  return {
    stream,
    close() {
      for (const t of stream.getTracks()) t.stop();
    },
  };
}
