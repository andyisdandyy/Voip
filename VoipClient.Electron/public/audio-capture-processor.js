class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(960);
    this.pos = 0;
    this.sensitivity = 0;
    this.gateGain = 0;
    // Gate timing (in 20ms blocks)
    this.attackBlocks = 1;   // blocks to ramp from 0→1 (default ~20ms)
    this.holdBlocks = 5;     // blocks to keep open after level drops (default ~100ms)
    this.releaseBlocks = 15; // blocks to ramp from 1→0 (default ~300ms)
    this.holdCounter = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.sensitivity === 'number') {
        this.sensitivity = e.data.sensitivity;
      }
      if (e.data && typeof e.data.attackMs === 'number') {
        this.attackBlocks = Math.max(1, Math.round(e.data.attackMs / 20));
      }
      if (e.data && typeof e.data.holdMs === 'number') {
        this.holdBlocks = Math.max(0, Math.round(e.data.holdMs / 20));
      }
      if (e.data && typeof e.data.releaseMs === 'number') {
        this.releaseBlocks = Math.max(1, Math.round(e.data.releaseMs / 20));
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const left = input[0];
    const right = input[1] || left;

    for (let i = 0; i < left.length; i++) {
      this.buffer[this.pos] = (left[i] + right[i]) * 0.5;
      this.pos++;
      if (this.pos >= 960) {
        if (this.sensitivity > 0) {
          let sum = 0;
          for (let j = 0; j < 960; j++) sum += this.buffer[j] * this.buffer[j];
          const level = Math.min(1, Math.sqrt(sum / 960) * 3);
          if (level >= this.sensitivity) {
            // Signal above threshold — attack (ramp up) and reset hold
            this.gateGain = Math.min(1, this.gateGain + 1 / this.attackBlocks);
            this.holdCounter = this.holdBlocks;
          } else if (this.holdCounter > 0) {
            // Below threshold but still in hold period — stay open
            this.holdCounter--;
            this.gateGain = Math.min(1, this.gateGain + 1 / this.attackBlocks);
          } else {
            // Release (ramp down)
            this.gateGain = Math.max(0, this.gateGain - 1 / this.releaseBlocks);
          }
          if (this.gateGain < 1) {
            for (let j = 0; j < 960; j++) this.buffer[j] *= this.gateGain;
          }
        } else {
          // No gate — ensure gain is fully open
          this.gateGain = 1;
          this.holdCounter = 0;
        }
        const int16 = new Int16Array(960);
        for (let j = 0; j < 960; j++) {
          int16[j] = Math.max(-32768, Math.min(32767, Math.round(this.buffer[j] * 32767)));
        }
        this.port.postMessage(int16.buffer, [int16.buffer]);
        this.buffer = new Float32Array(960);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
