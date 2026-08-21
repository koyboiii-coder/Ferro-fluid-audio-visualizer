import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import {
  spikeFieldGLSL,
  ringPlaneVertexGLSL,
  ringPlaneFragmentGLSL,
  bgHalftoneVertexGLSL,
  bgHalftoneFragmentGLSL,
} from "./shaders.js";
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
  { name: "Nébula", a: "#0a0616", b: "#e6b3ff", glow: "#5ce1ff", bg: "#0b0718" },
  { name: "Cromo puro", a: "#030304", b: "#f2f4f7", glow: "#ffffff", bg: "#050506" },
  { name: "Coral", a: "#140705", b: "#ffab8a", glow: "#ff7a5c", bg: "#170806" },
  { name: "Vino", a: "#0d0207", b: "#d94f7a", glow: "#ff2e63", bg: "#100208" },
  { name: "Malva", a: "#0c070a", b: "#e0b8c9", glow: "#c98aa8", bg: "#0d0709" },
  { name: "Turquesa", a: "#020c0d", b: "#6bf0e0", glow: "#22e0c8", bg: "#030d0e" },
  // Inverted valley/peak: valle (rest state) reads white/pale instead of the
  // usual dark, with peaks/spikes carrying the saturated color instead —
  // still a dark void behind it, so the pale metal itself stays the contrast.
  { name: "Perla", a: "#f5f1ea", b: "#caa15a", glow: "#ffe1a8", bg: "#0d0b08" },
  { name: "Nieve", a: "#f7fbff", b: "#4fc3ff", glow: "#bfe8ff", bg: "#050a10" },
  { name: "Marfil", a: "#f7efe4", b: "#c65a6e", glow: "#ff9db0", bg: "#0d0508" },
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
    vignette: "rgba(60, 70, 90, .12)",
  },
];

// Derives the background aura's two glow colors from a preset's accent
// color: the accent itself (boosted to a consistent saturation/lightness so
// pale accents still read as a glow) plus its complement, so every preset
// automatically gets a harmonious two-tone aura without per-preset tuning.
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function auraPairFromGlow(hex) {
  const [h, s, l] = hexToHsl(hex);
  const auraS = Math.max(s, 0.55);
  const auraL = Math.min(Math.max(l, 0.55), 0.72);
  return [hslToHex(h, auraS, auraL), hslToHex((h + 180) % 360, auraS, auraL)];
}

