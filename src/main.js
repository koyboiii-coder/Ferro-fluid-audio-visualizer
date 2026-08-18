import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { spikeFieldGLSL } from "./shaders.js";
import { AudioEngine } from "./audio.js";
import "./styles/liquid-chrome.css";

// Each palette keeps valley/peak/glow analogous (neighboring hues) so the
// metal reads as one coherent material instead of clashing colors. "bg" is
// always dark now — it feeds --lc-void, the liquid-chrome backdrop's base
// tone, which per the design system is never a pale/bright color.
const PRESETS = [
  { name: "Ferrofluido", a: "#050506", b: "#e3e9f0", glow: "#8fd0ff", bg: "#0a0b0e" },
  { name: "Oro líquido", a: "#160f05", b: "#ffd27a", glow: "#fff2c8", bg: "#12100a" },
  { name: "Mercurio azul", a: "#03050a", b: "#a9c9ff", glow: "#4fd8ff", bg: "#05070d" },
  { name: "Sangre", a: "#050202", b: "#ff5a4d", glow: "#ff9d6e", bg: "#0a0303" },
  { name: "Ácido", a: "#04120a", b: "#baff3d", glow: "#eaff00", bg: "#060b06" },
  { name: "Rosa neón", a: "#0a0210", b: "#ff6ec7", glow: "#c86bff", bg: "#0a0210" },
  { name: "Esmeralda", a: "#020a08", b: "#7dffd4", glow: "#00ffb3", bg: "#03110b" },
  { name: "Amatista", a: "#0a0512", b: "#c9a6ff", glow: "#8a4fff", bg: "#0b0614" },
  { name: "Cobre", a: "#150a04", b: "#ffb37a", glow: "#ff7a3d", bg: "#170b05" },
  { name: "Océano", a: "#020a0d", b: "#5fd8e8", glow: "#0ea5c4", bg: "#020b0e" },
  { name: "Grafito", a: "#020202", b: "#cfcfd4", glow: "#9aa0aa", bg: "#08080a" },
  { name: "Fuego", a: "#0d0300", b: "#ffb02e", glow: "#ff4d00", bg: "#120800" },
  // Bright glass/opal look with a pale void — the one deliberate exception
  // to "the void is always dark", requested to match a specific reference.
  // envIntensity/lightBoost push the reflections way up so it reads as
  // bright glass instead of black metal with a light tint.
  {
    name: "Ópalo",
    a: "#d6dee6",
    b: "#ffffff",
    glow: "#bcd6ff",
    bg: "#eef1f5",
    brightEnv: true,
    envIntensity: 1.6,
    lightBoost: 3.5,
    blobs: ["#c7cdd6", "#dadfe6", "#f4f6f9", "#e3e7ec"],
    vignette: "rgba(60, 70, 90, .12)",
  },
];

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// scene.background stays unset (transparent) on purpose: the animated
// liquid-chrome CSS backdrop (.lc-bg) shows through around the object.
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 5.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = 10;

// Studio-style environment: a black void with a few bright "softbox" panels.
// A mostly-dark environment is what makes a glossy metal read as BLACK, with
// only a few crisp bright streaks reflected on it — the actual look of the
// reference photo. (Point-lights bouncing off black walls barely register —
// self-lit panels give predictable, well-shaped highlight reflections instead.)
function createStudioEnvironment() {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x000000);

  function softbox(width, height, color, intensity, position, rotation) {
    const geo = new THREE.PlaneGeometry(width, height);
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    mat.color.multiplyScalar(intensity);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    mesh.rotation.copy(rotation);
    env.add(mesh);
  }

  softbox(10, 6, 0xffffff, 3.2, new THREE.Vector3(0, 6, 4), new THREE.Euler(-Math.PI / 3, 0, 0));
  softbox(6, 10, 0xdcecff, 2.0, new THREE.Vector3(-8, 1, 3), new THREE.Euler(0, Math.PI / 2.3, 0));
  softbox(5, 5, 0xffffff, 1.3, new THREE.Vector3(7, -3, -4), new THREE.Euler(0, -Math.PI / 2.5, 0));

  return env;
}

