class ScreenCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferL = new Float32Array(960);
    this.bufferR = new Float32Array(960);
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const left = input[0];
    const right = input[1] || left;

    for (let i = 0; i < left.length; i++) {
      this.bufferL[this.pos] = left[i];
      this.bufferR[this.pos] = right[i];
      this.pos++;
      if (this.pos >= 960) {
        const int16 = new Int16Array(1920);
        for (let j = 0; j < 960; j++) {
          int16[j * 2] = Math.max(-32768, Math.min(32767, Math.round(this.bufferL[j] * 32767)));
          int16[j * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(this.bufferR[j] * 32767)));
        }
        this.port.postMessage(int16.buffer, [int16.buffer]);
        this.bufferL = new Float32Array(960);
        this.bufferR = new Float32Array(960);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('screen-capture-processor', ScreenCaptureProcessor);
