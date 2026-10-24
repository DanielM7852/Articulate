class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(Math.round(sampleRate * 0.04));
    this.at = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }
  flush() {
    if (this.at)
      this.port.postMessage({
        type: "pcm",
        samples: this.chunk.slice(0, this.at),
      });
    this.at = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input)
      for (const sample of input) {
        this.chunk[this.at++] = Math.round(
          Math.max(-1, Math.min(1, sample)) * 32767,
        );
        if (this.at === this.chunk.length) this.flush();
      }
    return true;
  }
}
registerProcessor("microphone-pcm", Capture);
