class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.pos = 0;

    this.port.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const frames = int16.length / 2;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = int16[i * 2] / 32768.0;
        right[i] = int16[i * 2 + 1] / 32768.0;
      }
      this.queue.push({ left, right });
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const chL = output[0];
    const chR = output[1] || null;

    for (let i = 0; i < chL.length; i++) {
      if (!this.current || this.pos >= this.current.left.length) {
        this.current = this.queue.shift() || null;
        this.pos = 0;
      }
      if (this.current) {
        chL[i] = this.current.left[this.pos];
        if (chR) chR[i] = this.current.right[this.pos];
        this.pos++;
      } else {
        chL[i] = 0;
        if (chR) chR[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
