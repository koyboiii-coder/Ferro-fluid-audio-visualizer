// Jittered-grid 3D Worley (cellular) noise. Using the F1 distance directly as a
// height field produces cone/spike shapes centered on each cell's feature point —
// exactly the pointed-spike geometry a real ferrofluid forms under a magnetic field,
// unlike smooth simplex/Perlin noise which only gives rounded hills.
export const spikeFieldGLSL = /* glsl */ `
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uAmp;
  uniform float uFreq;
  uniform float uSharpness;
  // 8 frequency bands (bass -> treble, see AudioEngine.spectrum), same data
  // the ring's circular equalizer uses. Mapped onto longitude around the Y
  // axis so different wedges of the sphere bulge for different tones,
  // instead of the whole surface swelling together on one global uBass.
  uniform float uSpectrum[8];

  #define SPK_NUM_BANDS 8
  #define SPK_TAU 6.28318530718
  #define SPK_PI 3.14159265359

  // smooth (cosine) angular falloff around a band's center, wide enough to
  // overlap its neighbors so zones blend into each other rather than
  // showing a hard seam where one band's dominance ends.
  float spkBandWeight(float angle, int i) {
    float center = -SPK_PI + (float(i) + 0.5) * (SPK_TAU / float(SPK_NUM_BANDS));
    float d = abs(atan(sin(angle - center), cos(angle - center)));
    float width = (SPK_TAU / float(SPK_NUM_BANDS)) * 0.75;
    float t = clamp(d / width, 0.0, 1.0);
    return 0.5 + 0.5 * cos(t * SPK_PI);
  }

  float spkZoneAmp(vec3 p) {
    float angle = atan(p.z, p.x);
    float amp = 0.0;
    float wsum = 0.0;
    for (int i = 0; i < SPK_NUM_BANDS; i++) {
      float w = spkBandWeight(angle, i);
      amp += w * uSpectrum[i];
      wsum += w;
    }
    return amp / max(wsum, 0.0001);
  }

  vec3 hash3(vec3 p) {
    p = vec3(
      dot(p, vec3(127.1, 311.7, 74.7)),
      dot(p, vec3(269.5, 183.3, 246.1)),
      dot(p, vec3(113.5, 271.9, 124.6))
    );
    return fract(sin(p) * 43758.5453123);
  }

  // returns F1 distance to nearest feature point of a jittered 3D grid.
  // Jitter is pulled in toward each cell center (instead of filling the
  // whole cell) so feature points land roughly evenly spaced — that keeps
  // the resulting spikes close to uniform in size instead of some cells
  // being tiny and neighbors huge, which is what breaks up their shape.
  float worleyF1(vec3 p) {
    vec3 pi = floor(p);
    vec3 pf = fract(p);
    float minDist = 8.0;
    float jitter = 0.55;

    for (int z = -1; z <= 1; z++) {
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 neighbor = vec3(float(x), float(y), float(z));
          vec3 point = 0.5 + (hash3(pi + neighbor) - 0.5) * jitter;
          vec3 diff = neighbor + point - pf;
          float dist = length(diff);
          minDist = min(minDist, dist);
        }
      }
    }
    return minDist;
  }

  float spikeCone(vec3 p, float freq, float sharpness) {
    float d = worleyF1(p * freq);
    float t = clamp(1.0 - d, 0.0, 1.0);
    return pow(t, sharpness);
  }

  // primary spikes (bass-driven) + finer secondary spikes (treble-driven).
  // No time-based drift here on purpose: the spike pattern itself is fixed,
  // only its height reacts to audio — so with no sound the surface holds
  // perfectly still instead of idling/breathing on its own.
  float calcDisplacement(vec3 p) {
    vec3 pd = p;

    float primary = spikeCone(pd, uFreq, uSharpness);
    float secondary = spikeCone(pd * 2.4 + 17.0, uFreq * 2.6, max(uSharpness * 0.7, 1.0));

    // primary spikes: each longitudinal zone answers to its own frequency
    // band instead of one shared bass level, so low/mid/high tones visibly
    // rise in different places around the sphere.
    float zone = spkZoneAmp(pd);
    float bassAmp = 0.045 + zone * uAmp * 1.7;
    float trebleAmp = 0.015 + uTreble * uAmp * 0.65;

    return primary * bassAmp + secondary * trebleAmp * 0.22;
  }
`;

