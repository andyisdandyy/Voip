// ══════════════════════════════════════════════════════════════
//  audio-loopback — N-API C++ addon
//  WASAPI process-loopback capture (Windows 10 2004+, build 19041+).
//
//  Two modes:
//    INCLUDE — capture audio from a specific process tree only
//    EXCLUDE — capture all system audio EXCEPT a process tree
//
//  Inspired by OBS's win-wasapi implementation.
// ══════════════════════════════════════════════════════════════

#ifdef _WIN32

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <roapi.h>

#include <atomic>
#include <thread>
#include <mutex>
#include <cstring>

using Microsoft::WRL::ComPtr;

// ── Activation-params types for process loopback ────────────
// Try to include the official header first (available in Windows SDK 10.0.19041+).
// Fall back to manual definitions for older SDKs.
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else

typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1,
} PROCESS_LOOPBACK_MODE;

typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1,
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  };
} AUDIOCLIENT_ACTIVATION_PARAMS;

#endif

// VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK — activator string
static const wchar_t *LOOPBACK_DEVICE_ID =
    L"VAD\\Process_Loopback";

// ── IActivateAudioInterfaceCompletionHandler implementation ──
// The handler MUST be agile (FtmBase) so ActivateAudioInterfaceAsync can
// call back from any apartment.  All WASAPI setup (GetMixFormat, Initialize,
// GetService) happens inside ActivateCompleted — the IAudioClient proxy
// is only usable on the thread that received it.
class ActivateHandler
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          IActivateAudioInterfaceCompletionHandler,
          Microsoft::WRL::FtmBase> {
public:
  ActivateHandler() : _hr(E_FAIL) {
    _event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  }
  ~ActivateHandler() { if (_event) CloseHandle(_event); }

  HRESULT STDMETHODCALLTYPE
  ActivateCompleted(IActivateAudioInterfaceAsyncOperation *op) override {
    HRESULT hrActivate = E_FAIL;
    IUnknown *pUnk = nullptr;
    HRESULT hr = op->GetActivateResult(&hrActivate, &pUnk);
    if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && pUnk) {
      // Store raw IUnknown — QI for IAudioClient will happen on the
      // consumer's MTA thread to avoid apartment issues.
      _unk = pUnk;        // ComPtr AddRef's
    }
    _hr = SUCCEEDED(hr) ? hrActivate : hr;
    if (pUnk) pUnk->Release();
    SetEvent(_event);
    return S_OK;
  }

  HRESULT Wait(DWORD ms = 5000) {
    WaitForSingleObject(_event, ms);
    return _hr;
  }

  ComPtr<IUnknown> GetUnknown() { return _unk; }

private:
  HANDLE _event;
  HRESULT _hr;
  ComPtr<IUnknown> _unk;
};

// ── Capture state ────────────────────────────────────────────

// ── Audio packet passed through a lock-free queue ────────────
struct AudioPacket {
  uint8_t *data;
  UINT32 byteCount;
  UINT32 frames;
  UINT32 channels;
  UINT32 sampleRate;
  UINT32 bitsPerSample;
};

struct CaptureState {
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  WAVEFORMATEX *mixFormat = nullptr;
  std::thread thread;
  std::atomic<bool> running{false};
  Napi::ThreadSafeFunction tsfn;
  HANDLE stopEvent = nullptr;
  UINT32 bufferFrames = 0;

  // Packet queue — capture thread pushes, JS callback pops
  std::mutex queueMutex;
  std::vector<AudioPacket> queue;
};

static std::mutex g_mutex;
static CaptureState *g_state = nullptr;

// ── Capture thread ──────────────────────────────────────────
// (Inlined into the std::thread lambda inside StartCapture — the
//  capture loop shares the MTA thread used for WASAPI setup so the
//  IAudioClient proxy never crosses apartment boundaries.)

