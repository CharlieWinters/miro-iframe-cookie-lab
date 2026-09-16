/**
 * The "editing surface" stand-in: a three.js scene with floating extruded 3D text.
 *
 * The text is whatever survived in a cookie, so the viewer doubles as the readout for the
 * cookie experiments — if the panel forgets your value on reload, the 3D text says so.
 */

import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FONT_URL = new URL('../vendor/fonts/helvetiker_bold.typeface.json', import.meta.url).href;

/** helvetiker only carries Latin glyphs; anything else logs a per-character error and vanishes. */
export function sanitize(text) {
  const cleaned = Array.from(text || '')
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x24f)
    .join('');
  return { text: cleaned, dropped: Array.from(text || '').length - Array.from(cleaned).length };
}

export async function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);
  scene.fog = new THREE.Fog(0x0e1116, 400, 1400);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 4000);
  camera.position.set(0, 60, 420);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 150;
  controls.maxDistance = 1200;
  controls.target.set(0, 20, 0);

  scene.add(new THREE.HemisphereLight(0x9fd0ff, 0x1b1f27, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(120, 220, 320);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x4f7cff, 1.6);
  rim.position.set(-260, 40, -180);
  scene.add(rim);

  const grid = new THREE.GridHelper(2000, 40, 0x2a3140, 0x1a1f28);
  grid.position.y = -70;
  scene.add(grid);

  const group = new THREE.Group();
  scene.add(group);

  const mainMaterial = [
    new THREE.MeshStandardMaterial({ color: 0xf5f7fa, metalness: 0.35, roughness: 0.28 }),
    new THREE.MeshStandardMaterial({ color: 0x4262ff, metalness: 0.5, roughness: 0.4 }),
  ];
  const subMaterial = new THREE.MeshStandardMaterial({
    color: 0x7f8da5,
    metalness: 0.1,
    roughness: 0.7,
  });

  let font = null;
  let fontError = null;
  try {
    font = await new FontLoader().loadAsync(FONT_URL);
  } catch (e) {
    fontError = e.message || String(e);
  }

  let mainMesh = null;
  let subMesh = null;

  function buildMesh(text, size, material, curveSegments, bevel) {
    if (!font || !text) return null;
    const geo = new TextGeometry(text, {
      font,
      size,
      depth: size * 0.22,
      curveSegments,
      bevelEnabled: bevel,
      bevelThickness: size * 0.03,
      bevelSize: size * 0.02,
      bevelSegments: 3,
    });
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    geo.translate(-(bb.max.x - bb.min.x) / 2, -(bb.max.y - bb.min.y) / 2, 0);
    return new THREE.Mesh(geo, material);
  }

  function disposeMesh(mesh) {
    if (!mesh) return;
    group.remove(mesh);
    mesh.geometry.dispose();
  }

  /** Fit the camera distance to the widest line on screen, headline or subline. */
  function frameContent() {
    if (!mainMesh) return;
    let width = 0;
    for (const mesh of [mainMesh, subMesh]) {
      if (!mesh) continue;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      width = Math.max(width, bb.max.x - bb.min.x);
    }
    const fovRad = (camera.fov * Math.PI) / 180;
    const aspect = camera.aspect || 1;
    const distance = width / 2 / Math.tan(fovRad / 2) / Math.max(aspect, 0.4);
    controls.target.set(0, 10, 0);
    camera.position.set(0, 55, Math.max(260, Math.min(distance * 1.25, 1100)));
    controls.update();
  }

  function setText(headline, subline) {
    const clean = sanitize(headline);
    disposeMesh(mainMesh);
    disposeMesh(subMesh);
    mainMesh = buildMesh(clean.text || '(empty)', 58, mainMaterial, 6, true);
    if (mainMesh) {
      mainMesh.position.y = 20;
      group.add(mainMesh);
    }
    subMesh = buildMesh(sanitize(subline).text, 13, subMaterial, 3, false);
    if (subMesh) {
      subMesh.position.y = -44;
      group.add(subMesh);
    }
    frameContent();
    return clean;
  }

  function resize() {
    const parent = canvas.parentElement;
    const w = Math.max(parent.clientWidth, 120);
    const h = Math.max(parent.clientHeight, 120);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frameContent();
  }

  let raf = 0;
  const clock = new THREE.Clock();
  function loop() {
    raf = requestAnimationFrame(loop);
    const t = clock.getElapsedTime();
    group.rotation.y = Math.sin(t * 0.35) * 0.16;
    group.position.y = Math.sin(t * 0.8) * 4;
    controls.update();
    renderer.render(scene, camera);
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas.parentElement);
  resize();
  loop();

  return {
    setText,
    resize,
    fontError,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
}
