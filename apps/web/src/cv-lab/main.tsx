import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  VisionCapture,
  VisionRecorder,
  OUTER_LIP,
  INNER_LIP,
  type VisionAttempt,
  type VisionFrame,
} from "../cv";
import "./style.css";

function download(attempt: VisionAttempt) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(attempt)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `cv-${attempt.attemptId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function App() {
  const video = useRef<HTMLVideoElement>(null),
    overlay = useRef<HTMLCanvasElement>(null),
    capture = useRef<VisionCapture | null>(null),
    stream = useRef<MediaStream | null>(null);
  const recorder = useRef(new VisionRecorder()),
    images = useRef(false),
    alive = useRef(true),
    run = useRef(0),
    lastUi = useRef(0),
    finishTask = useRef<Promise<void> | null>(null);
  const [status, setStatus] = useState("off"),
    [error, setError] = useState(""),
    [latest, setLatest] = useState<VisionFrame | null>(null);
  const [recording, setRecording] = useState(false),
    [finishing, setFinishing] = useState(false),
    [attempt, setAttempt] = useState<VisionAttempt | null>(null);
  const [includeImages, setIncludeImages] = useState(false),
    [label, setLabel] = useState(""),
    [observed, setObserved] = useState(0);
  function draw(f: VisionFrame) {
    const canvas = overlay.current,
      ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = f.image.width;
    canvas.height = f.image.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const points = f.raw.landmarks;
    if (!points.length) return;
    ctx.strokeStyle = f.quality.usable ? "#70e6ba" : "#ffb76a";
    ctx.lineWidth = 2;
    for (const contour of [OUTER_LIP, INNER_LIP]) {
      ctx.beginPath();
      contour.forEach((i, j) => {
        const p = points[i];
        if (!p) return;
        const x = p.x * canvas.width,
          y = p.y * canvas.height;
        j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }
  function finish(): Promise<void> {
    if (finishTask.current) return finishTask.current;
    if (!recorder.current.recording) return Promise.resolve();
    setFinishing(true);
    recorder.current.closeWindow(performance.now());
    const task = (async () => {
      await capture.current?.drain();
      if (!alive.current) return;
      setAttempt(
        recorder.current.finish(undefined, capture.current?.stats ?? null),
      );
      setRecording(false);
      setFinishing(false);
    })();
    finishTask.current = task;
    void task.finally(() => {
      finishTask.current = null;
    });
    return task;
  }
  async function stop() {
    ++run.current;
    await finish();
    capture.current?.stop();
    capture.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setLatest(null);
    setStatus("off");
    const canvas = overlay.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }
  async function start() {
    const myRun = ++run.current;
    setError("");
    setStatus("loading");
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      if (myRun !== run.current || !alive.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      video.current!.srcObject = media;
      await video.current!.play();
      if (myRun !== run.current || !alive.current) return;
      const c = new VisionCapture({
        includeImages: () => images.current && recorder.current.recording,
        onStatus: (s, detail) => {
          if (!alive.current || myRun !== run.current) return;
          setStatus(s);
          if (detail) {
            setError(detail);
            recorder.current.mark("capture.error", performance.now(), {
              detail,
            });
            stream.current?.getTracks().forEach((t) => t.stop());
          }
        },
        onObservation: (observation) => {
          recorder.current.push(observation);
          draw(observation.frame);
          if (performance.now() - lastUi.current > 180) {
            lastUi.current = performance.now();
            setLatest(observation.frame);
            setObserved(recorder.current.observedFrames);
          }
        },
      });
      capture.current = c;
      await c.start(video.current!);
    } catch (err) {
      if (myRun !== run.current || !alive.current) return;
      capture.current?.stop();
      capture.current = null;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(
    () => () => {
      alive.current = false;
      ++run.current;
      capture.current?.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  const value = (n: number | null | undefined) =>
    n == null ? "—" : n.toFixed(3);
  const stats = capture.current?.stats;
  return (
    <main>
      <header>
        <p className="eyebrow">ARTICULATE / COMPUTER VISION</p>
        <h1>Collect first. Reason later.</h1>
        <p className="intro">
          Inspect and export camera observations for the coaching agent. This
          collector runs without the backend.
        </p>
      </header>
      <div className="toolbar">
        <button
          onClick={() => void start()}
          disabled={status === "loading" || status === "ready"}
        >
          Start camera
        </button>
        <button
          className="secondary"
          onClick={() => void stop()}
          disabled={status === "off"}
        >
          Stop camera
        </button>
        <span role="status" className={`status ${status}`}>
          {status === "ready"
            ? latest?.quality.usable
              ? "Tracking · usable"
              : "Camera ready · waiting for usable face"
            : status}
        </span>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="grid">
        <section className="panel">
          <h2>Live capture</h2>
          <div className="preview">
            <video ref={video} muted playsInline />
            <canvas ref={overlay} />
            {status === "off" && <p>Camera off</p>}
          </div>
          <p className="note">
            Preview is mirrored. Exported coordinates and optional images are
            unmirrored. No microphone is opened.
          </p>
          <div className="facts">
            <span>{latest?.raw.landmarks.length ?? 0} landmarks</span>
            <span>
              {Object.keys(latest?.raw.blendshapes ?? {}).length} blendshapes
            </span>
            <span>{capture.current?.model?.delegate ?? "—"} delegate</span>
          </div>
          <p className="note">
            {latest
              ? [
                  ...latest.quality.rejectionReasons,
                  ...latest.quality.warnings,
                ].join(" · ") || "No capture flags"
              : "Waiting for observations"}
          </p>
        </section>
        <section className="panel">
          <h2>Attempt recorder</h2>
          <label>
            Optional label
            <input
              value={label}
              maxLength={120}
              disabled={recording}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="For example: oo, first attempt"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={includeImages}
              disabled={recording}
              onChange={(e) => {
                setIncludeImages(e.target.checked);
                images.current = e.target.checked;
              }}
            />
            Include sampled mouth images in the export
          </label>
          <p className="note">
            Frames stay in memory until you export or leave. No camera
            observations are uploaded. Images are off by default.
          </p>
          <div className="toolbar">
            <button
              disabled={status !== "ready" || recording}
              onClick={() => {
                recorder.current.begin(
                  crypto.randomUUID(),
                  performance.now(),
                  performance.timeOrigin,
                  label || null,
                );
                setObserved(0);
                setRecording(true);
                setAttempt(null);
              }}
            >
              Begin attempt
            </button>
            <button
              className="secondary"
              disabled={!recording || finishing}
              onClick={() => void finish()}
            >
              {finishing ? "Finishing…" : "Finish attempt"}
            </button>
          </div>
          <p aria-live="polite">
            {recording
              ? `Recording · ${observed} observations`
              : attempt
                ? `${attempt.summary.retainedFrames} frames · ${Math.round(attempt.summary.usableFraction * 100)}% usable`
                : "Start the camera, then begin an attempt."}
          </p>
          <button
            disabled={!attempt}
            onClick={() => attempt && download(attempt)}
          >
            Export attempt JSON
          </button>
          {attempt && (
            <p className="note">
              {attempt.imageSamples.length} image samples ·{" "}
              {attempt.summary.droppedFrames} frames omitted by buffer cap ·{" "}
              {attempt.summary.droppedImageSamples} image samples replaced
            </p>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>Available measurements</h2>
        <div className="metrics">
          {Object.entries(latest?.geometry ?? {})
            .filter(([k]) => k !== "mouthCenter")
            .map(([key, v]) => (
              <div key={key}>
                <span>{key}</span>
                <strong>{value(v as number | null)}</strong>
              </div>
            ))}
          {latest?.pose &&
            Object.entries(latest.pose).map(([k, v]) => (
              <div key={k}>
                <span>{k}</span>
                <strong>{value(v)}°</strong>
              </div>
            ))}
        </div>
        <p className="note">
          Geometry uses interocular normalization. Depth, asymmetry and
          nose-to-chin distance are visual proxies; they do not measure internal
          anatomy.
        </p>
        <details>
          <summary>All model blendshapes</summary>
          <div className="metrics">
            {Object.entries(latest?.raw.blendshapes ?? {}).map(([key, v]) => (
              <div key={key}>
                <span>{key}</span>
                <strong>{value(v)}</strong>
              </div>
            ))}
          </div>
        </details>
        <details>
          <summary>Capture diagnostics</summary>
          <pre>
            {JSON.stringify(
              {
                stats,
                timing: latest?.timing,
                imageQuality: latest?.quality.image,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </section>
      {attempt && (
        <section className="panel">
          <h2>Attempt summary</h2>
          <pre>{JSON.stringify(attempt.summary, null, 2)}</pre>
          <div className="images">
            {attempt.keyframes.map((k) => {
              const s = attempt.imageSamples.find(
                (i) => i.streamId === k.streamId && i.sequence === k.sequence,
              );
              return (
                s && (
                  <figure key={k.label}>
                    <img
                      src={`data:${s.mimeType};base64,${s.dataBase64}`}
                      alt={k.label.replaceAll("_", " ")}
                    />
                    <figcaption>
                      {k.label.replaceAll("_", " ")} ·{" "}
                      {Math.round(
                        s.captureMonotonicMs - attempt.startedMonotonicMs,
                      )}{" "}
                      ms
                    </figcaption>
                  </figure>
                )
              );
            })}
          </div>
        </section>
      )}
      <footer>
        Schema: articulate.cv/1 · Full raw observations and descriptive
        summaries · No pronunciation scoring
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