// ── JS API: drainQueue() — called from TSFN default callback ─
// Returns an array of {data, info} objects from the capture queue.
static Napi::Value DrainQueue(const Napi::CallbackInfo &cbInfo) {
  Napi::Env env = cbInfo.Env();
  if (!g_state) return env.Undefined();

  std::vector<AudioPacket> packets;
  {
    std::lock_guard<std::mutex> lock(g_state->queueMutex);
    packets.swap(g_state->queue);
  }

  auto arr = Napi::Array::New(env, packets.size());
  for (size_t i = 0; i < packets.size(); i++) {
    auto &pkt = packets[i];
    // Electron disallows external ArrayBuffers — copy into V8-managed memory.
    auto ab = Napi::ArrayBuffer::New(env, pkt.byteCount);
    memcpy(ab.Data(), pkt.data, pkt.byteCount);
    delete[] pkt.data;
    auto u8 = Napi::Uint8Array::New(env, pkt.byteCount, ab, 0);
    auto info = Napi::Object::New(env);
    info.Set("sampleRate",    Napi::Number::New(env, pkt.sampleRate));
    info.Set("channels",      Napi::Number::New(env, pkt.channels));
    info.Set("frames",        Napi::Number::New(env, pkt.frames));
    info.Set("bitsPerSample", Napi::Number::New(env, pkt.bitsPerSample));
    auto obj = Napi::Object::New(env);
    obj.Set("data", u8);
    obj.Set("info", info);
    arr[i] = obj;
  }
  return arr;
}

// ── JS API: startCapture(callback [, targetPid]) ────────────
//   targetPid > 0  → INCLUDE mode (capture only that process tree)
//   targetPid == 0  → EXCLUDE mode (capture all except Electron)

