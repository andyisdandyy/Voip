class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(960);
    this.pos = 0;
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
