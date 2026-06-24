// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // webkit2gtk on Fedora/Nobara Wayland sessions hits "Gdk Error 71 (Protocol
    // error) dispatching to Wayland" and crash-loops; native Wayland + DMA-BUF
    // were both re-tested on WebKitGTK 2.52 (2026-05) and still fail (XWayland
    // GBM buffer alloc returns "Invalid argument"; native Wayland throws Error
    // 71). So we force XWayland + disable the DMA-BUF renderer + disable hardware
    // compositing — this is the only stable config on this NVIDIA box, at the
    // cost of CPU-composited (non-accelerated) CSS animations. They must all be
    // set before any GTK code runs. Revisit if the NVIDIA/WebKitGTK stack improves.
    //
    // KNOWN DEFERRED ISSUE: the in-app browser's video GL sink SIGSEGVs in the
    // NVIDIA EGL driver when YouTube *theater mode* reconfigures the pipeline
    // (libnvidia-eglcore via WebCore::PlatformDisplay::clearGLContexts). Forcing
    // the software video sink (WEBKIT_GST_DISABLE_GL_SINK / _DMABUF_SINK_DISABLED)
    // and pinning EGL to Mesa were each tried — neither stopped the theater-mode
    // crash, and both only degraded all video — so neither is carried. Normal and
    // fullscreen playback are stable; theater mode is the lone trigger. Deferred,
    // tracked in Update Queue.
    #[cfg(target_os = "linux")]
    {
        for (key, val) in [
            ("GDK_BACKEND", "x11"),
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
        ] {
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, val);
            }
        }
    }
    app_lib::run();
}
