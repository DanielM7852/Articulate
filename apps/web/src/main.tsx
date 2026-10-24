import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  FeatureFrame,
  Keyframes,
  PoseId,
  Target,
  VisionMetrics,
} from "../../../packages/contracts/generated";
import { Client, type Snapshot } from "./client";
import { Media } from "./audio";
import { Cursor } from "./Cursor";
import { Reference, type ReferenceAdapter } from "./Reference";
import {
  CameraTile,
  type CameraMode,
  type CameraTileHandle,
} from "./CameraTile";
import "./styles.css";

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [targets, setTargets] = useState<Target[]>([]);
  const [status, setStatus] = useState("Connecting…"),
    [error, setError] = useState("");
  const [frame, setFrame] = useState<FeatureFrame | null>(null),
    [visionFrame, setVisionFrame] = useState<VisionMetrics | null>(null),
    [caption, setCaption] = useState(
      "Choose a vowel, then try one short, comfortable sound.",
    );
  const [source, setSource] = useState<"synthetic" | "microphone">("synthetic"),
    [cameraMode, setCameraMode] = useState<CameraMode>("off"),
    [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false),
    [metrics, setMetrics] = useState<any[]>([]);
  const [readiness, setReadiness] = useState<any>(null);
  const client = useRef<Client | null>(null),
    media = useRef<Media | null>(null),
    ref = useRef<ReferenceAdapter>(null),
    cameraRef = useRef<CameraTileHandle>(null);
  const current = useRef<Snapshot | null>(null),
    attemptEnded = useRef(0);
  const addMetric = (m: any) => setMetrics((items) => [...items.slice(-24), m]);
  const update = (snap: Snapshot) => {
    current.current = snap;
    setSnapshot(snap);
  };
  useEffect(() => {
    const m = new Media(
      (kind, detail: any) => {
        if (kind === "error") {
          setError(String(detail));
          media.current?.clear();
          void client.current
            ?.command({ type: "feedback.cancel" })
            .catch(() => {});
          return;
        }
        if (detail.generation !== current.current?.generation_id) return;
        if (kind === "audio.playback_started") {
          addMetric({
            stage: "browser_first_receipt_to_playback",
            duration_ms: detail.buffering_ms,
          });
          if (attemptEnded.current)
            addMetric({
              stage: "browser_attempt_end_to_playback",
              duration_ms: performance.now() - attemptEnded.current,
            });
        }
        void client.current
          ?.command({
            type: kind as "audio.playback_started" | "audio.playback_ended",
            generation_id: detail.generation,
          })
          .catch((e) => setError(e.message));
      },
      (data) => client.current!.upload(data),
    );
    media.current = m;
    const c = new Client(
      (snap) => {
        update(snap);
        setFrame(null);
        if (snap.decision) setCaption(snap.decision.caption);
      },
      (event) => {
        const payload = event.payload as Record<string, any>;
        const old = current.current;
        if (event.type === "session.state" && old)
          update({
            ...old,
            session: payload.session,
            attempt_id: event.attempt_id,
            generation_id: event.generation_id,
            pending_sync: payload.pending_sync,
          });
        if (
          event.type === "features.frame" &&
          event.attempt_id === current.current?.attempt_id
        )
          setFrame(payload as unknown as FeatureFrame);
        if (event.type === "vision.frame")
          setVisionFrame(payload as unknown as VisionMetrics);
        if (event.type === "attempt.summary" && old)
          update({
            ...current.current!,
            history: [...current.current!.history, event.payload],
          });
        if (event.type === "coach.decision") {
          if (event.generation_id !== current.current?.generation_id) return;
          setCaption(payload.caption);
          ref.current?.setPose(payload.pose_id);
          if (attemptEnded.current)
            addMetric({
              stage: "browser_attempt_end_to_visible",
              duration_ms: performance.now() - attemptEnded.current,
            });
        }
        if (event.type === "audio.cancelled") {
          m.clear();
          ref.current?.stop(payload.cancelled_generation_id);
        }
        if (event.type === "audio.timings" && event.generation_id)
          ref.current?.playTimeline(event.generation_id, [event.payload]);
        if (event.type === "metrics") addMetric(event.payload);
        if (event.type === "error") setError(payload.detail);
        if (event.type === "provider.status" && payload.status)
          setStatus(payload.status);
        if (
          event.type === "provider.status" &&
          typeof payload.pending_sync === "number" &&
          current.current
        )
          update({ ...current.current, pending_sync: payload.pending_sync });
      },
      (message) => {
        if (
          message.type !== "audio.start" ||
          message.generation_id === current.current?.generation_id
        )
          m.audioMessage(message);
      },
      (data) => m.receive(data),
      setStatus,
      () => {
        m.clear();
        void m.stopCapture();
      },
    );
    client.current = c;
    c.connect()
      .then(() => setTargets(c.connection!.targets))
      .catch((e) => {
        setError(e.message);
        c.reconnect();
      });
    fetch("/health/ready")
      .then((r) => r.json())
      .then(setReadiness)
      .catch(() => {});
    return () => {
      c.dispose();
      void m.dispose();
    };
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
      await client.current?.refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function configure(
    target = snapshot!.session.target_id,
    audio = snapshot!.session.audio_enabled,
    assistance = snapshot!.session.assistance_level,
  ) {
    update({
      ...current.current!,
      session: {
        ...current.current!.session,
        target_id: target,
        audio_enabled: audio,
        assistance_level: assistance,
      },
    });
    await media.current!.stopCapture();
    media.current!.clear();
    setFrame(null);
    await client.current!.command({
      type: "session.configure",
      target_id: target,
      audio_enabled: audio,
      assistance_level: assistance,
    });
    const t = targets.find((t) => t.id === target);
    if (t) ref.current?.setPose(t.pose_id);
  }
  async function start() {
    await media.current!.stopCapture();
    media.current!.clear();
    setFrame(null);
    cameraRef.current?.resetAttempt();
    attemptEnded.current = 0;
    let rate = 24000;
    try {
      if (source === "microphone")
        rate = await media.current!.prepareMicrophone();
      if (snapshot!.session.audio_enabled) await media.current!.initialize();
      await client.current!.command({
        type: "attempt.start",
        source,
        sample_rate: rate,
      });
      if (source === "microphone")
        media.current!.startCapture(current.current!.attempt_id!);
      setCaption(
        source === "synthetic"
          ? "Synthetic feature fixture is running. Finish the attempt to see the demo cue."
          : "Hold one comfortable vowel, then finish the attempt.",
      );
    } catch (e) {
      await media.current!.stopCapture();
      throw e;
    }
  }
  async function finish() {
    attemptEnded.current = performance.now();
    const end =
      source === "microphone" ? await media.current!.stopCapture() : 0;
    const cvData =
      cameraMode !== "off" ? cameraRef.current?.getAttemptData() : undefined;
    await client.current!.command({
      type: "attempt.end",
      final_sample: end,
      vision_frames: cvData?.frames ?? [],
      keyframes: (cvData?.keyframes ?? []) as Keyframes,
    });
  }
  async function control(
    type: "feedback.cancel" | "session.pause" | "session.resume",
  ) {
    await media.current!.stopCapture();
    media.current!.clear();
    setFrame(null);
    await client.current!.command({ type });
  }
  if (!snapshot || !targets.length)
    return (
      <main>
        <h1>Articulate</h1>
        <p role="status">{status}</p>
        <p role="alert">{error}</p>
      </main>
    );
  const session = snapshot.session,
    target = targets.find((t) => t.id === session.target_id)!;
  const capturing = session.state === "capturing",
    paused = session.state === "paused";
  return (
    <main>
      <header>
        <a href="/" className="brand">
          <span className="brand-mark">a</span> articulate
        </a>
        <span className="session-status">
          <span className="status-dot" />
          {session.state} · {status}
        </span>
      </header>
      <div className="intro">
        <div>
          <p className="eyebrow">SEE YOUR SOUND</p>
          <h1>
            A little practice.
            <br />A clearer picture.
          </h1>
          <p>
            Explore a vowel, see its acoustic position, and try again at your
            pace.
          </p>
        </div>
        <div className="mode-badge">
          {snapshot.mock_mode ? "DEMO · MOCK PROVIDERS" : "PROVIDER MODE"}
          <small>
            {source === "synthetic" ? "Synthetic features" : "Live microphone"}
            {snapshot.mock_mode ? " · diagnostic tone only" : ""}
          </small>
        </div>
      </div>
      <section className="practice-controls" aria-label="Practice settings">
        <div className="vowels" role="group" aria-label="Target vowel">
          {targets.map((t) => (
            <button
              key={t.id}
              aria-pressed={t.id === session.target_id}
              disabled={busy}
              onClick={() => act(() => configure(t.id))}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label>
          Input{" "}
          <select
            value={source}
            disabled={capturing || busy}
            onChange={(e) => setSource(e.target.value as typeof source)}
          >
            <option value="synthetic">Synthetic fixture</option>
            <option value="microphone">Microphone</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={session.audio_enabled}
            disabled={busy}
            onChange={(e) => {
              const checked = e.currentTarget.checked;
              update({
                ...current.current!,
                session: {
                  ...current.current!.session,
                  audio_enabled: checked,
                },
              });
              void act(async () => {
                if (checked) await media.current!.initialize();
                await configure(session.target_id, checked);
              });
            }}
          />
          Audio
        </label>
      </section>
      <div className="panels">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">01 / OBSERVE</span>
              <h2>Your sound</h2>
            </div>
            <span className="pill">
              {frame?.valid
                ? "Tracking"
                : capturing
                  ? "Waiting for usable input"
                  : "Ready when you are"}
            </span>
          </div>
          <Cursor
            frame={frame}
            target={target}
            reduced={session.assistance_level === "reduced"}
          />
          <div className="panel-foot">
            <span>
              {frame?.valid
                ? `F1 ${Math.round(frame.f1!)} Hz · F2 ${Math.round(frame.f2!)} Hz${
                    frame.lip_opening != null
                      ? ` · Lip open ${frame.lip_opening.toFixed(2)}`
                      : ""
                  }`
                : frame?.quality_flags.join(", ") ||
                  "Speak to move the acoustic cursor"}
            </span>
            <span>
              {source === "synthetic" ? "SYNTHETIC" : "MEASURED ACOUSTICS"}
            </span>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">02 / EXPLORE</span>
              <h2>Target reference</h2>
            </div>
            <span className="pill">{target.label}</span>
          </div>
          <Reference ref={ref} pose={target.pose_id as PoseId} />
        </section>
      </div>

      <CameraTile
        ref={cameraRef}
        targetId={session.target_id}
        capturing={capturing}
        mode={cameraMode}
        onModeChange={setCameraMode}
        onTelemetry={(vf) => {
          setVisionFrame(vf);
          client.current?.sendVisionTelemetry(vf);
        }}
        onError={(msg) => setError(msg)}
      />

      <section className="coach" aria-label="Coaching feedback">
        <span className="coach-icon">↗</span>
        <div>
          <p className="eyebrow">ONE STEP AT A TIME</p>
          <p className="caption" role="status" aria-live="polite">
            {caption}
          </p>
          <small>
            {snapshot.mock_mode
              ? "Cue drafts are unreviewed engineering demonstrations. "
              : ""}
            {cameraMode === "off"
              ? "Camera unavailable; no lip evidence is collected."
              : `Camera active (${cameraMode}); MediaPipe lip geometry, 22 blendshapes, and 3 keyframe crops are sent to the coach.`}
          </small>
        </div>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={busy || paused}
          onClick={() => act(capturing ? finish : start)}
        >
          {capturing
            ? "Finish attempt"
            : snapshot.history.length
              ? "Try again"
              : "Start attempt"}{" "}
          <span>{capturing ? "■" : "→"}</span>
        </button>
        <button
          disabled={busy}
          onClick={() => act(() => control("feedback.cancel"))}
        >
          Cancel feedback
        </button>
        <button
          disabled={busy}
          onClick={() =>
            act(() => control(paused ? "session.resume" : "session.pause"))
          }
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={session.assistance_level === "reduced"}
            onChange={(e) =>
              act(() =>
                configure(
                  session.target_id,
                  session.audio_enabled,
                  e.target.checked ? "reduced" : "guided",
                ),
              )
            }
          />
          Hide target guide
        </label>
      </div>
      <p className="fineprint">
        Demonstration regions vary by speaker and dialect. A region match is an
        acoustic task result. {target.provenance}
      </p>
      <section className="history">
        <div className="history-heading">
          <h2>
            Your attempts <span>{snapshot.history.length}</span>
          </h2>
          <small>
            {snapshot.pending_sync} pending sync · {snapshot.persistence}
          </small>
        </div>
        {!snapshot.history.length ? (
          <p>Your first attempt will appear here.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Attempt</th>
                  <th>Target</th>
                  <th>Usable audio</th>
                  <th>Acoustic distance</th>
                  <th>CV lip metrics</th>
                  <th>Input</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.history
                  .slice(-8)
                  .reverse()
                  .map((a, i) => (
                    <tr key={a.attempt_id}>
                      <td>{snapshot.history.length - i}</td>
                      <td>
                        {targets.find((t) => t.id === a.target_id)?.label}
                      </td>
                      <td>
                        {Math.round(a.usable_duration_ms)} ms ·{" "}
                        {Math.round(a.usable_fraction * 100)}%
                      </td>
                      <td>
                        {a.target_distance == null
                          ? "Unavailable"
                          : a.target_distance.toFixed(2)}
                      </td>
                      <td>
                        {a.lip_opening_mean == null
                          ? "No camera"
                          : `open ${a.lip_opening_mean.toFixed(2)} · width ${(a.lip_width_mean ?? 0).toFixed(2)}${
                              a.vision_summary?.keyframes_count
                                ? ` · ${a.vision_summary.keyframes_count} keyframes`
                                : ""
                            }`}
                      </td>
                      <td>{a.source}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <footer>
        <span>Practice at your pace. Captions are always available.</span>
        <button
          onClick={() => setDiagnostics(!diagnostics)}
          aria-expanded={diagnostics}
        >
          Developer diagnostics
        </button>
      </footer>
      {diagnostics && (
        <section className="diagnostics">
          <h2>Runtime diagnostics</h2>
          <pre>
            {JSON.stringify(
              {
                providers: readiness,
                metrics,
                session: session.id,
                camera:
                  cameraMode === "off"
                    ? "unavailable"
                    : `${cameraMode} (${snapshot.camera ?? "active"})`,
                latest_vision: visionFrame ?? snapshot.latest_vision ?? null,
              },
              null,
              2,
            )}
          </pre>
        </section>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
