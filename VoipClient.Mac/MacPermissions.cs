using System.Runtime.InteropServices;

namespace VoipClient.Mac;

public static class MacPermissions
{
    [DllImport("/usr/lib/libobjc.dylib")]
    private static extern IntPtr objc_getClass(string className);

    [DllImport("/usr/lib/libobjc.dylib")]
    private static extern IntPtr sel_registerName(string selector);

    [DllImport("/usr/lib/libobjc.dylib", EntryPoint = "objc_msgSend")]
    private static extern long objc_msgSend_long(IntPtr receiver, IntPtr selector, IntPtr arg);

    [DllImport("/usr/lib/libobjc.dylib", EntryPoint = "objc_msgSend")]
    private static extern void objc_msgSend_void_id_id(IntPtr receiver, IntPtr selector, IntPtr arg1, IntPtr arg2);

    [DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    private static extern IntPtr CFStringCreateWithCString(IntPtr allocator,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string str, uint encoding);

    [DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    private static extern void CFRelease(IntPtr cf);

    [DllImport("/usr/lib/libSystem.dylib")]
    private static extern IntPtr dlopen(string? path, int mode);

    [DllImport("/usr/lib/libSystem.dylib")]
    private static extern IntPtr dlsym(IntPtr handle, string symbol);

    const uint kCFStringEncodingUTF8 = 0x08000100;
    const int RTLD_NOW = 2;

    // AVAuthorizationStatus
    const long NotDetermined = 0;
    const long Authorized = 3;

    // Block support for calling requestAccessForMediaType:completionHandler:
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void BlockInvokeFunction(IntPtr block, byte granted);

    private static BlockInvokeFunction? _blockCallback;
    private static ManualResetEventSlim? _permissionEvent;
    private static bool _permissionGranted;

    /// <summary>
    /// Checks microphone authorization status. If not yet determined,
    /// explicitly requests permission and waits for the user's response.
    /// </summary>
    public static void EnsureMicrophoneAccess()
    {
        if (!OperatingSystem.IsMacOS()) return;

        try
        {
            LoadAVFoundation();

            var status = GetAuthorizationStatus();
            if (status == Authorized)
            {
                Console.WriteLine("[Mac] Microphone access granted");
            }
            else if (status == NotDetermined)
            {
                Console.WriteLine("[Mac] Requesting microphone permission...");
                RequestMicrophonePermission();
            }
            else
            {
                Console.WriteLine("[Mac] ⚠ Microphone access denied.");
                Console.WriteLine("[Mac] Grant access in: System Settings → Privacy & Security → Microphone");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Mac] Permission check failed: {ex.Message}");
        }
    }

    public static bool IsMicrophoneAuthorized()
    {
        if (!OperatingSystem.IsMacOS()) return true;
        try
        {
            LoadAVFoundation();
            return GetAuthorizationStatus() == Authorized;
        }
        catch { return true; }
    }

    private static void LoadAVFoundation()
    {
        dlopen("/System/Library/Frameworks/AVFoundation.framework/AVFoundation", RTLD_NOW);
    }

    private static long GetAuthorizationStatus()
    {
        var cls = objc_getClass("AVCaptureDevice");
        if (cls == IntPtr.Zero)
        {
            Console.WriteLine("[Mac] AVCaptureDevice class not found - AVFoundation may not be loaded");
            return NotDetermined;
        }
        var sel = sel_registerName("authorizationStatusForMediaType:");
        var audioType = CFStringCreateWithCString(IntPtr.Zero, "soun", kCFStringEncodingUTF8);
        try
        {
            return objc_msgSend_long(cls, sel, audioType);
        }
        finally
        {
            if (audioType != IntPtr.Zero) CFRelease(audioType);
        }
    }

    private static void RequestMicrophonePermission()
    {
        _permissionEvent = new ManualResetEventSlim(false);
        _blockCallback = OnPermissionResult;

        var cls = objc_getClass("AVCaptureDevice");
        if (cls == IntPtr.Zero)
        {
            Console.WriteLine("[Mac] AVCaptureDevice not available, cannot request permission");
            return;
        }

        var sel = sel_registerName("requestAccessForMediaType:completionHandler:");
        var audioType = CFStringCreateWithCString(IntPtr.Zero, "soun", kCFStringEncodingUTF8);
        var blockPtr = CreateBlock(_blockCallback);

        try
        {
            objc_msgSend_void_id_id(cls, sel, audioType, blockPtr);

            if (_permissionEvent.Wait(TimeSpan.FromSeconds(60)))
            {
                Console.WriteLine(_permissionGranted
                    ? "[Mac] Microphone access granted by user"
                    : "[Mac] ⚠ Microphone access denied by user");

                if (!_permissionGranted)
                    Console.WriteLine("[Mac] Grant access in: System Settings → Privacy & Security → Microphone");
            }
            else
            {
                Console.WriteLine("[Mac] Microphone permission request timed out");
            }
        }
        finally
        {
            if (audioType != IntPtr.Zero) CFRelease(audioType);
        }
    }

    private static void OnPermissionResult(IntPtr block, byte granted)
    {
        _permissionGranted = granted != 0;
        _permissionEvent?.Set();
    }

    private static IntPtr CreateBlock(BlockInvokeFunction callback)
    {
        // Get _NSConcreteGlobalBlock isa - block won't be retained/released by runtime
        var globalBlockIsa = dlsym(new IntPtr(-2), "_NSConcreteGlobalBlock");

        // Block descriptor: { reserved (8 bytes), size (8 bytes) }
        var descriptor = Marshal.AllocHGlobal(16);
        Marshal.WriteInt64(descriptor, 0, 0);   // reserved
        Marshal.WriteInt64(descriptor, 8, 32);  // sizeof(BlockLiteral)

        // Block literal: { isa, flags, reserved, invoke, descriptor }
        // Layout on 64-bit: isa(8) + flags(4) + reserved(4) + invoke(8) + descriptor(8) = 32 bytes
        var block = Marshal.AllocHGlobal(32);
        Marshal.WriteIntPtr(block, 0, globalBlockIsa);                                    // isa
        Marshal.WriteInt32(block, 8, 1 << 28);                                            // flags = BLOCK_IS_GLOBAL
        Marshal.WriteInt32(block, 12, 0);                                                 // reserved
        Marshal.WriteIntPtr(block, 16, Marshal.GetFunctionPointerForDelegate(callback));  // invoke
        Marshal.WriteIntPtr(block, 24, descriptor);                                       // descriptor

        return block;
    }
}