// A flat, camera-facing "neon ring" — not a 3D mesh at all, but a signed-
// distance shape drawn in a fragment shader on a plane, so it stays a
// static, perfectly flat outline (no rotation, no perspective/lighting
// artifacts) whose outer edge bulges smoothly outward at a few points
// around the ring. The inner edge always stays a clean circle, matching
// how the reference clip's "ears" read as liquid merging onto the outer
// rim rather than the whole tube swelling.
export const ringPlaneVertexGLSL = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 8 frequency bands (bass -> treble, see AudioEngine.spectrum) mapped to
// 8 positions evenly spaced around the ring, so different tones bulge
// different zones — a circular equalizer — instead of every zone jumping
// on the same overall bass hit.
export const ringPlaneFragmentGLSL = /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform float uTreble;
  uniform float uAmp;
  uniform float uSharpness;
  // 5 layers x 8 bands, flattened (layer h's band i is at [h*8+i]). Layer 0
  // is the current signal; each later layer is a slower-chasing lerp of the
  // one before it (see main.js), so on a hit they peel apart into a trail
  // of increasingly delayed, fainter echoes instead of moving as one block.
  uniform float uBandsHistory[40];
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uIrisTint;

  #define NUM_BANDS 8
  #define NUM_LAYERS 5
  #define TAU 6.28318530718
  #define PI 3.14159265359

  // cosine "bump": 1.0 at the center, falls smoothly to 0.0 at +/-width,
  // with zero slope at both ends — always a rounded dome, never a point,
  // no matter how narrow "width" gets (unlike pow(linearTent, n), which
  // turns pointed at high exponents).
  float lobeBump(float angle, float center, float width) {
    float d = abs(atan(sin(angle - center), cos(angle - center)));
    float t = clamp(d / width, 0.0, 1.0);
    return 0.5 + 0.5 * cos(t * PI);
  }

  // cheap HSL-ish hue ramp (h wraps 0..1) for the iridescent sheen below —
  // no saturation/lightness params needed since it's screen-blended onto
  // an existing color rather than used standalone. Green is knocked way
  // down so the cycle reads as reds/pinks/purples/blues/cyans rather than
  // the sickly yellow-green band a plain hue wheel passes through.
  vec3 hue2rgb(float h) {
    vec3 c = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    c.g *= 0.35;
    return c;
  }

  // Unlike the sphere (deliberately dead-still in silence), the ring gets a
  // small always-on ripple — three sine waves at incommensurate
  // frequencies/speeds/phases so it never visibly repeats — like a
  // symbiote's skin softly crawling rather than a mechanical wobble.
  float idleWobble(float angle, float time) {
    return sin(angle * 3.0 + time * 0.6) * 0.5
      + sin(angle * 5.0 - time * 0.9 + 1.7) * 0.3
      + sin(angle * 7.0 + time * 1.3 + 4.1) * 0.2;
  }

  void main() {
    // headroom so the bulge can't grow past the plane's own physical edge
    // (UV only spans 0..1) even at max sensitivity + a full bass hit.
    vec2 p = (vUv * 2.0 - 1.0) * 2.0;
    float angle = atan(p.y, p.x);
    float dist = length(p);

    // narrower width reads as more distinct separate lobes; still always
    // rounded regardless, so "Nitidez" can no longer create points.
    float width = mix(0.7, 0.42, clamp(uSharpness / 6.0, 0.0, 1.0));

    // thinner at rest than the first pass — the tube itself is the
    // baseline visual weight, bass hits are what add real bulk.
    float wobbleRaw = idleWobble(angle, uTime);
    float wobble = wobbleRaw * 0.012;
    float innerR = 0.5;

    float aa = fwidth(dist) * 1.5;
    float innerMask = smoothstep(innerR - aa, innerR + aa, dist);

    // draw oldest/faintest layer first, newest/brightest last, standard
    // "over" compositing so a hit's most recent edge stays crisp on top
    // while the layers it's pulling away from fade out behind it.
    vec3 outColor = vec3(0.0);
    float outAlpha = 0.0;

    for (int h = NUM_LAYERS - 1; h >= 0; h--) {
      // summed (not max'd) so neighboring bands' bumps blend into each
      // other where they overlap instead of leaving a seam at whichever
      // point one band stops "winning" over the next.
      float lobes = 0.0;
      for (int i = 0; i < NUM_BANDS; i++) {
        float center = -PI + (float(i) + 0.5) * (TAU / float(NUM_BANDS));
        lobes += lobeBump(angle, center, width) * uBandsHistory[h * NUM_BANDS + i];
      }
      lobes = clamp(lobes, 0.0, 1.3);

      // no idle drift: true silence holds a perfectly clean ring, a hit
      // bulges only the zone(s) whose frequency is actually playing.
      float bulge = lobes * uAmp * 0.5;
      float outerR = 0.58 + wobble + bulge + uTreble * uAmp * 0.02;
      float layerFade = pow(0.62, float(h));

      // chromatic aberration on the trail: the live edge (h=0) stays
      // crisp, but each older/fainter echo splits its R/G/B a little
      // further apart, so the receding trail fringes into color instead
      // of just fading as a flat-tinted ghost.
      float aberration = float(h) * 0.007;
      float maskR = (1.0 - smoothstep(outerR + aberration - aa, outerR + aberration + aa, dist)) * innerMask;
      float maskG = (1.0 - smoothstep(outerR - aa, outerR + aa, dist)) * innerMask;
      float maskB = (1.0 - smoothstep(outerR - aberration - aa, outerR - aberration + aa, dist)) * innerMask;

      vec3 color = mix(uColorA, uColorB, clamp(lobes * 1.5, 0.0, 1.0));

      // liquid-chrome sheen, tinted by uIrisTint so it can be colored from
      // the panel instead of always full-rainbow. Not a static ring outline:
      // the thin edge line is only lit where the SAME wobble driving the
      // idle "symbiote" breathing is currently near its peak, so the
      // highlight travels/pulses around the rim with that motion instead
      // of sitting there constantly — plus a much stronger boost wherever
      // the bulge shape is actively changing (bass hits).
      float edgeDist = min(abs(dist - innerR), abs(dist - outerR));
      float rimEdge = 1.0 - smoothstep(0.0, 0.008, edgeDist);
      float shimmer = smoothstep(0.15, 0.85, wobbleRaw);
      float rimActivity = clamp(fwidth(lobes) * 6.0, 0.0, 1.0);
      float rim = clamp(rimEdge * shimmer * 0.9 + rimActivity, 0.0, 1.0);
      float hue = fract(angle / TAU * 2.0 + dist * 0.5 - uTime * 0.04);
      // uIrisTint is the user's chosen color, not just a multiplier: it must
      // stay clearly visible in whatever hue the user picks (including pure
      // green, which hue2rgb() itself keeps dim to avoid a sickly cast in
      // the AUTO rainbow cycle). hue2rgb only adds a shimmering brightness
      // swing on top of the full tint instead of gating individual channels.
      color += uIrisTint * (0.55 + 0.65 * hue2rgb(hue)) * rim * 0.45;

      vec3 chAlpha = vec3(maskR, maskG, maskB) * layerFade;
      outColor = outColor * (1.0 - chAlpha) + color * chAlpha;
      outAlpha = max(outAlpha, max(chAlpha.r, max(chAlpha.g, chAlpha.b)));
    }

    if (outAlpha < 0.003) discard;
    gl_FragColor = vec4(outColor, outAlpha);
  }