// Bright-glass environment for presets like "Ópalo": a light grey fill (no
// black gaps) plus several large soft panels, so metal reads as pale glass
// with hot highlights instead of black metal with light streaks.
function createBrightEnvironment() {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0xd7dbe2);

  function softbox(width, height, color, intensity, position, rotation) {
    const geo = new THREE.PlaneGeometry(width, height);
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    mat.color.multiplyScalar(intensity);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    mesh.rotation.copy(rotation);
    env.add(mesh);
  }

  softbox(14, 10, 0xffffff, 4.5, new THREE.Vector3(0, 8, 5), new THREE.Euler(-Math.PI / 3, 0, 0));
  softbox(10, 14, 0xffffff, 3.2, new THREE.Vector3(-10, 0, 4), new THREE.Euler(0, Math.PI / 2.2, 0));
  softbox(10, 14, 0xeaf2ff, 3.0, new THREE.Vector3(10, -2, -3), new THREE.Euler(0, -Math.PI / 2.2, 0));
  softbox(8, 8, 0xffffff, 2.4, new THREE.Vector3(0, -8, -5), new THREE.Euler(Math.PI / 2.6, 0, 0));

  return env;
}

const pmremGenerator = new THREE.PMREMGenerator(renderer);
const studioEnvRT = pmremGenerator.fromScene(createStudioEnvironment(), 0.04);
const brightEnvRT = pmremGenerator.fromScene(createBrightEnvironment(), 0.04);
scene.environment = studioEnvRT.texture;
pmremGenerator.dispose();

const uniforms = {
  uTime: { value: 0 },
  uBass: { value: 0 },
  uMid: { value: 0 },
  uTreble: { value: 0 },
  uAmp: { value: 1.0 },
  uFreq: { value: 7.5 },
  uSharpness: { value: 1.6 },
  uColorA: { value: new THREE.Color(PRESETS[0].a) },
  uColorB: { value: new THREE.Color(PRESETS[0].b) },
};

const geometry = new THREE.IcosahedronGeometry(1.05, 7);

const material = new THREE.MeshPhysicalMaterial({
  metalness: 1.0,
  roughness: 0.12,
  clearcoat: 0.25,
  clearcoatRoughness: 0.35,
  envMapIntensity: 1.0,
});

