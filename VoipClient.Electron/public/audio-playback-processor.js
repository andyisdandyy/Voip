class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.pos = 0;

    this.port.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
      }
      this.queue.push(float32);
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const ch = output[0];
    for (let i = 0; i < ch.length; i++) {
      if (!this.current || this.pos >= this.current.length) {
        this.current = this.queue.shift() || null;
        this.pos = 0;
      }
      ch[i] = this.current ? this.current[this.pos++] : 0;
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
