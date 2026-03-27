// audio-loopback — JS wrapper
// Loads the native N-API addon and re-exports its API.
// On non-Windows platforms (or if the binary isn't built), all
// methods are safe no-ops so the rest of the app can require()
// this module unconditionally.

let native;
try {
  native = require('./build/Release/audio_loopback.node');
} catch {
  try {
    native = require('./build/Debug/audio_loopback.node');
  } catch {
    // Native module not available — provide safe stubs
    native = {
      startCapture: () => { throw new Error('audio-loopback: native module not built'); },
      stopCapture: () => {},
      isSupported: () => false,
      getWindowPid: () => 0,
      drainQueue: () => [],
    };
  }
}

module.exports = native;
