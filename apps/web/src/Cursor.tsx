import { useEffect, useRef } from "react";
import type {
  FeatureFrame,
  Target,
} from "../../../packages/contracts/generated";
export function Cursor({
  frame,
  target,
  reduced,
}: {
  frame: FeatureFrame | null;
  target: Target;
  reduced: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    trail = useRef<[number, number][]>([]);
  const filtered = useRef<[number, number] | null>(null);
  useEffect(() => {
    trail.current = [];
    filtered.current = null;
  }, [target.id]);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const width = 660,
      height = 380,
      pad = 45;
    const x = (f2: number) => pad + ((3500 - f2) / 3000) * (width - 2 * pad),
      y = (f1: number) => pad + ((f1 - 150) / 1100) * (height - 2 * pad);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#dbe5de";
    ctx.lineWidth = 1;
    ctx.font = "12px system-ui";
    ctx.fillStyle = "#65766c";
    for (const f2 of [3000, 2000, 1000]) {
      const a = x(f2);
      ctx.beginPath();
      ctx.moveTo(a, pad);
      ctx.lineTo(a, height - pad);
      ctx.stroke();
      ctx.fillText(String(f2), a - 13, height - 20);
    }
    for (const f1 of [300, 600, 900]) {
      const b = y(f1);
      ctx.beginPath();
      ctx.moveTo(pad, b);
      ctx.lineTo(width - pad, b);
      ctx.stroke();
      ctx.fillText(String(f1), 8, b + 4);
    }
    ctx.fillText("\u2190 F2 (Hz)", width - 105, height - 2);
    ctx.fillText("F1 (Hz) \u2193", 5, 18);
    if (!reduced) {
      ctx.fillStyle = "#e1eee2";
      ctx.strokeStyle = "#729a7a";
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.ellipse(
        x(target.f2),
        y(target.f1),
        (target.radius_f2 / 3000) * (width - 2 * pad),
        (target.radius_f1 / 1100) * (height - 2 * pad),
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (frame?.valid && frame.f1 != null && frame.f2 != null) {
      // EMA alpha .3 smooths display only, without consulting the target. Summary uses raw data.
      const old = filtered.current;
      const now: [number, number] = old
        ? [
            old[0] + 0.3 * (frame.f1 - old[0]),
            old[1] + 0.3 * (frame.f2 - old[1]),
          ]
        : [frame.f1, frame.f2];
      filtered.current = now;
      trail.current.push(now);
      if (trail.current.length > 35) trail.current.shift();
    }
    trail.current.forEach(([a, b], i) => {
      ctx.fillStyle = `rgba(20,94,78,${0.05 + (i / trail.current.length) * 0.25})`;
      ctx.beginPath();
      ctx.arc(x(b), y(a), 3, 0, Math.PI * 2);
      ctx.fill();
    });
    if (filtered.current) {
      ctx.globalAlpha = frame?.valid ? 1 : 0.2;
      ctx.fillStyle = "#14624f";
      ctx.beginPath();
      ctx.arc(
        x(filtered.current[1]),
        y(filtered.current[0]),
        9,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }, [frame, target, reduced]);
  return (
    <canvas
      ref={canvas}
      width="660"
      height="380"
      className="cursor"
      aria-label="Acoustic vowel space: F2 decreases left to right, F1 increases downwards"
    />
  );
}