static Napi::Value StartCapture(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected callback function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_state) {
    Napi::Error::New(env, "Capture already running")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  HRESULT hr;

  // Determine loopback mode from optional targetPid argument
  DWORD targetPid = 0;
  PROCESS_LOOPBACK_MODE loopMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  if (info.Length() >= 2 && info[1].IsNumber()) {
    targetPid = info[1].As<Napi::Number>().Uint32Value();
  }

  if (targetPid > 0) {
    // INCLUDE: capture only the target process tree's audio
    loopMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  } else {
    // EXCLUDE: capture all system audio except our own process tree
    targetPid = GetCurrentProcessId();
    loopMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  }

  // Build activation params and call ActivateAudioInterfaceAsync.
  // The agile handler (FtmBase) allows the completion callback to
  // marshal across apartments, so we can call from any thread.
  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = targetPid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = loopMode;

  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE *>(&params);

  auto handler = Microsoft::WRL::Make<ActivateHandler>();
  IActivateAudioInterfaceAsyncOperation *asyncOp = nullptr;
  hr = ActivateAudioInterfaceAsync(LOOPBACK_DEVICE_ID,
                                   __uuidof(IAudioClient), &activateParams,
                                   handler.Get(), &asyncOp);
  if (SUCCEEDED(hr)) {
    hr = handler->Wait(5000);
    if (asyncOp) asyncOp->Release();
  }

  if (FAILED(hr) || !handler->GetUnknown()) {
    char buf[256];
    snprintf(buf, sizeof(buf),
             "Audio activation failed (HRESULT 0x%08lX). "
             "Requires Windows 10 2004+.",
             static_cast<unsigned long>(hr));
    Napi::Error::New(env, buf).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto unk = handler->GetUnknown();

  // ── All WASAPI work (QI, GetMixFormat, Initialize, GetService, Start,
  //    capture loop) runs on a single MTA thread.  The IUnknown from the
  //    activation can be QI'd from any apartment, but the resulting
  //    IAudioClient proxy must be used from the same apartment. ──
  auto *state = new CaptureState();
  state->stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  // The TSFN signals "data ready" via bare NonBlockingCall().  The JS
  // callback passed here should call drainQueue() to get the packets.
  state->tsfn = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "LoopbackCapture", 0, 1);
  state->running.store(true, std::memory_order_relaxed);

  struct SetupResult { HRESULT hr = E_FAIL; UINT32 sampleRate = 0; UINT32 channels = 0; UINT32 bps = 0; } setupResult;
  HANDLE setupDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  state->thread = std::thread([state, unk, &setupResult, setupDone]() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    // QI for IAudioClient on this MTA thread
    ComPtr<IAudioClient> client;
    HRESULT hr = unk->QueryInterface(IID_PPV_ARGS(&client));
    if (FAILED(hr) || !client) {
      setupResult.hr = FAILED(hr) ? hr : E_FAIL;
      SetEvent(setupDone);
      CoUninitialize();
      return;
    }
    state->client = client;

    // GetMixFormat — some Windows builds return E_NOTIMPL for process
    // loopback clients.  Fall back to the standard engine format.
    WAVEFORMATEX *mixFormat = nullptr;
    hr = client->GetMixFormat(&mixFormat);
    if (FAILED(hr)) {
      // Use the standard Windows audio engine format (48 kHz, 32-bit float, stereo)
      mixFormat = static_cast<WAVEFORMATEX *>(CoTaskMemAlloc(sizeof(WAVEFORMATEX)));
      if (!mixFormat) { setupResult.hr = E_OUTOFMEMORY; SetEvent(setupDone); CoUninitialize(); return; }
      mixFormat->wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
      mixFormat->nChannels = 2;
      mixFormat->nSamplesPerSec = 48000;
      mixFormat->wBitsPerSample = 32;
      mixFormat->nBlockAlign = mixFormat->nChannels * mixFormat->wBitsPerSample / 8;
      mixFormat->nAvgBytesPerSec = mixFormat->nSamplesPerSec * mixFormat->nBlockAlign;
      mixFormat->cbSize = 0;
    }

    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                             200000 /*20ms*/, 0, mixFormat, nullptr);
    if (FAILED(hr)) { CoTaskMemFree(mixFormat); setupResult.hr = hr; SetEvent(setupDone); CoUninitialize(); return; }

    ComPtr<IAudioCaptureClient> captureClient;
    hr = client->GetService(IID_PPV_ARGS(&captureClient));
    if (FAILED(hr)) { CoTaskMemFree(mixFormat); setupResult.hr = hr; SetEvent(setupDone); CoUninitialize(); return; }

    UINT32 bufferFrames = 0;
    client->GetBufferSize(&bufferFrames);
    state->capture = captureClient;
    state->mixFormat = mixFormat;
    state->bufferFrames = bufferFrames;

    hr = client->Start();
    if (FAILED(hr)) { CoTaskMemFree(mixFormat); state->mixFormat = nullptr; setupResult.hr = hr; SetEvent(setupDone); CoUninitialize(); return; }

    setupResult = { S_OK, mixFormat->nSamplesPerSec, mixFormat->nChannels, mixFormat->wBitsPerSample };
    SetEvent(setupDone);

    // ── Capture loop on this MTA thread ──
    DWORD taskIndex = 0;
    HANDLE hTask = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);
    const UINT32 frameSize = mixFormat->nBlockAlign;
    const UINT32 sampleRate = mixFormat->nSamplesPerSec;
    const UINT32 channels = mixFormat->nChannels;
    const UINT32 bps = mixFormat->wBitsPerSample;

    while (state->running.load(std::memory_order_relaxed)) {
      DWORD waitMs = (bufferFrames * 500) / sampleRate;
      if (waitMs < 5) waitMs = 5; if (waitMs > 50) waitMs = 50;
      if (WaitForSingleObject(state->stopEvent, waitMs) == WAIT_OBJECT_0) break;

      UINT32 pktLen = 0;
      captureClient->GetNextPacketSize(&pktLen);
      while (pktLen > 0) {
        BYTE *data = nullptr; UINT32 numFrames = 0; DWORD flags = 0;
        if (FAILED(captureClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr))) break;
        if (numFrames > 0 && data) {
          const UINT32 byteCount = numFrames * frameSize;
          auto *copy = new uint8_t[byteCount];
          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) memset(copy, 0, byteCount);
          else memcpy(copy, data, byteCount);
          const UINT32 nf = numFrames;
          {
            std::lock_guard<std::mutex> qlock(state->queueMutex);
            state->queue.push_back({copy, byteCount, nf, channels, sampleRate, bps});
          }
          state->tsfn.NonBlockingCall();
        }
        captureClient->ReleaseBuffer(numFrames);
        captureClient->GetNextPacketSize(&pktLen);
      }
    }
    if (hTask) AvRevertMmThreadCharacteristics(hTask);
    CoUninitialize();
  });

  WaitForSingleObject(setupDone, 5000);
  CloseHandle(setupDone);

  if (FAILED(setupResult.hr)) {
    state->running.store(false, std::memory_order_relaxed);
    SetEvent(state->stopEvent);
    if (state->thread.joinable()) state->thread.join();
    state->tsfn.Release();
    CloseHandle(state->stopEvent);
    delete state;
    char buf[256];
    snprintf(buf, sizeof(buf), "WASAPI setup failed (HRESULT 0x%08lX).",
             static_cast<unsigned long>(setupResult.hr));
    Napi::Error::New(env, buf).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  g_state = state;

  auto result = Napi::Object::New(env);
  result.Set("sampleRate",    Napi::Number::New(env, setupResult.sampleRate));
  result.Set("channels",      Napi::Number::New(env, setupResult.channels));
  result.Set("bitsPerSample", Napi::Number::New(env, setupResult.bps));
  return result;
}

