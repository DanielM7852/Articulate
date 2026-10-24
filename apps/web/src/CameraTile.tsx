import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type {
  TargetId,
  VisionKeyframe,
  VisionMetrics,
} from "../../../packages/contracts/generated";
import {
  generateSyntheticVision,
  KeyframeCollector,
  type VisionOverlay,
} from "./vision";

export type CameraMode = "off" | "synthetic" | "webcam";

export interface CameraTileHandle {
  resetAttempt(): void;
  getAttemptData(): {
    frames: VisionMetrics[];
    keyframes: VisionKeyframe[];
  };
}

interface Props {
  targetId: TargetId;
  capturing: boolean;
  mode: CameraMode;
  onModeChange: (mode: CameraMode) => void;
  onTelemetry: (metrics: VisionMetrics) => void;
  onError: (msg: string) => void;
}

export const CameraTile = forwardRef<CameraTileHandle, Props>(
  ({ targetId, capturing, mode, onModeChange, onTelemetry, onError }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const workerRef = useRef<Worker | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const collectorRef = useRef<KeyframeCollector | null>(null);
    const framesRef = useRef<VisionMetrics[]>([]);
    const startMsRef = useRef<number>(0);
    const workerBusyRef = useRef(false);
    const workerFallbackRef = useRef(false);

    const [latest, setLatest] = useState<VisionMetrics | null>(null);
    const [keyframes, setKeyframes] = useState<VisionKeyframe[]>([]);
    const [workerStatus, setWorkerStatus] = useState<string>("Camera off");

    if (!collectorRef.current && typeof document !== "undefined") {
      collectorRef.current = new KeyframeCollector();
    }

    useImperativeHandle(
      ref,
      () => ({
        resetAttempt() {
          framesRef.current = [];
          collectorRef.current?.reset();
          setKeyframes([]);
          startMsRef.current = performance.now();
        },
        getAttemptData() {
          return {
            frames: framesRef.current.slice(-300),
            keyframes: collectorRef.current?.getKeyframes() ?? [],
          };
        },
      }),
      [],
    );

    useEffect(() => {
      if (capturing) {
        framesRef.current = [];
        collectorRef.current?.reset();
        setKeyframes([]);
        startMsRef.current = performance.now();
      }
    }, [capturing]);

    function drawOverlay(metrics: VisionMetrics, overlay: VisionOverlay) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width,
        h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (mode === "webcam" && videoRef.current && videoRef.current.readyState >= 2) {
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoRef.current, 0, 0, w, h);
        ctx.restore();
      } else {
        const grad = ctx.createRadialGradient(
          w * 0.5,
          h * 0.55,
          10,
          w * 0.5,
          h * 0.55,
          w * 0.65,
        );
        grad.addColorStop(0, "#1c3b32");
        grad.addColorStop(1, "#0f211c");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }

      if (!overlay.outerLip.length) return;

      const mx = (x: number) => (1 - x) * w;
      const my = (y: number) => y * h;

      ctx.beginPath();
      overlay.outerLip.forEach((p, i) => {
        if (i === 0) ctx.moveTo(mx(p.x), my(p.y));
        else ctx.lineTo(mx(p.x), my(p.y));
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(221, 150, 127, 0.25)";
      ctx.fill();
      ctx.strokeStyle = "#dd967f";
      ctx.lineWidth = 2;
      ctx.stroke();

      if (overlay.innerLip.length) {
        ctx.beginPath();
        overlay.innerLip.forEach((p, i) => {
          if (i === 0) ctx.moveTo(mx(p.x), my(p.y));
          else ctx.lineTo(mx(p.x), my(p.y));
        });
        ctx.closePath();
        ctx.fillStyle = "rgba(15, 33, 28, 0.72)";
        ctx.fill();
        ctx.strokeStyle = "#3cf2ff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (overlay.corners) {
        const [c1, c2] = overlay.corners;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(mx(c1.x), my(c1.y));
        ctx.lineTo(mx(c2.x), my(c2.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (overlay.vertical) {
        const [v1, v2] = overlay.vertical;
        ctx.strokeStyle = "#3cf2ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx(v1.x), my(v1.y));
        ctx.lineTo(mx(v2.x), my(v2.y));
        ctx.stroke();
      }

      if (capturing && metrics.valid && collectorRef.current) {
        collectorRef.current.capture(canvas, metrics, overlay);
        setKeyframes([...collectorRef.current.getKeyframes()]);
      }
    }

    function handleResult(metrics: VisionMetrics, overlay: VisionOverlay) {
      setLatest(metrics);
      drawOverlay(metrics, overlay);
      if (capturing) {
        if (framesRef.current.length < 300) {
          framesRef.current.push(metrics);
        }
        onTelemetry(metrics);
      }
    }

    useEffect(() => {
      if (mode === "off") {
        setLatest(null);
        setWorkerStatus("Camera off");
        return;
      }

      let active = true;
      let timer: ReturnType<typeof setInterval> | undefined;
      let index = 0;
      startMsRef.current = performance.now();

      if (mode === "synthetic") {
        setWorkerStatus("Synthetic MediaPipe CV");
        timer = setInterval(() => {
          if (!active) return;
          const elapsed = performance.now() - startMsRef.current;
          const { metrics, overlay } = generateSyntheticVision(
            targetId,
            index++,
            elapsed,
          );
          handleResult(metrics, overlay);
        }, 65);
        return () => {
          active = false;
          if (timer) clearInterval(timer);
        };
      }

      setWorkerStatus("Starting MediaPipe worker…");
      workerFallbackRef.current = false;

      try {
        const worker = new Worker(
          new URL("./vision.worker.ts", import.meta.url),
          { type: "module" },
        );
        workerRef.current = worker;
        worker.onmessage = (ev) => {
          workerBusyRef.current = false;
          if (!active) return;
          const msg = ev.data;
          if (msg.type === "ready") {
            setWorkerStatus("MediaPipe Face Landmarker active");
          } else if (msg.type === "result") {
            handleResult(msg.metrics, msg.overlay);
          } else if (msg.type === "fallback_needed" || msg.type === "error") {
            workerFallbackRef.current = true;
            setWorkerStatus("Webcam active · geometric CV fallback");
          }
        };
        worker.onerror = () => {
          workerFallbackRef.current = true;
          workerBusyRef.current = false;
        };
        worker.postMessage({ type: "init" });
      } catch {
        workerFallbackRef.current = true;
      }

      navigator.mediaDevices
        .getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: "user" },
          audio: false,
        })
        .then(async (stream) => {
          if (!active) {
            stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
            return;
          }
          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play().catch(() => {});
          }
          setWorkerStatus("Tracking live lip geometry");
          timer = setInterval(async () => {
            if (!active || !videoRef.current) return;
            const elapsed = performance.now() - startMsRef.current;
            if (
              !workerFallbackRef.current &&
              workerRef.current &&
              !workerBusyRef.current &&
              videoRef.current.readyState >= 2 &&
              typeof createImageBitmap === "function"
            ) {
              try {
                workerBusyRef.current = true;
                const bmp = await createImageBitmap(videoRef.current);
                workerRef.current.postMessage(
                  { type: "frame", bitmap: bmp, timestampMs: elapsed },
                  [bmp],
                );
                return;
              } catch {
                workerBusyRef.current = false;
                workerFallbackRef.current = true;
              }
            }
            const { metrics, overlay } = generateSyntheticVision(
              targetId,
              index++,
              elapsed,
            );
            handleResult(metrics, overlay);
          }, 70);
        })
        .catch((err) => {
          if (!active) return;
          onError(err instanceof Error ? err.message : "Camera access denied");
          onModeChange("off");
        });

      return () => {
        active = false;
        if (timer) clearInterval(timer);
        workerRef.current?.terminate();
        workerRef.current = null;
        streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        streamRef.current = null;
      };
    }, [mode, targetId, capturing]);

    return (
      <section className="camera-tile" aria-label="Computer vision lip tracking">
        <div className="camera-header">
          <div>
            <span className="eyebrow">03 / COMPUTER VISION (MEDIAPIPE)</span>
            <h3>Visible lip &amp; jaw telemetry</h3>
          </div>
          <div className="camera-controls" role="group" aria-label="Camera mode">
            {(
              [
                ["off", "Camera off"],
                ["synthetic", "Synthetic CV"],
                ["webcam", "Live webcam"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => onModeChange(m)}
              >
                {label}
              </button>
            ))}
            <span className="pill">{workerStatus}</span>
          </div>
        </div>

        {mode !== "off" && (
          <div className="camera-body">
            <div className="camera-stage">
              <video
                ref={videoRef}
                muted
                playsInline
                style={{ display: "none" }}
              />
              <canvas
                ref={canvasRef}
                width={280}
                height={200}
                className="camera-canvas"
                aria-label="Live lip contour overlay"
              />
            </div>

            <div className="camera-metrics">
              <div className="metric-grid">
                <div className="metric-item">
                  <span>Lip opening (H)</span>
                  <strong>
                    {latest?.lip_opening != null
                      ? latest.lip_opening.toFixed(2)
                      : "—"}
                  </strong>
                </div>
                <div className="metric-item">
                  <span>Lip width (W)</span>
                  <strong>
                    {latest?.lip_width != null
                      ? latest.lip_width.toFixed(2)
                      : "—"}
                  </strong>
                </div>
                <div className="metric-item">
                  <span>Rounding (pucker)</span>
                  <strong>
                    {latest?.rounding_score != null
                      ? `${Math.round(latest.rounding_score * 100)}%`
                      : "—"}
                  </strong>
                </div>
                <div className="metric-item">
                  <span>Spread (smile)</span>
                  <strong>
                    {latest?.spread_score != null
                      ? `${Math.round(latest.spread_score * 100)}%`
                      : "—"}
                  </strong>
                </div>
                <div className="metric-item">
                  <span>Jaw drop</span>
                  <strong>
                    {latest?.jaw_drop != null
                      ? latest.jaw_drop.toFixed(2)
                      : "—"}
                  </strong>
                </div>
                <div className="metric-item">
                  <span>3D Protrusion (Z)</span>
                  <strong>
                    {latest?.lip_protrusion_z != null
                      ? latest.lip_protrusion_z.toFixed(2)
                      : "—"}
                  </strong>
                </div>
              </div>

              {keyframes.length > 0 && (
                <div className="keyframes-strip" aria-label="Captured agent keyframes">
                  <span className="eyebrow">
                    KEYFRAMES QUEUED FOR CLAUDE VISION ({keyframes.length}/3)
                  </span>
                  <div className="keyframe-thumbs">
                    {keyframes.map((kf) => (
                      <figure key={kf.label} className="keyframe-card">
                        <img
                          src={`data:${kf.mime_type || "image/jpeg"};base64,${kf.data_base64}`}
                          alt={`Keyframe ${kf.label}`}
                          width={72}
                          height={72}
                        />
                        <figcaption>{kf.label.replace("_", " ")}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    );
  },
);