material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms);

  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
      ${spikeFieldGLSL}
      varying float vSpikeHeight;`
    )
    .replace(
      "#include <beginnormal_vertex>",
      `vec3 objectNormal = vec3( normal );
      #ifdef USE_TANGENT
      vec3 objectTangent = vec3( tangent.xyz );
      #endif

      vec3 n0 = normalize(normal);
      float baseDisp = calcDisplacement(position);
      vec3 dispPosition = position + n0 * baseDisp;
      vSpikeHeight = baseDisp;

      vec3 tangentA = normalize(abs(n0.y) < 0.99 ? cross(n0, vec3(0.0, 1.0, 0.0)) : cross(n0, vec3(1.0, 0.0, 0.0)));
      vec3 tangentB = normalize(cross(n0, tangentA));
      float epsN = 0.03;
      vec3 pTA = position + tangentA * epsN;
      vec3 pTB = position + tangentB * epsN;
      vec3 dTA = pTA + n0 * calcDisplacement(pTA);
      vec3 dTB = pTB + n0 * calcDisplacement(pTB);
      vec3 newNormal = normalize(cross(dTA - dispPosition, dTB - dispPosition));
      if (dot(newNormal, n0) < 0.0) newNormal = -newNormal;
      objectNormal = newNormal;`
    )
    .replace(
      "#include <begin_vertex>",
      `vec3 transformed = dispPosition;
      #ifdef USE_ALPHAHASH
      vPosition = vec3( position );
      #endif`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying float vSpikeHeight;`
    )
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      float spikeT = clamp(vSpikeHeight * 2.2, 0.0, 1.0);
      diffuseColor.rgb = mix(uColorA, uColorB, spikeT);`
    );
};

const blob = new THREE.Mesh(geometry, material);
scene.add(blob);

// accent light: colored rim/gel light, tinted from the "Acento" color picker —
// the object's main shape reads from the studio envmap above; this just adds
// a subtle wash of color into the reflections, like a gel over one softbox.
const accentLight = new THREE.PointLight(PRESETS[0].glow, 2.2, 14, 2);
accentLight.position.set(-2.5, -1.5, 2.5);
scene.add(accentLight);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.15, 0.3, 0.8);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// "Fondo" now drives the liquid-chrome CSS backdrop's base tone (--lc-void)
// instead of the WebGL scene's clear color — the canvas is transparent, so
// that animated backdrop is what's actually visible around the object.
const lcBg = document.querySelector(".lc-bg");
const lcIris = lcBg.querySelector(".iris");

function setBackground(hex) {
  document.documentElement.style.setProperty("--lc-void", hex);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Audio ----------
const audio = new AudioEngine();

const fileInput = document.getElementById("file-input");
const btnFile = document.getElementById("btn-file");
const btnMic = document.getElementById("btn-mic");
const btnSystem = document.getElementById("btn-system");
const btnPlayPause = document.getElementById("btn-playpause");
const playbackRow = document.getElementById("playback-row");
const trackName = document.getElementById("track-name");

btnFile.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (file) await handleAudioFile(file);
});

async function handleAudioFile(file) {
  await audio.loadFile(file);
  btnMic.classList.remove("is-active");
  btnSystem.classList.remove("is-active");
  btnFile.classList.add("is-active");
  trackName.textContent = file.name;
  playbackRow.style.display = "flex";
  btnPlayPause.textContent = "⏸";
  document.body.classList.add("playing");
}

btnMic.addEventListener("click", async () => {
  try {
    await audio.useMicrophone();
    btnFile.classList.remove("is-active");
    btnSystem.classList.remove("is-active");
    btnMic.classList.add("is-active");
    playbackRow.style.display = "none";
    document.body.classList.add("playing");
  } catch (err) {
    alert("No se pudo acceder al micrófono: " + err.message);
  }
});

btnSystem.addEventListener("click", async () => {
  try {
    await audio.useSystemAudio();
    btnFile.classList.remove("is-active");
    btnMic.classList.remove("is-active");
    btnSystem.classList.add("is-active");
    playbackRow.style.display = "none";
    document.body.classList.add("playing");
  } catch (err) {
    alert(err.message || "No se pudo capturar el audio del sistema.");
  }
});

btnPlayPause.addEventListener("click", () => {
  const playing = audio.togglePlayback();
  btnPlayPause.textContent = playing ? "⏸" : "▶";
});

["dragenter", "dragover"].forEach((evt) =>
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((evt) =>
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
  })
);
window.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && file.type.startsWith("audio/")) {
    await handleAudioFile(file);
  }
});

// ---------- UI: colors ----------
const colorA = document.getElementById("colorA");
const colorB = document.getElementById("colorB");
const colorGlow = document.getElementById("colorGlow");
const colorBg = document.getElementById("colorBg");

colorA.addEventListener("input", () => uniforms.uColorA.value.set(colorA.value));
colorB.addEventListener("input", () => uniforms.uColorB.value.set(colorB.value));
colorGlow.addEventListener("input", () => accentLight.color.set(colorGlow.value));
colorBg.addEventListener("input", () => setBackground(colorBg.value));

function applyPreset(preset) {
  colorA.value = preset.a;
  colorB.value = preset.b;
  colorGlow.value = preset.glow;
  colorBg.value = preset.bg;
  uniforms.uColorA.value.set(preset.a);
  uniforms.uColorB.value.set(preset.b);
  accentLight.color.set(preset.glow);
  setBackground(preset.bg);
  // most presets read as black metal (the dark studio env dominates); a
  // light valley/peak alone won't brighten that — presets can opt into the
  // bright environment + stronger reflection so the object actually reads
  // as pale glass instead of black metal with a light tint.
  scene.environment = preset.brightEnv ? brightEnvRT.texture : studioEnvRT.texture;
  material.envMapIntensity = preset.envIntensity ?? 1.0;
  accentLight.intensity = preset.lightBoost ?? 2.2;

  // most presets keep the shared dark blob palette; a preset can override
  // it (and the corner vignette) to match a much brighter backdrop.
  const root = document.documentElement.style;
  const blobVars = ["--lc-blob-dark", "--lc-blob-mid", "--lc-blob-light", "--lc-blob-falloff"];
  if (preset.blobs) {
    blobVars.forEach((v, i) => root.setProperty(v, preset.blobs[i]));
    root.setProperty("--lc-vignette", preset.vignette ?? "rgba(0, 0, 0, .55)");
  } else {
    blobVars.forEach((v) => root.removeProperty(v));
    root.removeProperty("--lc-vignette");
  }
}

const presetsEl = document.getElementById("presets");
const presetDots = [];
PRESETS.forEach((preset, i) => {
  const dot = document.createElement("button");
  dot.className = "lc-dot";
  dot.type = "button";
  dot.title = preset.name;
  dot.addEventListener("click", () => {
    applyPreset(preset);
    presetDots.forEach((d) => d.classList.remove("is-active"));
    dot.classList.add("is-active");
  });
  presetDots.push(dot);
  presetsEl.appendChild(dot);
});

applyPreset(PRESETS[0]);
presetDots[0].classList.add("is-active");

// ---------- UI: sliders ----------
const sensitivity = document.getElementById("sensitivity");
const smoothing = document.getElementById("smoothing");
const density = document.getElementById("complexity");
const sharpness = document.getElementById("sharpness");
const rotationSpeed = document.getElementById("rotationSpeed");
const bloomSlider = document.getElementById("bloom");
const bgFlowSlider = document.getElementById("bgFlow");

sensitivity.addEventListener("input", () => (uniforms.uAmp.value = parseFloat(sensitivity.value)));
smoothing.addEventListener("input", () => (audio.smoothing = parseFloat(smoothing.value)));
density.addEventListener("input", () => (uniforms.uFreq.value = parseFloat(density.value)));
sharpness.addEventListener("input", () => (uniforms.uSharpness.value = parseFloat(sharpness.value)));
bloomSlider.addEventListener("input", () => (bloomPass.strength = parseFloat(bloomSlider.value)));

uniforms.uAmp.value = parseFloat(sensitivity.value);
audio.smoothing = parseFloat(smoothing.value);
uniforms.uFreq.value = parseFloat(density.value);
uniforms.uSharpness.value = parseFloat(sharpness.value);
bloomPass.strength = parseFloat(bloomSlider.value);

// liquid-chrome sliders fill their track via background-size, set from JS
function updateSliderFill(input) {
  const min = parseFloat(input.min) || 0;
  const max = parseFloat(input.max) || 100;
  const pct = ((parseFloat(input.value) - min) / (max - min)) * 100;
  input.style.backgroundSize = `${pct}% 100%`;
}
document.querySelectorAll(".lc-slider").forEach((el) => {
  updateSliderFill(el);
  el.addEventListener("input", () => updateSliderFill(el));
});

// ---------- panel toggle ----------
const panel = document.getElementById("panel-wrap");
document.getElementById("panel-toggle").addEventListener("click", () => panel.classList.toggle("hidden"));

// ---------- Electron desktop-widget mode ----------
if (window.electronAPI?.isElectron) {
  document.body.classList.add("electron-app");

  const systemHint = document.querySelector(".hint");
  if (systemHint) {
    systemHint.textContent = '"Sistema" captura el audio de tu PC automáticamente, sin diálogos.';
  }
  const systemTitle = document.getElementById("btn-system");
  if (systemTitle) systemTitle.removeAttribute("title");

  document.getElementById("tb-close").addEventListener("click", () => window.electronAPI.closeWindow());
  document.getElementById("tb-min").addEventListener("click", () => window.electronAPI.minimizeWindow());

  const pinBtn = document.getElementById("tb-pin");
  pinBtn.classList.add("pinned"); // window starts always-on-top
  pinBtn.addEventListener("click", async () => {
    const pinned = await window.electronAPI.toggleAlwaysOnTop();
    pinBtn.classList.toggle("pinned", pinned);
  });
}

// ---------- animation loop ----------
const clock = new THREE.Clock();

// Rotation has real inertia: bass hits add angular acceleration instead of
// snapping the spin speed to the current audio level, and it relaxes back
// toward a slow baseline when the bass drops — so it feels "spun up" by the
// music rather than just following it 1:1.
let angularVelocity = 0.25;

// A separate, slower-lerped bass value just for the background — using the
// same fast-attack bass that drives the spikes would make the chrome flow
// flicker/shake (per the design spec, §8).
let bgBassSmoothed = 0;

function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();
  const elapsed = clock.elapsedTime;

  const bands = audio.update();
  uniforms.uTime.value = elapsed;
  uniforms.uBass.value = bands.bass;
  uniforms.uMid.value = bands.mid;
  uniforms.uTreble.value = bands.treble;

  // rotation speeds up with bass hits, with real inertia: acceleration from
  // the kick builds up angular velocity, which relaxes back to baseline
  // instead of snapping directly to the current audio level.
  const rSpeed = parseFloat(rotationSpeed.value);
  const bassKick = bands.bass * uniforms.uAmp.value;
  const baseline = 0.25 + bands.overall * 0.4;
  angularVelocity += bassKick * 5.5 * dt;
  angularVelocity += (baseline - angularVelocity) * dt;
  angularVelocity = THREE.MathUtils.clamp(angularVelocity, 0, 12);

  blob.rotation.y += dt * rSpeed * angularVelocity;
  blob.rotation.x += dt * rSpeed * angularVelocity * 0.15;

  const targetScale = 1 + bands.overall * 0.05;
  blob.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.15);

  // liquid-chrome backdrop: bass accelerates the flow and intensifies the
  // iridescent sheen, smoothed separately so it drifts instead of shaking.
  bgBassSmoothed += (bands.bass - bgBassSmoothed) * 0.1;
  const flowCeiling = parseFloat(bgFlowSlider.value);
  lcBg.style.setProperty("--lc-flow", 1 + bgBassSmoothed * flowCeiling);
  lcIris.style.opacity = 0.35 + bgBassSmoothed * 0.45;

  controls.update();
  composer.render();
}

animate();