// ── JS API: stopCapture() ───────────────────────────────────

static Napi::Value StopCapture(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_state) return env.Undefined();

  auto *state = g_state;
  g_state = nullptr;

  // Signal stop
  state->running.store(false, std::memory_order_relaxed);
  SetEvent(state->stopEvent);

  // Wait for thread to finish
  if (state->thread.joinable()) state->thread.join();

  // Stop and release WASAPI
  state->client->Stop();
  if (state->mixFormat) CoTaskMemFree(state->mixFormat);
  CloseHandle(state->stopEvent);

  // Release the TSFN
  state->tsfn.Release();

  // Free any remaining queued audio packets
  for (auto &pkt : state->queue) delete[] pkt.data;
  state->queue.clear();

  delete state;
  return env.Undefined();
}

// ── JS API: isSupported() ───────────────────────────────────
// Returns true if the OS build supports process loopback (19041+)

static Napi::Value IsSupported(const Napi::CallbackInfo &info) {
  // Check Windows build number via RtlGetVersion
  typedef LONG(WINAPI * RtlGetVersionPtr)(PRTL_OSVERSIONINFOW);
  auto ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll)
    return Napi::Boolean::New(info.Env(), false);
  auto fn = reinterpret_cast<RtlGetVersionPtr>(
      GetProcAddress(ntdll, "RtlGetVersion"));
  if (!fn) return Napi::Boolean::New(info.Env(), false);
  RTL_OSVERSIONINFOW ver = {};
  ver.dwOSVersionInfoSize = sizeof(ver);
  fn(&ver);
  // Windows 10 2004 = build 19041
  return Napi::Boolean::New(info.Env(),
                            ver.dwBuildNumber >= 19041);
}

// ── JS API: getWindowPid(hwnd) ──────────────────────────────
// Given a window handle (number), returns the owning process ID.
// Used to extract the PID from a desktopCapturer source ID like "window:12345:0".

static Napi::Value GetWindowPid(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return Napi::Number::New(env, 0);
  }
  HWND hwnd = reinterpret_cast<HWND>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  return Napi::Number::New(env, pid);
}

// ── Module init ─────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("startCapture",
              Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture",
              Napi::Function::New(env, StopCapture));
  exports.Set("isSupported",
              Napi::Function::New(env, IsSupported));
  exports.Set("getWindowPid",
              Napi::Function::New(env, GetWindowPid));
  exports.Set("drainQueue",
              Napi::Function::New(env, DrainQueue));
  return exports;
}

NODE_API_MODULE(audio_loopback, Init)

#else
// ── Non-Windows stub ─────────────────────────────────────────
#include <napi.h>

static Napi::Value NotSupported(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), false);
}

static Napi::Value Noop(const Napi::CallbackInfo &info) {
  return info.Env().Undefined();
}

static Napi::Value ZeroPid(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), 0);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("startCapture", Napi::Function::New(env, Noop));
  exports.Set("stopCapture", Napi::Function::New(env, Noop));
  exports.Set("isSupported", Napi::Function::New(env, NotSupported));
  exports.Set("getWindowPid", Napi::Function::New(env, ZeroPid));
  return exports;
}

NODE_API_MODULE(audio_loopback, Init)
#endif
