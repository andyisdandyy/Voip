class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Decoded audio frames waiting to be played
    this.queue  = [];
    this.current = null;
    this.pos    = 0;

    // ── Adaptive jitter buffer ──────────────────────────────
    // During `buffering` phase we output silence until the queue has
    // filled to `targetDepth` frames (≈ targetDepth × 20 ms).
    // `emaDepth` tracks the exponential moving average of queue depth;
    // `targetDepth` adapts up when depth is frequently low (jitter)
    // and down when depth stays well above target (stable / reduce latency).
    this.buffering   = true;
    this.targetDepth = 3;     // initial target: 3 frames = 60 ms
    this.emaDepth    = 0;
    this.emaAlpha    = 0.05;  // slow EMA — stable over ~20 process() calls
    this.adaptTick   = 0;
    this.maxDepth    = 12;    // hard cap: drop oldest frame when exceeded

    this.port.onmessage = (e) => {
      // Decode Int16 stereo interleaved → separate float32 L/R channels
      const bytes  = new Uint8Array(e.data);
      const int16  = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const frames = int16.length / 2;
      const left   = new Float32Array(frames);
      const right  = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i]  = int16[i * 2]     / 32768.0;
        right[i] = int16[i * 2 + 1] / 32768.0;
      }

      this.queue.push({ left, right });

      // Hard cap — drop the oldest frame to prevent latency build-up
      // (e.g. after the tab was backgrounded and frames accumulated)
      while (this.queue.length > this.maxDepth) this.queue.shift();
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const chL = output[0];
    const chR = output[1] || null;

    // ── Update EMA depth ───────────────────────────────────
    const depth = this.queue.length + (this.current ? 1 : 0);
    this.emaDepth = this.emaAlpha * depth + (1 - this.emaAlpha) * this.emaDepth;

    // ── Adaptive target adjustment (every 200 process() calls ≈ 1 s) ──
    if (++this.adaptTick >= 200) {
      this.adaptTick = 0;
      if (this.emaDepth < 0.8 && this.targetDepth < 8) {
        // Frequent underruns — buffer more
        this.targetDepth++;
      } else if (this.emaDepth > this.targetDepth + 1.5 && this.targetDepth > 1) {
        // Consistently over-buffered — tighten for lower latency
        this.targetDepth--;
      }
    }

    // ── Buffering phase: hold until queue is filled ─────────
    if (this.buffering) {
      if (this.queue.length >= this.targetDepth) {
        this.buffering = false;
      } else {
        chL.fill(0);
        if (chR) chR.fill(0);
        return true;
      }
    }

    // ── Normal playback ────────────────────────────────────
    let i = 0;
    while (i < chL.length) {
      if (!this.current || this.pos >= this.current.left.length) {
        this.current = this.queue.shift() || null;
        this.pos = 0;
        if (!this.current) {
          // Underrun — enter buffering phase and fill rest with silence
          this.buffering = true;
          for (; i < chL.length; i++) {
            chL[i] = 0;
            if (chR) chR[i] = 0;
          }
          break;
        }
      }
      chL[i] = this.current.left[this.pos];
      if (chR) chR[i] = this.current.right[this.pos];
      this.pos++;
      i++;
    }

    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
