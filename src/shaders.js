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

export const ringPlaneFragmentGLSL = /* glsl */ `
  varying vec2 vUv;

  uniform float uBass;
  uniform float uTreble;
  uniform float uAmp;
  uniform float uFreq;
  uniform float uSharpness;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  // smooth angular bump centered on "center", 0 outside +/-width, 1 at
  // the center, shaped by "sharpness" (higher = narrower/more rounded peak)
  float lobeShape(float angle, float center, float width, float sharpness) {
    float d = abs(atan(sin(angle - center), cos(angle - center)));
    float t = clamp(1.0 - d / width, 0.0, 1.0);
    return pow(t, sharpness);
  }

  void main() {
    // headroom so the bulge can't grow past the plane's own physical edge
    // (UV only spans 0..1) even at max sensitivity + a full bass hit.
    vec2 p = (vUv * 2.0 - 1.0) * 1.7;
    float angle = atan(p.y, p.x);
    float dist = length(p);

    float roundness = mix(2.0, 6.0, clamp(uSharpness / 6.0, 0.0, 1.0));
    // "Densidad de picos" fades extra lobes in/out instead of changing a
    // loop count (GLSL loop bounds must stay static) — five fixed, unevenly
    // spaced candidate positions read as organic rather than a neat rosette.
    float freqT = clamp((uFreq - 2.0) / 20.0, 0.0, 1.0);
    float lobes = 0.0;
    lobes += lobeShape(angle, 0.6, 0.95, roundness);
    lobes += lobeShape(angle, -2.35, 0.85, roundness);
    lobes += lobeShape(angle, 2.75, 0.7, roundness) * smoothstep(0.1, 0.45, freqT);
    lobes += lobeShape(angle, -0.95, 0.6, roundness) * smoothstep(0.3, 0.7, freqT);
    lobes += lobeShape(angle, 1.85, 0.55, roundness) * smoothstep(0.55, 1.0, freqT);
    lobes = clamp(lobes, 0.0, 1.0);

    // no idle drift: silence holds a perfectly clean ring, a hit bulges it.
    float bulge = lobes * (uBass * uAmp * 0.42);

    float innerR = 0.42;
    float outerR = 0.6 + bulge + uTreble * uAmp * 0.02;

    float aa = fwidth(dist) * 1.5;
    float outerMask = 1.0 - smoothstep(outerR - aa, outerR + aa, dist);
    float innerMask = smoothstep(innerR - aa, innerR + aa, dist);
    float ring = outerMask * innerMask;

    if (ring < 0.003) discard;

    vec3 color = mix(uColorA, uColorB, clamp(lobes * 1.5, 0.0, 1.0));
    gl_FragColor = vec4(color, ring);
  }
`;
