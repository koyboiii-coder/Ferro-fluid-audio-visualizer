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

    float bassAmp = 0.045 + uBass * uAmp * 1.7;
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
    float wobble = idleWobble(angle, uTime) * 0.012;
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
      float outerMask = 1.0 - smoothstep(outerR - aa, outerR + aa, dist);
      float ring = outerMask * innerMask;

      float layerFade = pow(0.62, float(h));
      float alpha = ring * layerFade;
      vec3 color = mix(uColorA, uColorB, clamp(lobes * 1.5, 0.0, 1.0));

      outColor = mix(outColor, color, alpha);
      outAlpha = mix(outAlpha, 1.0, alpha);
    }

    if (outAlpha < 0.003) discard;
    gl_FragColor = vec4(outColor, outAlpha);
  }
`;
