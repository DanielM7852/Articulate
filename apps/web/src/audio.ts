export const HEADER = 44;
export function frame(
  kind: number,
  id: string,
  seq: number,
  offset: number,
  rate: number,
  pcm: Int16Array,
) {
  const buffer = new ArrayBuffer(HEADER + pcm.length * 2),
    v = new DataView(buffer);
  new Uint8Array(buffer).set([86, 83, 67, 49, kind, 1, 1, 0]);
  new Uint8Array(buffer, 8, 16).set(
    id
      .replaceAll("-", "")
      .match(/../g)!
      .map((h) => parseInt(h, 16)),
  );
  v.setUint32(24, seq, true);
  v.setBigUint64(28, BigInt(offset), true);
  v.setUint32(36, rate, true);
  v.setUint32(40, pcm.length, true);
  pcm.forEach((s, i) => v.setInt16(HEADER + i * 2, s, true));
  return buffer;
}
export function decode(buffer: ArrayBuffer) {
  if (buffer.byteLength < HEADER) throw new Error("Truncated audio frame");
  const v = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  if (bytes.slice(0, 8).join() !== "86,83,67,49,2,1,1,0")
    throw new Error("Unsupported playback format");
  const h = Array.from(bytes.slice(8, 24), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const seq = v.getUint32(24, true),
    offset = Number(v.getBigUint64(28, true));
  const rate = v.getUint32(36, true),
    count = v.getUint32(40, true);
  if (
    rate !== 24000 ||
    count === 0 ||
    count > 9600 ||
    buffer.byteLength !== HEADER + count * 2
  )
    throw new Error("Invalid audio frame");
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++)
    samples[i] = v.getInt16(HEADER + i * 2, true) / 32768;
  return { id, seq, offset, rate, samples };
}

export class Media {
  context?: AudioContext;
  playback?: AudioWorkletNode;
  capture?: AudioWorkletNode;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  generation: string | null = null;
  attempt = "";
  seq = 0;
  offset = 0;
  nextSeq = 0;
  nextOffset = 0;
  firstReceipt = 0;
  uploadFailed = false;
  playbackClock = 0;
  flushResolve?: () => void;
  constructor(
    public notify: (message: string, detail?: unknown) => void,
    public upload: (frame: ArrayBuffer) => void,
  ) {}
  async initialize() {
    if (!this.context) {
      this.context = new AudioContext();
      await Promise.all([
        this.context.audioWorklet.addModule("/audio/playback.js"),
        this.context.audioWorklet.addModule("/audio/capture.js"),
      ]);
      this.playback = new AudioWorkletNode(this.context, "progressive-pcm");
      this.playback.connect(this.context.destination);
      this.playback.port.onmessage = ({ data }) => {
        if (data.generation !== this.generation) return;
        if (data.type === "started") {
          this.playbackClock = data.clock;
          this.notify("audio.playback_started", {
            generation: data.generation,
            buffering_ms: performance.now() - this.firstReceipt,
            clock: data.clock,
          });
        } else if (data.type === "ended")
          this.notify("audio.playback_ended", data);
        else this.notify("error", "Playback buffer overflow");
      };
    }
    await this.context.resume();
    if (this.context.state !== "running")
      throw new Error("Audio unavailable: activate audio with a user gesture");
  }
  clear() {
    this.generation = null;
    this.firstReceipt = this.playbackClock = 0;
    this.playback?.port.postMessage({ type: "clear" });
  }
  audioMessage(message: any) {
    if (
      message.type === "audio.cancelled" &&
      message.generation_id === this.generation
    )
      this.clear();
    if (message.type === "audio.start") {
      if (!this.playback) {
        this.notify("error", "Audio unavailable; captions remain available");
        return;
      }
      this.clear();
      this.generation = message.generation_id;
      this.nextSeq = this.nextOffset = 0;
      this.playback.port.postMessage({
        type: "start",
        generation: this.generation,
        rate: message.sample_rate,
        bufferMs: message.buffer_ms,
      });
    }
    if (message.type === "audio.end")
      this.playback?.port.postMessage({
        type: "end",
        generation: message.generation_id,
      });
  }
  receive(buffer: ArrayBuffer) {
    const data = decode(buffer);
    if (data.id !== this.generation) return;
    if (data.seq !== this.nextSeq || data.offset !== this.nextOffset)
      throw new Error("Out-of-order audio");
    this.nextSeq++;
    this.nextOffset += data.samples.length;
    if (!this.firstReceipt) this.firstReceipt = performance.now();
    this.playback?.port.postMessage(
      { type: "pcm", generation: data.id, samples: data.samples },
      [data.samples.buffer],
    );
  }
  async prepareMicrophone() {
    await this.initialize();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.source = this.context!.createMediaStreamSource(this.stream);
    return this.context!.sampleRate;
  }
  startCapture(attempt: string) {
    this.clear();
    this.attempt = attempt;
    this.seq = this.offset = 0;
    this.uploadFailed = false;
    this.capture = new AudioWorkletNode(this.context!, "microphone-pcm");
    this.capture.port.onmessage = ({ data }) => {
      if (data.type === "flushed") {
        this.flushResolve?.();
        return;
      }
      const pcm: Int16Array = data.samples;
      if (this.uploadFailed) return;
      try {
        this.upload(
          frame(
            1,
            this.attempt,
            this.seq,
            this.offset,
            this.context!.sampleRate,
            pcm,
          ),
        );
        this.seq++;
        this.offset += pcm.length;
      } catch (e) {
        this.uploadFailed = true;
        this.notify("error", String(e));
      }
    };
    this.source!.connect(this.capture);
    // Worklet outputs silence, but connecting it ensures processing on all browsers.
    this.capture.connect(this.context!.destination);
  }
  async stopCapture() {
    if (this.capture) {
      const capture = this.capture;
      this.capture = undefined;
      this.source?.disconnect();
      await Promise.race([
        new Promise<void>((resolve) => {
          this.flushResolve = resolve;
          capture.port.postMessage("flush");
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      capture.disconnect();
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    return this.offset;
  }
  async dispose() {
    await this.stopCapture();
    this.clear();
    await this.context?.close();
  }
}
