/** Developer check only: record a few seconds with the tracker's microphone settings and download it as a WAV. Nothing is uploaded. */
const WORKLET = `registerProcessor('clip-capture', class extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
});`;

export async function recordClip(seconds: number): Promise<{ samples: Float32Array; rate: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Same as src/audio/capture.ts: browser speech enhancement can distort the spectral envelope.
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const context = new AudioContext({ sampleRate: 48000 });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(context, 'clip-capture');
    const wanted = Math.round(seconds * context.sampleRate);
    const samples = new Float32Array(wanted);
    let offset = 0;
    // Count audio actually delivered, not wall time: the microphone takes a moment to start.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The microphone stopped delivering audio.')), (seconds + 5) * 1000);
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const chunk = event.data.subarray(0, wanted - offset);
        samples.set(chunk, offset);
        offset += chunk.length;
        if (offset >= wanted) { clearTimeout(timeout); resolve(); }
      };
      context.createMediaStreamSource(stream).connect(node);
      void context.resume();
    });
    return { samples, rate: context.sampleRate };
  } finally {
    URL.revokeObjectURL(url);
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  }
}

export function wavBlob(samples: Float32Array, rate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true));
  return new Blob([view], { type: 'audio/wav' });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
