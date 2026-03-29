class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(960);
    this.pos = 0;
    this.sensitivity = 0;
    this.gateGain = 1;
    this.releaseRate = 0.75; // per 20ms block — ~300ms fade to silence
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.sensitivity === 'number') {
        this.sensitivity = e.data.sensitivity;
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
            this.gateGain = 1;
          } else {
            this.gateGain *= this.releaseRate;
            if (this.gateGain < 0.001) this.gateGain = 0;
          }
          if (this.gateGain < 1) {
            for (let j = 0; j < 960; j++) this.buffer[j] *= this.gateGain;
          }
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
