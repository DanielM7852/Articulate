import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

function makeBackground() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 181);
  grad.addColorStop(0, "#25102A");
  grad.addColorStop(1, "#140A16");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createScene(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const background = makeBackground();
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
    setSize, setSolidLighting, startLoop, stopLoop, dispose,
  };
}
