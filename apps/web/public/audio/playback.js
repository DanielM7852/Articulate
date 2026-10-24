import { PcmRing } from "./ring.mjs";
class Playback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.generation = null;
    this.ring = null;
    this.reported = false;
    this.ended = false;
    this.port.onmessage = ({ data: m }) => {
      if (m.type === "clear") {
        this.generation = null;
        this.ring = null;
      }
      if (m.type === "start") {
        this.generation = m.generation;
        this.ring = new PcmRing(m.rate, sampleRate, m.bufferMs);
        this.reported = this.ended = false;
      }
      if (!this.ring || m.generation !== this.generation) return;
      if (m.type === "pcm") {
        try {
          this.ring.push(m.samples);
        } catch {
          this.port.postMessage({
            type: "overflow",
            generation: this.generation,
          });
          this.ring = null;
        }
      }
      if (m.type === "end") this.ring.finish();
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out || !this.ring) return true;
    this.ring.render(out);
    if (this.ring.started && !this.reported) {
      this.reported = true;
      this.port.postMessage({
        type: "started",
        generation: this.generation,
        clock: currentTime,
      });
    }
    if (this.ring.done && !this.ended) {
      this.ended = true;
      this.port.postMessage({
        type: "ended",
        generation: this.generation,
        samples: this.ring.consumed,
        underruns: this.ring.underruns,
      });
    }
    return true;
  }
}
registerProcessor("progressive-pcm", Playback);