// Now-playing bar ring colors: derived from the active preset, never
// hardcoded. Outer ring = the preset's peak color (the one that dominates
// the visualizer at spike/peak moments); inner ring = that same hue rotated
// 180° — this app's presets are deliberately analogous (valley/peak/glow all
// close in hue, see PRESETS above), so there's no natural "secondary" color
// to reuse, and a hue rotation is exactly the documented fallback for
// monochromatic presets, guaranteeing the two rings stay visually distinct.
function relativeLuminance(hex) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const r = lin(parseInt(hex.slice(1, 3), 16) / 255);
  const g = lin(parseInt(hex.slice(3, 5), 16) / 255);
  const b = lin(parseInt(hex.slice(5, 7), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function updatePlayerAccent(peakHex, bgHex) {
  const [h, s, l] = hexToHsl(peakHex);

  // Primary (outer ring): the preset's actual peak color, nudged only if it
  // fails the contrast guardrail against the app's own background — some
  // presets (e.g. "Ópalo") use a near-white peak color against a near-white
  // void, which would make the ring nearly invisible otherwise.
  let accentL = l;
  let accentHex = peakHex;
  const bgIsLight = hexToHsl(bgHex)[2] > 0.5;
  let guard = 0;
  while (contrastRatio(accentHex, bgHex) < 3 && guard < 20) {
    accentL = bgIsLight ? Math.max(0, accentL - 0.05) : Math.min(1, accentL + 0.05);
    accentHex = hslToHex(h, s, accentL);
    guard++;
  }

  // Secondary (inner ring): same hue rotated 180°, with a saturation/
  // lightness floor so pale/near-white presets (very low real saturation —
  // most of this app's presets are near-black-or-white at the extremes,
  // see PRESETS above) still read as a genuinely distinct color instead of
  // "180° away" but visually the same off-white. Mirrors auraPairFromGlow's
  // saturation floor above for the same underlying reason.
  const altS = Math.max(s, 0.5);
  const altL = Math.min(Math.max(l, 0.4), 0.7);
  const altHex = hslToHex((h + 180) % 360, altS, altL);

  const root = document.documentElement.style;
  root.setProperty("--player-accent", accentHex);
  root.setProperty("--player-accent-alt", altHex);
}

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
  uSpectrum: { value: new Float32Array(8) },
  uColorA: { value: new THREE.Color(PRESETS[0].a) },
  uColorB: { value: new THREE.Color(PRESETS[0].b) },
  uIrisTint: { value: new THREE.Color(0xffffff) },
};

// Builds a glossy black-metal material whose surface is displaced by the
// given GLSL field (spike cones for the sphere, smooth bulges for the
// ring) — shared so both shapes get identical shading/color behavior and
// only differ in their displacement math.
function createDisplacementMaterial(fieldGLSL, materialUniforms = uniforms) {
  const material = new THREE.MeshPhysicalMaterial({
    metalness: 1.0,
    roughness: 0.12,
    clearcoat: 0.25,
    clearcoatRoughness: 0.35,
    envMapIntensity: 1.0,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, materialUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        ${fieldGLSL}
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
        uniform vec3 uIrisTint;
        uniform float uTime;
        varying float vSpikeHeight;

        // same damped hue ramp as the ring's sheen (green knocked down so the
        // cycle reads red/pink/purple/blue/cyan instead of a sickly yellow-green).
        vec3 irisHue2rgb(float h) {
          vec3 c = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          c.g *= 0.35;
          return c;
        }`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float spikeT = clamp(vSpikeHeight * 2.2, 0.0, 1.0);
        diffuseColor.rgb = mix(uColorA, uColorB, spikeT);`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        // liquid-chrome iris sheen, the sphere's equivalent of the ring's rim
        // highlight: a Fresnel-based glow around the silhouette (view-angle
        // dependent, like a real glass/chrome edge) tinted by uIrisTint and
        // cycling hue, boosted hard wherever the spike field is actively
        // changing (bass hits) — added as emissive so it reads on top
        // regardless of lighting/transmission.
        float irisFresnel = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 3.0);
        float irisActivity = clamp(fwidth(vSpikeHeight) * 40.0, 0.0, 1.0);
        float irisHue = fract(vSpikeHeight * 3.0 - uTime * 0.05);
        vec3 irisColor = uIrisTint * (0.5 + 0.7 * irisHue2rgb(irisHue));
        totalEmissiveRadiance += irisColor * (irisFresnel * 0.35 + irisActivity * 0.6);`
      );
  };

  return material;
}

const sphereGeometry = new THREE.IcosahedronGeometry(1.05, 7);
const sphereMaterial = createDisplacementMaterial(spikeFieldGLSL);
const blobSphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
scene.add(blobSphere);

// Trailing echoes, same idea as the ring's delayed layers: each echo's
// uBass/uTreble chases the one before it at a slower rate (echo 0 chases
// the live signal, echo 2 chases echo 1), so on a hit the spikes don't
// snap back to flat as one block — they peel off into fainter, slightly
// lagging ghosts of the same shape. Colors/freq/sharpness/time are shared
// by reference with the main sphere so an echo only ever differs in how
// "recent" its bass/treble are.
const SPHERE_TRAIL_LAYERS = 3;
const SPHERE_TRAIL_CHASE_RATES = [0.24, 0.14, 0.08];
const SPHERE_TRAIL_OPACITIES = [0.22, 0.13, 0.07];
const sphereEchoUniforms = [];
const blobSphereEchoes = [];
for (let i = 0; i < SPHERE_TRAIL_LAYERS; i++) {
  const echoUniforms = {
    uTime: uniforms.uTime,
    uBass: { value: 0 },
    uMid: uniforms.uMid,
    uTreble: { value: 0 },
    uAmp: uniforms.uAmp,
    uFreq: uniforms.uFreq,
    uSharpness: uniforms.uSharpness,
    uSpectrum: { value: new Float32Array(8) },
    uColorA: uniforms.uColorA,
    uColorB: uniforms.uColorB,
    uIrisTint: uniforms.uIrisTint,
  };
  const echoMaterial = createDisplacementMaterial(spikeFieldGLSL, echoUniforms);
  echoMaterial.transparent = true;
  echoMaterial.opacity = SPHERE_TRAIL_OPACITIES[i];
  echoMaterial.depthWrite = false;
  const echoMesh = new THREE.Mesh(sphereGeometry, echoMaterial);
  echoMesh.visible = false;
  scene.add(echoMesh);
  sphereEchoUniforms.push(echoUniforms);
  blobSphereEchoes.push(echoMesh);
}

// The ring is a flat, camera-facing plane with the shape drawn entirely in
// its fragment shader (see ringPlaneFragmentGLSL) — a static neon-sign-style
// outline, not a lit 3D mesh, per the reference: no rotation/perspective,
// just the outer edge bulging organically, one zone per frequency band.
// Physically larger than it looks: the fragment shader maps its ring shape
// into a smaller fraction of this plane (a 2x expansion) so a max-
// sensitivity bass hit has headroom to bulge outward without clipping
// against the plane's own UV edge.
// Trailing echo: layer 0 tracks the current spectrum directly, and each
// later layer chases the one before it at a slower rate — so on a hit they
// peel apart into a fading trail of increasingly delayed copies instead of
// all moving together.
const RING_TRAIL_LAYERS = 5;
const RING_TRAIL_CHASE_RATES = [1, 0.3, 0.2, 0.13, 0.08];
const ringLayerBands = Array.from({ length: RING_TRAIL_LAYERS }, () => new Float32Array(8));

const ringPlaneGeometry = new THREE.PlaneGeometry(6.4, 6.4);
const ringMaterial = new THREE.ShaderMaterial({
  vertexShader: ringPlaneVertexGLSL,
  fragmentShader: ringPlaneFragmentGLSL,
  transparent: true,
  uniforms: {
    uTime: uniforms.uTime,
    uTreble: uniforms.uTreble,
    uAmp: uniforms.uAmp,
    uSharpness: uniforms.uSharpness,
    uBandsHistory: { value: new Float32Array(RING_TRAIL_LAYERS * 8) },
    uColorA: uniforms.uColorA,
    uColorB: uniforms.uColorB,
    uIrisTint: uniforms.uIrisTint,
  },
});
const blobRing = new THREE.Mesh(ringPlaneGeometry, ringMaterial);
blobRing.visible = false;
scene.add(blobRing);

let activeBlob = blobSphere;

const materialSection = document.getElementById("material-section");

function setShape(mesh) {
  activeBlob = mesh;
  blobSphere.visible = mesh === blobSphere;
  blobRing.visible = mesh === blobRing;
  blobSphereEchoes.forEach((echo) => (echo.visible = mesh === blobSphere));
  materialSection.style.display = mesh === blobSphere ? "" : "none";
}

const shapeSphereBtn = document.getElementById("shape-sphere");
const shapeRingBtn = document.getElementById("shape-ring");
shapeSphereBtn.addEventListener("click", () => {
  setShape(blobSphere);
  shapeSphereBtn.classList.add("is-active");
  shapeRingBtn.classList.remove("is-active");
});
shapeRingBtn.addEventListener("click", () => {
  setShape(blobRing);
  shapeRingBtn.classList.add("is-active");
  shapeSphereBtn.classList.remove("is-active");
});

// "Cristal" swaps the sphere's black-metal material for a transmissive
// glass one — same displaced geometry/shader, just different physical
// params — so the halftone/blur background actually shows refracted
// through it instead of being hidden behind solid black. The trailing
// echo meshes (and their chromatic-aberration/delay trail, and the iris
// sheen) stay visible in glass mode too — those "destellos" are exactly
// what read as liquid-chrome flare against a see-through base.
const materialMetalBtn = document.getElementById("material-metal");
const materialGlassBtn = document.getElementById("material-glass");
let materialStyle = "metal";

function setMaterialStyle(style) {
  materialStyle = style;
  const glass = style === "glass";
  sphereMaterial.metalness = glass ? 0.05 : 1.0;
  sphereMaterial.roughness = glass ? 0.06 : 0.12;
  // physically-based transmission alone reads as almost solid black against
  // this dark studio environment (its refraction highlights get drowned out
  // by Fresnel reflection) — real alpha transparency is what actually makes
  // the background show through and reads as "glass" at a glance. A bit of
  // transmission is layered on top just for the refraction highlight detail.
  sphereMaterial.transmission = glass ? 0.5 : 0.0;
  sphereMaterial.thickness = glass ? 0.6 : 0.0;
  sphereMaterial.ior = glass ? 1.45 : 1.5;
  sphereMaterial.transparent = glass;
  sphereMaterial.opacity = glass ? 0.38 : 1.0;
  sphereMaterial.depthWrite = !glass;
  sphereMaterial.clearcoat = glass ? 0.7 : 0.25;
  sphereMaterial.clearcoatRoughness = glass ? 0.1 : 0.35;
  sphereMaterial.needsUpdate = true;
  materialMetalBtn.classList.toggle("is-active", !glass);
  materialGlassBtn.classList.toggle("is-active", glass);
}
materialMetalBtn.addEventListener("click", () => setMaterialStyle("metal"));
materialGlassBtn.addEventListener("click", () => setMaterialStyle("glass"));

// establish the initial echo/section visibility now that both shape and
// material state exist (the sphere is the default active shape).
setShape(blobSphere);

// Halftone background: a dot-grid version of the old CSS blurred aura,
// rendered in WebGL so dot size can track brightness. Parented to the
// camera (not the scene root) so it always fills the view regardless of
// how OrbitControls orbits — like a skybox. Its own alpha is 0 between
// dots, so the CSS --lc-void/vignette layer behind the transparent canvas
// still provides the base color and corner darkening.
const bgUniforms = {
  uTime: uniforms.uTime,
  uAuraScale: { value: 1 },
  uAuraOpacity: { value: 0.4 },
  uAura1: { value: new THREE.Color(0x8fd0ff) },
  uAura2: { value: new THREE.Color(0xffb98f) },
};
const bgMaterial = new THREE.ShaderMaterial({
  vertexShader: bgHalftoneVertexGLSL,
  fragmentShader: bgHalftoneFragmentGLSL,
  transparent: true,
  depthWrite: false,
  uniforms: bgUniforms,
});
const bgPlane = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), bgMaterial);
bgPlane.position.set(0, 0, -16);
camera.add(bgPlane);
scene.add(camera);

// "Puntos" (WebGL halftone plane) vs "Difuminado" (the original CSS
// blurred-blob aura) — both read the same --lc-aura-1/-2/-scale/-opacity
// reactive values, just render them differently, so only one is ever
// visible/enabled at a time.
const lcAuraEls = document.querySelectorAll(".lc-bg .aura");
const bgDotsBtn = document.getElementById("bg-dots");
const bgBlurBtn = document.getElementById("bg-blur");
let backgroundStyle = "dots";

function setBackgroundStyle(style) {
  backgroundStyle = style;
  bgPlane.visible = style === "dots";
  lcAuraEls.forEach((el) => (el.style.display = style === "blur" ? "" : "none"));
  bgDotsBtn.classList.toggle("is-active", style === "dots");
  bgBlurBtn.classList.toggle("is-active", style === "blur");
}
setBackgroundStyle("dots");
bgDotsBtn.addEventListener("click", () => setBackgroundStyle("dots"));
bgBlurBtn.addEventListener("click", () => setBackgroundStyle("blur"));

// accent light: colored rim/gel light, tinted from the "Acento" color picker —
// the object's main shape reads from the studio envmap above; this just adds
// a subtle wash of color into the reflections, like a gel over one softbox.
const accentLight = new THREE.PointLight(PRESETS[0].glow, 2.2, 14, 2);
accentLight.position.set(-2.5, -1.5, 2.5);
scene.add(accentLight);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.15, 0.3, 0.8);

// UnrealBloomPass's internal blur shader hardcodes its output alpha to 1.0
// for every pixel it touches (three.js keeps this simple because its demos
// always render onto an opaque background). Combined with additive
// blending back onto the scene, that makes the ENTIRE transparent canvas
// increasingly opaque as bloom strength rises — visible here as the
// animated CSS background behind the canvas going dark. Patch the blur
// shader to carry the real (per-pixel) alpha through instead, so bloom
// only affects opacity right around where it actually glows.
bloomPass.separableBlurMaterials.forEach((mat) => {
  mat.fragmentShader = mat.fragmentShader
    .replace(
      "vec3 diffuseSum = texture2D( colorTexture, vUv ).rgb * weightSum;",
      "vec4 diffuseSum = texture2D( colorTexture, vUv ) * weightSum;"
    )
    .replace(
      "vec3 sample1 = texture2D( colorTexture, vUv + uvOffset ).rgb;",
      "vec4 sample1 = texture2D( colorTexture, vUv + uvOffset );"
    )
    .replace(
      "vec3 sample2 = texture2D( colorTexture, vUv - uvOffset ).rgb;",
      "vec4 sample2 = texture2D( colorTexture, vUv - uvOffset );"
    )
    .replace(
      "gl_FragColor = vec4(diffuseSum/weightSum, 1.0);",
      "gl_FragColor = diffuseSum / weightSum;"
    );
  mat.needsUpdate = true;
});

// Default AdditiveBlending uses blendFunc(SRC_ALPHA, ONE) for BOTH the
// color and alpha channels — so now that the blur fix above gives it a
// real (small, localized) alpha instead of a hardcoded 1.0, that same
// alpha was also quietly scaling down the glow's own RGB, making bloom
// barely visible. Split them apart: RGB blends fully additive (unscaled by
// alpha, same brightness as before the fix), alpha still accumulates
// separately so the canvas only gains opacity right where bloom glows.
bloomPass.blendMaterial.blending = THREE.CustomBlending;
bloomPass.blendMaterial.blendEquation = THREE.AddEquation;
bloomPass.blendMaterial.blendSrc = THREE.OneFactor;
bloomPass.blendMaterial.blendDst = THREE.OneFactor;
bloomPass.blendMaterial.blendEquationAlpha = THREE.AddEquation;
bloomPass.blendMaterial.blendSrcAlpha = THREE.OneFactor;
bloomPass.blendMaterial.blendDstAlpha = THREE.OneFactor;

composer.addPass(bloomPass);

// Subtle whole-scene chromatic aberration (radial R/B channel split,
// strongest toward the edges) to match the liquid-chrome/prismatic look —
// alpha is taken from the untouched center sample so the transparent
// background isn't affected by the offset samples.
const chromaticAberrationPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0.0016 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      vec2 offset = dir * uAmount;
      vec4 center = texture2D(tDiffuse, vUv);
      float r = texture2D(tDiffuse, vUv - offset).r;
      float b = texture2D(tDiffuse, vUv + offset).b;
      gl_FragColor = vec4(r, center.g, b, center.a);
    }
  `,
});
composer.addPass(chromaticAberrationPass);
composer.addPass(new OutputPass());

// "Fondo" now drives the liquid-chrome CSS backdrop's base tone (--lc-void)
// instead of the WebGL scene's clear color — the canvas is transparent, so
// that solid color (plus the WebGL halftone aura drawn on top of it) is
// what's actually visible around the object.
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

// Clicking whichever source button is already active turns that source
// fully off (releases the mic/screen-share hardware, pauses the file)
// instead of re-opening its picker — a second press means "stop".
function turnAudioOff() {
  audio.disable();
  btnFile.classList.remove("is-active");
  btnMic.classList.remove("is-active");
  btnSystem.classList.remove("is-active");
  playbackRow.style.display = "none";
  btnPlayPause.textContent = "▶";
  document.body.classList.remove("playing");
}

btnFile.addEventListener("click", () => {
  if (btnFile.classList.contains("is-active")) {
    turnAudioOff();
    return;
  }
  fileInput.click();
});

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

// Android (Capacitor): getUserMedia's own WebView permission round-trip
// doesn't reliably resolve back to the page here, so RECORD_AUDIO is
// requested through this native plugin first — see MainActivity.kt /
// MicPermissionPlugin.kt for why. No-op on web/Electron, where
// getUserMedia's own browser-native permission prompt just works.
const micBridge = window.Capacitor?.Plugins?.MicPermission;

btnMic.addEventListener("click", async () => {
  if (btnMic.classList.contains("is-active")) {
    turnAudioOff();
    return;
  }
  try {
    if (micBridge) {
      const { granted } = await micBridge.requestPermission();
      if (!granted) {
        alert("No se pudo acceder al micrófono: permiso denegado.");
        return;
      }
    }
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
  if (btnSystem.classList.contains("is-active")) {
    turnAudioOff();
    return;
  }
  try {
    await audio.useSystemAudio();
    btnFile.classList.remove("is-active");
    btnMic.classList.remove("is-active");
    btnSystem.classList.add("is-active");
    playbackRow.style.display = "none";
    document.body.classList.add("playing");
  } catch (err) {
    console.error("system audio capture failed", err.name, err.message, err);
    alert(`${err.name || "Error"}: ${err.message || "No se pudo capturar el audio del sistema."}`);
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
const colorIris = document.getElementById("colorIris");

colorA.addEventListener("input", () => uniforms.uColorA.value.set(colorA.value));
colorB.addEventListener("input", () => {
  uniforms.uColorB.value.set(colorB.value);
  updatePlayerAccent(colorB.value, colorBg.value);
});
colorGlow.addEventListener("input", () => accentLight.color.set(colorGlow.value));
colorBg.addEventListener("input", () => {
  setBackground(colorBg.value);
  updatePlayerAccent(colorB.value, colorBg.value);
});
colorIris.addEventListener("input", () => {
  uniforms.uIrisTint.value.set(colorIris.value);
  document.documentElement.style.setProperty("--player-iris", colorIris.value);
});
document.documentElement.style.setProperty("--player-iris", colorIris.value);

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
  sphereMaterial.envMapIntensity = preset.envIntensity ?? 1.0;
  accentLight.intensity = preset.lightBoost ?? 2.2;

  const root = document.documentElement.style;
  const [auraA, auraB] = auraPairFromGlow(preset.glow);
  bgUniforms.uAura1.value.set(auraA);
  bgUniforms.uAura2.value.set(auraB);
  root.setProperty("--lc-aura-1", auraA);
  root.setProperty("--lc-aura-2", auraB);
  if (preset.vignette) root.setProperty("--lc-vignette", preset.vignette);
  else root.removeProperty("--lc-vignette");

  updatePlayerAccent(preset.b, preset.bg);
}

const presetsEl = document.getElementById("presets");
const presetDots = [];
PRESETS.forEach((preset, i) => {
  const dot = document.createElement("button");
  dot.className = "lc-dot";
  dot.type = "button";
  dot.title = preset.name;
  // tinted per preset (peak color as the lit face, glow as the mid
  // reflection, valley as the shaded rim) so the swatches are actually
  // distinguishable instead of thirteen identical chrome balls.
  dot.style.background = `radial-gradient(circle at 35% 30%, ${preset.b}, ${preset.glow} 55%, ${preset.a})`;
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

  // "Vidrio esmerilado": only meaningful inside the real Electron window
  // (a browser tab can't blur the desktop behind it), so this whole section
  // stays hidden outside Electron. Main process does the actual OS-level
  // work (setBackgroundMaterial('acrylic') on Windows 11) — transparency
  // only reliably applies at window-construction time, so toggling this
  // recreates the whole window (see setGlassMode in main.cjs). This fresh
  // page reads its OWN initial state synchronously off electronAPI
  // (populated from this process's own argv in preload.cjs) instead of
  // waiting on any message, since the previous page (and its click handler)
  // is gone along with the window it was destroyed with.
  const glassSection = document.getElementById("window-glass-section");
  const glassToggleBtn = document.getElementById("window-glass-toggle");
  if (glassSection && window.electronAPI.toggleGlass) {
    glassSection.style.display = "";
    if (window.electronAPI.glassModeInitial) {
      document.body.classList.add("glass-window");
      glassToggleBtn.classList.add("is-active");
    }
    glassToggleBtn.addEventListener("click", () => window.electronAPI.toggleGlass());
  }
}

// ---------- Android (Capacitor) mode ----------
if (window.Capacitor?.getPlatform?.() === "android") {
  document.body.classList.add("android-app");

  // The panel defaults to open, which makes sense with a desktop window's
  // spare width — on a phone screen it covers the whole visualizer, so
  // start collapsed instead.
  panel.classList.add("hidden");

  // getDisplayMedia (audio.js's useSystemAudio) is a desktop-only browser
  // API — there is no Android equivalent, so "Sistema" can't work here.
  const systemBtn = document.getElementById("btn-system");
  if (systemBtn) systemBtn.remove();
  const systemHint = document.querySelector(".hint");
  if (systemHint) systemHint.remove();

  const nowPlaying = window.Capacitor.Plugins.NowPlaying;
  const banner = document.getElementById("notif-access-banner");
  const notifBtn = document.getElementById("notif-access-btn");

  async function refreshNotifAccessBanner() {
    const { granted } = await nowPlaying.checkNotificationAccess();
    banner.hidden = granted;
  }
  notifBtn.addEventListener("click", () => nowPlaying.requestNotificationAccess());
  // requestNotificationAccess() just opens Settings — there's no grant
  // callback, so the banner re-checks whenever the app comes back to the
  // foreground (e.g. the user returning from that Settings screen).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshNotifAccessBanner();
  });
  refreshNotifAccessBanner();
}

// Now-playing bar ("Doble anillo" — design handoff variant 2a): fed by
  // whichever platform bridge is available — Electron polls Windows' SMTC,
  // Android's NowPlayingPlugin reads MediaSessionManager (see
  // NowPlayingListenerService.kt) — normalized to the same shape here so
  // the rest of this block (ring drag math, marquee, transport buttons)
  // doesn't need to know which platform it's on. The bar stays out of the
  // DOM's visible flow entirely until a session is actually detected, and
  // disappears again the moment it isn't.
  const mediaBridge = window.electronAPI?.media
    ? window.electronAPI.media
    : window.Capacitor?.Plugins?.NowPlaying
    ? {
        onUpdate: (cb) => {
          const plugin = window.Capacitor.Plugins.NowPlaying;
          // addListener() is async (returns Promise<PluginListenerHandle>),
          // unlike Electron's synchronous ipcRenderer.on/removeListener.
          const handlePromise = plugin.addListener("nowPlayingUpdate", cb);
          plugin.getCurrentState().then(cb);
          return () => handlePromise.then((handle) => handle.remove());
        },
        play: () => window.Capacitor.Plugins.NowPlaying.play(),
        pause: () => window.Capacitor.Plugins.NowPlaying.pause(),
        next: () => window.Capacitor.Plugins.NowPlaying.next(),
        previous: () => window.Capacitor.Plugins.NowPlaying.previous(),
        setVolume: (level) => window.Capacitor.Plugins.NowPlaying.setVolume({ level }),
      }
    : null;

  if (mediaBridge) {
    const mediaBar = document.getElementById("media-bar");
    const mbArtist = document.getElementById("mb-artist");
    const mbSource = document.getElementById("mb-source");
    const mediaTitleWrap = document.getElementById("media-title-wrap");
    const mediaTitle = document.getElementById("media-title");
    const mbElapsed = document.getElementById("mb-elapsed");
    const mbRemaining = document.getElementById("mb-remaining");
    const ringOuter = document.getElementById("mb-ring-outer");
    const ringInner = document.getElementById("mb-ring-inner");
    const ringsEl = document.getElementById("mb-rings");
    const playPauseBtn = document.getElementById("media-playpause");
    let lastTitle = null;

    // Real system master volume (not SMTC — it has no volume API, only
    // transport controls + metadata; see electron/media-session.cjs's Core
    // Audio / IAudioEndpointVolume bridge). Stays null (ring at rest) until
    // the first real reading arrives, and is optimistically updated locally
    // on drag/keyboard before the IPC round-trip to main.cjs confirms it.
    let volume = null;
    let draggingVolume = false;

    function renderVolume(level) {
      volume = Math.max(0, Math.min(1, level));
      // Set on #mb-rings (a shared ancestor of both the ring and the
      // thumb dot below it), not ringInner directly — the property is
      // declared inheriting, so one write here reaches both.
      ringsEl.style.setProperty("--mb-volume-deg", `${volume * 360}deg`);
      ringsEl.setAttribute("aria-valuenow", String(Math.round(volume * 100)));
    }

    // Coalesced on the renderer side too (not just in main.cjs): a fast
    // drag fires many pointermove events, and only the trailing value
    // actually needs to reach Spotify.
    let volumeSendTimer = null;
    function scheduleSetVolume(level) {
      clearTimeout(volumeSendTimer);
      volumeSendTimer = setTimeout(() => mediaBridge.setVolume(level), 100);
    }
    function flushSetVolume(level) {
      clearTimeout(volumeSendTimer);
      mediaBridge.setVolume(level);
    }

    function angleFromPointer(clientX, clientY, rect) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Ring starts at 12 o'clock and advances clockwise (matches the
      // conic-gradient's `from 0deg`) — atan2 measures from 3 o'clock, so
      // +90° aligns them.
      let deg = Math.atan2(clientY - cy, clientX - cx) * (180 / Math.PI) + 90;
      if (deg < 0) deg += 360;
      return deg; // 0-360
    }

    // Tracked as an *unwrapped* cumulative angle during a drag (can go
    // below 0 or above 360) rather than recomputing a fresh 0-360 angle
    // each move — the latter made the volume snap back to 0% the moment a
    // continued drag crossed back over the 12-o'clock seam, instead of
    // just maxing out at 100% like a real knob.
    let dragLastAngle = 0;
    let dragCumulativeDeg = 0;

    ringsEl.addEventListener("pointerdown", (e) => {
      const rect = ringsEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      // A generous inner radius is left untouched for the play button
      // (~35px+ at the default 132px ring size), so a plain click there
      // still just toggles playback instead of starting a volume drag.
      if (dist < rect.width * 0.27) return;
      draggingVolume = true;
      ringsEl.setPointerCapture(e.pointerId);
      const angle = angleFromPointer(e.clientX, e.clientY, rect);
      dragLastAngle = angle;
      dragCumulativeDeg = angle;
      const level = Math.max(0, Math.min(360, dragCumulativeDeg)) / 360;
      renderVolume(level);
      scheduleSetVolume(level);
      e.preventDefault();
    });

    ringsEl.addEventListener("pointermove", (e) => {
      if (!draggingVolume) return;
      const angle = angleFromPointer(e.clientX, e.clientY, ringsEl.getBoundingClientRect());
      let delta = angle - dragLastAngle;
      if (delta > 180) delta -= 360; // crossed the seam counter-clockwise
      if (delta < -180) delta += 360; // crossed the seam clockwise
      dragCumulativeDeg += delta;
      dragLastAngle = angle;
      const level = Math.max(0, Math.min(360, dragCumulativeDeg)) / 360;
      renderVolume(level);
      scheduleSetVolume(level);
    });

    function endVolumeDrag() {
      if (!draggingVolume) return;
      draggingVolume = false;
      if (volume != null) flushSetVolume(volume);
    }
    ringsEl.addEventListener("pointerup", endVolumeDrag);
    ringsEl.addEventListener("pointercancel", endVolumeDrag);

    // Keyboard equivalent (README a11y note: arrow keys as a substitute for
    // the drag interaction) — ↑/→ raise, ↓/← lower, in 5% steps.
    ringsEl.tabIndex = 0;
    ringsEl.setAttribute("role", "slider");
    ringsEl.setAttribute("aria-label", "Volumen");
    ringsEl.setAttribute("aria-valuemin", "0");
    ringsEl.setAttribute("aria-valuemax", "100");
    ringsEl.addEventListener("keydown", (e) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      const delta = e.key === "ArrowUp" || e.key === "ArrowRight" ? 0.05 : -0.05;
      const level = Math.max(0, Math.min(1, (volume ?? 0) + delta));
      renderVolume(level);
      flushSetVolume(level);
    });

    // Letrero-LED marquee: only scrolls a title that actually doesn't fit
    // its lane — measured after the real text is in the DOM, since that's
    // the only reliable way to know if it overflows.
    function updateMarquee(wrapEl, textEl, text) {
      wrapEl.classList.remove("marquee-active");
      textEl.style.removeProperty("--marquee-distance");
      textEl.style.removeProperty("--marquee-duration");
      textEl.textContent = text;
      void textEl.offsetWidth; // force reflow so a restarted animation begins at 0%
      const overflow = textEl.scrollWidth - wrapEl.clientWidth;
      if (overflow > 2) {
        textEl.style.setProperty("--marquee-distance", `-${overflow}px`);
        textEl.style.setProperty("--marquee-duration", `${Math.max(5, overflow / 25)}s`);
        wrapEl.classList.add("marquee-active");
      }
    }

    function formatTime(totalSeconds) {
      const s = Math.max(0, Math.floor(totalSeconds));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }

    // Progress state + rAF loop: SMTC only reports a position/timestamp
    // snapshot every poll (~2s), not a continuous feed. The ring is driven
    // by real elapsed wall-clock time since that snapshot (position +
    // (now - lastUpdated) while playing) via requestAnimationFrame, rather
    // than a separate setInterval counting its own seconds — that would
    // drift out of sync with Spotify's actual position over time.
    let media = { active: false, status: "Paused", position: 0, duration: 0, lastUpdated: Date.now() };
    let rafId = null;
    let lastRenderedSecond = -1;

    function currentPosition() {
      if (media.status !== "Playing") return media.position;
      const elapsed = (Date.now() - media.lastUpdated) / 1000;
      return Math.min(media.duration, media.position + Math.max(0, elapsed));
    }

    function renderProgress() {
      const pos = currentPosition();
      const duration = media.duration || 1;
      const deg = Math.min(360, (pos / duration) * 360);
      ringOuter.style.setProperty("--mb-progress-deg", `${deg}deg`);

      const second = Math.floor(pos);
      if (second !== lastRenderedSecond) {
        lastRenderedSecond = second;
        mbElapsed.textContent = formatTime(pos);
        mbRemaining.textContent = `-${formatTime(media.duration - pos)}`;
      }

      rafId = media.active && media.status === "Playing" ? requestAnimationFrame(renderProgress) : null;
    }

    function startProgressLoop() {
      if (rafId == null) rafId = requestAnimationFrame(renderProgress);
    }

    mediaBridge.onUpdate((state) => {
      mediaBar.classList.toggle("visible", !!state.active);
      if (!state.active) return;

      const title = state.title || "";
      if (title !== lastTitle) {
        updateMarquee(mediaTitleWrap, mediaTitle, title);
        lastTitle = title;
      }
      mbArtist.textContent = state.artist || "";
      mbSource.textContent = state.source ? `Desde ${state.source}` : "";

      // Skip while the user's own drag is in progress — an incoming poll
      // (esp. the slow ~15s resync) would otherwise yank the ring away
      // from their pointer mid-gesture.
      if (typeof state.volume === "number" && !draggingVolume) {
        renderVolume(state.volume);
      }

      media = {
        active: true,
        status: state.status,
        position: state.position || 0,
        duration: state.duration || 0,
        lastUpdated: state.lastUpdated || Date.now(),
      };
      playPauseBtn.classList.toggle("is-playing", media.status === "Playing");
      renderProgress();
      if (media.status === "Playing") startProgressLoop();
    });

    playPauseBtn.addEventListener("click", () => {
      (media.status === "Playing" ? mediaBridge.pause : mediaBridge.play)();
    });
    document.getElementById("media-prev").addEventListener("click", () => mediaBridge.previous());
    document.getElementById("media-next").addEventListener("click", () => mediaBridge.next());
  }

// ---------- animation loop ----------
const clock = new THREE.Clock();

// Rotation has real inertia: bass hits add angular acceleration instead of
// snapping the spin speed to the current audio level, and it relaxes back
// toward a slow baseline when the bass drops — so it feels "spun up" by the
// music rather than just following it 1:1.
let angularVelocity = 0.25;

// Background aura level: fast attack (snaps up quickly on a bass hit) but a
// slow release (fades back down gently), so the glow pulses with the beat
// instead of flickering or drifting on its own when idle.
let bgAuraLevel = 0;

function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();
  const elapsed = clock.elapsedTime;

  const bands = audio.update();
  uniforms.uTime.value = elapsed;
  uniforms.uBass.value = bands.bass;
  uniforms.uMid.value = bands.mid;
  uniforms.uTreble.value = bands.treble;
  uniforms.uSpectrum.value.set(audio.spectrum);

  ringLayerBands[0].set(audio.spectrum);
  for (let h = 1; h < RING_TRAIL_LAYERS; h++) {
    const rate = RING_TRAIL_CHASE_RATES[h];
    const layer = ringLayerBands[h];
    const chasing = ringLayerBands[h - 1];
    for (let i = 0; i < layer.length; i++) layer[i] += (chasing[i] - layer[i]) * rate;
  }
  const historyUniform = ringMaterial.uniforms.uBandsHistory.value;
  for (let h = 0; h < RING_TRAIL_LAYERS; h++) historyUniform.set(ringLayerBands[h], h * 8);

  // rotation speeds up with bass hits, with real inertia: acceleration from
  // the kick builds up angular velocity, which relaxes back to baseline
  // instead of snapping directly to the current audio level.
  const rSpeed = parseFloat(rotationSpeed.value);
  const bassKick = bands.bass * uniforms.uAmp.value;
  const baseline = 0.25 + bands.overall * 0.4;
  angularVelocity += bassKick * 5.5 * dt;
  angularVelocity += (baseline - angularVelocity) * dt;
  angularVelocity = THREE.MathUtils.clamp(angularVelocity, 0, 12);

  // the ring is a flat, camera-facing "neon sign" by design (see
  // ringPlaneFragmentGLSL) — it stays static instead of tumbling in 3D,
  // only the sphere spins.
  if (activeBlob === blobSphere) {
    activeBlob.rotation.y += dt * rSpeed * angularVelocity;
    activeBlob.rotation.x += dt * rSpeed * angularVelocity * 0.15;
  } else {
    activeBlob.quaternion.copy(camera.quaternion);
  }

  const targetScale = 1 + bands.overall * 0.05;
  activeBlob.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.15);

  chromaticAberrationPass.uniforms.uAmount.value = 0.0016 + bands.overall * uniforms.uAmp.value * 0.003;

  if (activeBlob === blobSphere) {
    let chaseBass = bands.bass;
    let chaseTreble = bands.treble;
    let chaseSpectrum = audio.spectrum;
    for (let i = 0; i < SPHERE_TRAIL_LAYERS; i++) {
      const rate = SPHERE_TRAIL_CHASE_RATES[i];
      const eu = sphereEchoUniforms[i];
      eu.uBass.value += (chaseBass - eu.uBass.value) * rate;
      eu.uTreble.value += (chaseTreble - eu.uTreble.value) * rate;
      const spec = eu.uSpectrum.value;
      for (let j = 0; j < spec.length; j++) spec[j] += (chaseSpectrum[j] - spec[j]) * rate;
      chaseBass = eu.uBass.value;
      chaseTreble = eu.uTreble.value;
      chaseSpectrum = spec;

      const echo = blobSphereEchoes[i];
      echo.rotation.copy(blobSphere.rotation);
      echo.scale.copy(blobSphere.scale);
    }
  }

  // background aura: pulses scale/brightness with bass, never its own
  // animation timing (retiming CSS animations on the fly is what made the
  // old flowing background feel jerky/dizzying).
  const bassNow = bands.bass * uniforms.uAmp.value;
  bgAuraLevel += (bassNow - bgAuraLevel) * (bassNow > bgAuraLevel ? 0.35 : 0.05);
  const pulse = parseFloat(bgFlowSlider.value);
  const auraScale = THREE.MathUtils.clamp(1 + bgAuraLevel * 0.09 * pulse, 1, 1.4);
  const auraOpacity = THREE.MathUtils.clamp(0.32 + bgAuraLevel * 0.14 * pulse, 0.12, 0.85);
  bgUniforms.uAuraScale.value = auraScale;
  bgUniforms.uAuraOpacity.value = auraOpacity;
  if (backgroundStyle === "blur") {
    document.documentElement.style.setProperty("--lc-aura-scale", auraScale.toFixed(3));
    document.documentElement.style.setProperty("--lc-aura-opacity", auraOpacity.toFixed(3));
  }

  controls.update();
  composer.render();
}

animate();
