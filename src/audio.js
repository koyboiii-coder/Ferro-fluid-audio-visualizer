export class AudioEngine {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.data = null;
    this.sourceNode = null;
    this.audioEl = null;
    this.smoothing = 0.35;

    this.bands = { bass: 0, mid: 0, treble: 0, overall: 0 };
    this._targets = { bass: 0, mid: 0, treble: 0, overall: 0 };

    // finer-grained spectrum (bass -> treble, log-spaced like the 3-band
    // split above) for visualizations that map different zones to
    // different frequencies instead of one overall bass value — e.g. the
    // ring shape's per-lobe equalizer behavior.
    this.numBands = 8;
    this.spectrum = new Float32Array(this.numBands);
    this._spectrumTargets = new Float32Array(this.numBands);
  }

  _ensureContext() {
    if (!this.context) {
      this.context = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.2;
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
    }
  }

  async loadFile(file) {
    this._ensureContext();
    this._disconnectSource();

    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.crossOrigin = "anonymous";
    }
    this.audioEl.src = URL.createObjectURL(file);
    this.audioEl.loop = true;

    this.sourceNode = this.context.createMediaElementSource(this.audioEl);
    this.sourceNode.connect(this.analyser);
    this.analyser.connect(this.context.destination);

    await this.context.resume();
    await this.audioEl.play();
    return this.audioEl;
  }

  async useMicrophone() {
    this._ensureContext();
    this._disconnectSource();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.sourceNode = this.context.createMediaStreamSource(stream);
    this.sourceNode.connect(this.analyser);
    // do not connect analyser -> destination for mic (avoid feedback)
    await this.context.resume();
  }

  // Captures the computer's own output (a shared tab/screen's audio) via the
  // screen-share picker — no virtual audio cable or OS setup needed. Only
  // works in Chromium browsers, and only if the user checks "share audio"
  // in the picker dialog.
  async useSystemAudio() {
    this._ensureContext();
    this._disconnectSource();

    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = stream.getAudioTracks();
    stream.getVideoTracks().forEach((track) => track.stop());

    if (audioTracks.length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('No se compartió audio. Al elegir qué compartir, marca la casilla "Compartir audio".');
    }

    this.sourceNode = this.context.createMediaStreamSource(stream);
    this.sourceNode.connect(this.analyser);
    audioTracks[0].addEventListener("ended", () => this._disconnectSource());
    await this.context.resume();
  }

  togglePlayback() {
    if (!this.audioEl) return;
    if (this.audioEl.paused) this.audioEl.play();
    else this.audioEl.pause();
    return !this.audioEl.paused;
  }

  _disconnectSource() {
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (e) {
        /* noop */
      }
    }
  }

  update() {
    if (!this.analyser) return this.bands;

    this.analyser.getByteFrequencyData(this.data);
    const len = this.data.length;

    const bassEnd = Math.floor(len * 0.08);
    const midEnd = Math.floor(len * 0.35);

    let bassSum = 0,
      midSum = 0,
      trebleSum = 0;

    for (let i = 0; i < bassEnd; i++) bassSum += this.data[i];
    for (let i = bassEnd; i < midEnd; i++) midSum += this.data[i];
    for (let i = midEnd; i < len; i++) trebleSum += this.data[i];

    this._targets.bass = bassSum / bassEnd / 255;
    this._targets.mid = midSum / (midEnd - bassEnd) / 255;
    this._targets.treble = trebleSum / (len - midEnd) / 255;
    this._targets.overall = (this._targets.bass + this._targets.mid + this._targets.treble) / 3;

    const s = this.smoothing;
    this.bands.bass += (this._targets.bass - this.bands.bass) * (1 - s);
    this.bands.mid += (this._targets.mid - this.bands.mid) * (1 - s);
    this.bands.treble += (this._targets.treble - this.bands.treble) * (1 - s);
    this.bands.overall += (this._targets.overall - this.bands.overall) * (1 - s);

    // squaring the fraction skews bin ranges narrower at the low end and
    // wider at the high end — matches how bass carries more perceptually
    // relevant detail per Hz than treble does.
    const n = this.numBands;
    for (let i = 0; i < n; i++) {
      const start = Math.floor(Math.pow(i / n, 2) * len);
      const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / n, 2) * len));
      let sum = 0;
      for (let j = start; j < end; j++) sum += this.data[j];
      this._spectrumTargets[i] = sum / (end - start) / 255;
    }
    for (let i = 0; i < n; i++) {
      this.spectrum[i] += (this._spectrumTargets[i] - this.spectrum[i]) * (1 - s);
    }

    return this.bands;
  }
}
