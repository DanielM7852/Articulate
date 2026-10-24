// Capture only. LPC analysis runs in a Worker, away from the audio render thread.
class VowelCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.round(sampleRate * 0.05);
    this.hopSize = Math.round(sampleRate * 0.025);
    this.ring = new Float32Array(this.frameSize);
    this.written = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) {
      this.ring[this.written % this.frameSize] = value;
      this.written++;
      if (this.written >= this.frameSize && (this.written - this.frameSize) % this.hopSize === 0) {
        const frame = new Float32Array(this.frameSize);
        const start = this.written % this.frameSize;
        for (let i = 0; i < this.frameSize; i++) frame[i] = this.ring[(start + i) % this.frameSize];
        this.port.postMessage({ frame, timestampMs: this.written / sampleRate * 1000 }, [frame.buffer]);
      }
    }
    // Output stays zero: never play the user's microphone back through speakers.
    return true;
  }
}

registerProcessor('vowel-capture', VowelCaptureProcessor);
