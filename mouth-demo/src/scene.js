import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// The stage backdrop: a soft radial gradient, optionally washed toward a flat colour (setBackdrop).
function makeBackground() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  function draw(color, amount) {
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 181);
    grad.addColorStop(0, "#FFFFFF");
    grad.addColorStop(1, "#CBD7E6");
    g.globalAlpha = 1;
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    if (color && amount > 0) {
      g.globalAlpha = Math.min(1, amount);
      g.fillStyle = color;
      g.fillRect(0, 0, 256, 256);
      g.globalAlpha = 1;
    }
    tex.needsUpdate = true;
  }
  draw(null, 0);
  return { tex, draw };
}

// Pixel-ratio caps per quality tier (quality.js): the fill rate is most of the GPU cost of the dots.
export const PIXEL_RATIO_CAP = { full: 2, light: 1.25 };

export function createScene(host, { pixelRatioCap = PIXEL_RATIO_CAP.full } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  let ratioCap = pixelRatioCap > 0 ? pixelRatioCap : PIXEL_RATIO_CAP.full;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, ratioCap));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const backdrop = makeBackground();
  const background = backdrop.tex;
  scene.background = background;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  camera.position.set(0, 1.6, 0.55);
  camera.lookAt(0, 1.6, 0);
  scene.add(camera);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.6, 0);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.rotateSpeed = 0.5;
  controls.update();

  // key light rides on the camera so it follows every view
  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.position.set(0.3, 0.6, 1);
  keyLight.target.position.set(0, 0, -1);
  keyLight.visible = false;
  camera.add(keyLight);
  camera.add(keyLight.target);

  let pmrem = null;
  let envTexture = null;
  let raf = 0;
  let last = 0;
  let disposed = false;

  /** Cap the pixel ratio at x (the drawing buffer is resized at once; the CSS size is unchanged). */
  function setPixelRatioCap(x) {
    if (!(x > 0) || disposed) return;
    ratioCap = x;
    const next = Math.min(window.devicePixelRatio || 1, ratioCap);
    if (next !== renderer.getPixelRatio()) renderer.setPixelRatio(next);
  }

  function setSize(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function setSolidLighting(on) {
    if (on) {
      if (!envTexture) {
        pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        envTexture = pmrem.fromScene(room, 0.04).texture;
        room.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
      }
      scene.environment = envTexture;
      keyLight.visible = true;
    } else {
      scene.environment = null;
      keyLight.visible = false;
    }
  }

  function startLoop(onFrame) {
    stopLoop();
    last = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const dt = last ? Math.min(100, Math.max(0, now - last)) : 0;
      last = now;
      onFrame(dt, now);
    };
    raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopLoop();
    controls.dispose();
    if (envTexture) envTexture.dispose();
    if (pmrem) pmrem.dispose();
    scene.environment = null;
    background.dispose();
    scene.background = null;
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  return {
    renderer, scene, camera, canvas, controls,
    setSize, setSolidLighting, setPixelRatioCap, startLoop, stopLoop, dispose,
    get pixelRatioCap() { return ratioCap; },
    /** Wash the gradient toward a flat colour: amount 0 is the plain gradient, 1 the colour. */
    setBackdrop: (color, amount) => backdrop.draw(color, amount),
  };
}