`;

// Halftone backdrop: the same two-blob aura (soft glow, bass-reactive
// scale/opacity, gentle drift) but expressed as a grid of dots whose SIZE
// tracks local brightness — print-halftone style — instead of a blurred
// gradient. Rendered on a plane parented to the camera (see main.js) so it
// always fills the background regardless of orbit, with alpha 0 in the
// gaps between dots so the CSS --lc-void/vignette underneath still shows.
export const bgHalftoneVertexGLSL = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const bgHalftoneFragmentGLSL = /* glsl */ `
  varying vec2 vPos;

  uniform float uTime;
  uniform float uAuraScale;
  uniform float uAuraOpacity;
  uniform vec3 uAura1;
  uniform vec3 uAura2;

  float blobField(vec2 p, vec2 center, float radius) {
    return smoothstep(radius, 0.0, length(p - center));
  }

  void main() {
    vec2 p = vPos;

    // slow, non-repeating drift (incommensurate frequencies) so the blobs
    // wander gently instead of sitting frozen or orbiting mechanically.
    vec2 driftA = vec2(sin(uTime * 0.11) * 1.4, cos(uTime * 0.087) * 1.0);
    vec2 driftB = vec2(cos(uTime * 0.079) * 1.3, sin(uTime * 0.13) * 1.1);

    float radius = 9.0 * uAuraScale;
    float brightA = blobField(p, vec2(-4.2, 2.1) + driftA, radius) * uAuraOpacity;
    float brightB = blobField(p, vec2(4.6, -1.6) + driftB, radius) * uAuraOpacity;

    float cellSize = 0.5;
    vec2 cell = floor(p / cellSize);
    vec2 cellCenter = (cell + 0.5) * cellSize;
    float dist = length(p - cellCenter);
    float aa = fwidth(dist);

    float rA = brightA * cellSize * 0.46;
    float rB = brightB * cellSize * 0.46;
    float maskA = 1.0 - smoothstep(rA - aa, rA + aa, dist);
    float maskB = 1.0 - smoothstep(rB - aa, rB + aa, dist);

    vec3 color = uAura1 * maskA + uAura2 * maskB;
    float alpha = clamp(maskA + maskB, 0.0, 1.0);

    if (alpha < 0.02) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;
