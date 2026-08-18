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
