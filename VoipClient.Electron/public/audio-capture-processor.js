class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(960);
    this.pos = 0;

    // VAD gate state
    this.sensitivity = 0;
    this.gateGain = 0;
    this.attackBlocks = 1;   // blocks to ramp 0→1 (default ~20ms)
    this.holdBlocks = 5;     // blocks to stay open after level drops (default ~100ms)
    this.releaseBlocks = 15; // blocks to ramp 1→0 (default ~300ms)
    this.holdCounter = 0;
    this.lastLevel = 0;

    // Push-to-Talk state
    this.pttMode = false;
    this.pttHeld = false;

    this.port.onmessage = (e) => {
      if (!e.data) return;
      if (typeof e.data.sensitivity === 'number')  this.sensitivity   = e.data.sensitivity;
      if (typeof e.data.attackMs   === 'number')   this.attackBlocks  = Math.max(1, Math.round(e.data.attackMs  / 20));
      if (typeof e.data.holdMs     === 'number')   this.holdBlocks    = Math.max(0, Math.round(e.data.holdMs    / 20));
      if (typeof e.data.releaseMs  === 'number')   this.releaseBlocks = Math.max(1, Math.round(e.data.releaseMs / 20));
      if (typeof e.data.pttMode    === 'boolean')  { this.pttMode = e.data.pttMode; if (!this.pttMode) this.pttHeld = false; }
      if (typeof e.data.pttHeld    === 'boolean')  this.pttHeld = e.data.pttHeld;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const left  = input[0];
    const right = input[1] || left;

    for (let i = 0; i < left.length; i++) {
      this.buffer[this.pos] = (left[i] + right[i]) * 0.5;
      this.pos++;

      if (this.pos >= 960) {
        // ── Compute RMS level ───────────────────────────────
        let sum = 0;
        for (let j = 0; j < 960; j++) sum += this.buffer[j] * this.buffer[j];
        const level = Math.min(1, Math.sqrt(sum / 960) * 3);
        this.lastLevel = level;

        if (this.pttMode) {
          // ── Push-to-Talk: bypass VAD, key controls gate ──
          this.gateGain = this.pttHeld ? 1 : 0;
          this.holdCounter = 0;
        } else if (this.sensitivity > 0) {
          // ── Voice-activity gate ─────────────────────────
          if (level >= this.sensitivity) {
            this.gateGain = Math.min(1, this.gateGain + 1 / this.attackBlocks);
            this.holdCounter = this.holdBlocks;
          } else if (this.holdCounter > 0) {
            this.holdCounter--;
            this.gateGain = Math.min(1, this.gateGain + 1 / this.attackBlocks);
          } else {
            this.gateGain = Math.max(0, this.gateGain - 1 / this.releaseBlocks);
          }
        } else {
          this.gateGain = 1;
          this.holdCounter = 0;
        }

        // Apply gate
        if (this.gateGain < 1) {
          for (let j = 0; j < 960; j++) this.buffer[j] *= this.gateGain;
        }

        // ── Send PCM (transferable) ─────────────────────
        const int16 = new Int16Array(960);
        for (let j = 0; j < 960; j++) {
          int16[j] = Math.max(-32768, Math.min(32767, Math.round(this.buffer[j] * 32767)));
        }
        this.port.postMessage(int16.buffer, [int16.buffer]);

        // ── Send gate status (separate non-transferable msg) ─
        this.port.postMessage({ type: 'status', gateGain: this.gateGain, level: this.lastLevel });

        this.buffer = new Float32Array(960);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
