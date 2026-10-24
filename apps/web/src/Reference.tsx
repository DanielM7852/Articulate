import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { PoseId } from "../../../packages/contracts/generated";
export interface ReferenceAdapter {
  setPose(pose: PoseId): void;
  playTimeline(generation: string, timings: unknown[]): void;
  stop(generation: string): void;
}
export const Reference = forwardRef<ReferenceAdapter, { pose: PoseId }>(
  ({ pose: initial }, ref) => {
    const [pose, setPose] = useState(initial);
    useEffect(() => setPose(initial), [initial]);
    useImperativeHandle(
      ref,
      () => ({ setPose, playTimeline: () => {}, stop: () => {} }),
      [],
    );
    const opening = pose === "vowel-aa" ? 0.7 : pose === "vowel-u" ? 0.3 : 0.22;
    return (
      <div className="reference-view">
        <Canvas
          camera={{ position: [0, 0, 4.6], fov: 38 }}
          aria-label="Illustrative static vowel reference"
        >
          <ambientLight intensity={1.4} />
          <directionalLight position={[3, 3, 4]} intensity={2} />
          <group>
            <mesh scale={[1.1, 1.4, 0.55]}>
              <sphereGeometry args={[1, 48, 48]} />
              <meshStandardMaterial
                color="#dbe7e3"
                transparent
                opacity={0.45}
              />
            </mesh>
            <mesh
              position={[0, -0.2, 0.57]}
              scale={[pose === "vowel-u" ? 0.32 : 0.65, opening, 0.1]}
            >
              <sphereGeometry args={[1, 40, 24]} />
              <meshStandardMaterial color="#184c43" />
            </mesh>
            <mesh
              position={[0, -0.3, 0.69]}
              scale={[pose === "vowel-u" ? 0.22 : 0.48, opening * 0.27, 0.06]}
            >
              <sphereGeometry args={[1, 32, 16]} />
              <meshStandardMaterial color="#dd967f" />
            </mesh>
          </group>
          <OrbitControls enablePan={false} minDistance={3} maxDistance={7} />
        </Canvas>
        <span className="pose-tag">
          {pose.replace("vowel-", "/").replace("aa", "ɑ")}
          {pose.startsWith("vowel") ? "/" : ""}
        </span>
        <p>
          Static illustrative placeholder · drag to rotate
          <br />
          Not a measurement of your anatomy
        </p>
      </div>
    );
  },
);
