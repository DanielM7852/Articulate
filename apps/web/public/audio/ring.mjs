// Source-rate ring, read on the output device clock. Linear interpolation is
// deliberately simple; this is a demo resampler, not reference-quality mastering.
export class PcmRing {
  constructor(rate = 24000, outputRate = 48000, bufferMs = 80) {
    this.rate = rate;
    this.outputRate = outputRate;
    this.threshold = Math.ceil((rate * bufferMs) / 1000);
    this.data = new Float32Array(rate * 2);
    this.clear();
  }
  clear() {
    this.head = 0;
    this.size = 0;
    this.phase = 0;
    this.active = false;
    this.finished = false;
    this.started = false;
    this.consumed = 0;
    this.underruns = 0;
    this.done = false;
  }
  push(pcm) {
    if (this.finished || pcm.length > this.data.length - this.size)
      throw new Error("PCM queue overflow or finalized");
    for (let i = 0; i < pcm.length; i++)
      this.data[(this.head + this.size + i) % this.data.length] = pcm[i];
    this.size += pcm.length;
  }
  finish() {
    this.finished = true;
  }
  render(output) {
    output.fill(0);
    if (
      !this.active &&
      (this.size >= this.threshold || (this.finished && this.size))
    )
      this.active = true;
    if (!this.active) {
      if (this.finished && this.size === 0) this.done = true;
      return;
    }
    const step = this.rate / this.outputRate;
    for (let i = 0; i < output.length; i++) {
      if (!this.size || (this.size < 2 && !this.finished)) {
        this.active = false;
        if (!this.finished) this.underruns++;
        else this.done = true;
        break;
      }
      const a = this.data[this.head],
        b =
          this.data[
            (this.head + Math.min(1, this.size - 1)) % this.data.length
          ];
      output[i] = a + (b - a) * this.phase;
      this.started = true;
      this.phase += step;
      const take = Math.min(Math.floor(this.phase), this.size);
      this.phase -= take;
      this.head = (this.head + take) % this.data.length;
      this.size -= take;
      this.consumed += take;
    }
  }
}
