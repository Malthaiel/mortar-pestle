//! Shield content-filter — the entire `unsafe` FFI surface over `webkit2gtk-sys`.
//!
//! The safe `webkit2gtk 2.0.2` bindings leave `WebKitUserContentFilterStore` and
//! `webkit_user_content_manager_add_filter` unbound (commented out as "Ignored"
//! in `user_content_manager.rs`), so WebKit's content-blocker engine is only
//! reachable through raw FFI. This module compiles content-blocker JSON into a
//! `WebKitUserContentFilter` via the store (async) and attaches the compiled
//! filter to a tab's `UserContentManager`.
//!
//! Everything here runs on the GTK main thread (GTK objects are `!Send`):
//! pointers live in thread-locals and never cross threads. Compiled filters are
//! transfer-full and owned for the process lifetime (one set, created once,
//! never unref'd), so the raw pointers stay valid for as long as any tab lives.

use std::cell::{Cell, RefCell};
use std::ffi::CString;
use std::path::Path;

use webkit2gtk::glib::translate::{from_glib_full, ToGlibPtr};
use webkit2gtk::{ffi, gio, glib, UserContentManager};

thread_local! {
    /// Compiled, ready content-filters (transfer-full pointers we own for the
    /// process lifetime). Attached to every tab's UCM when blocking is on.
    static FILTERS: RefCell<Vec<*mut ffi::WebKitUserContentFilter>> =
        const { RefCell::new(Vec::new()) };
    /// Invoked on the GTK main thread each time a filter finishes compiling, so
    /// the browser can (re)attach the ready set onto already-open tabs.
    static ON_READY: Cell<Option<fn()>> = const { Cell::new(None) };
    /// Keep each JSON source `Bytes` alive for the process: WebKit refs it for
    /// the async compile, and this removes any lifetime question entirely.
    static KEEPALIVE: RefCell<Vec<glib::Bytes>> = const { RefCell::new(Vec::new()) };
}

/// Kick off an async compile of `json` (identified by `id`) into a content
/// filter cached under `dir`. On completion the filter is stored and `on_ready`
/// runs on the GTK main thread. Call once per id during `embed`.
pub fn compile(dir: &Path, id: &str, json: &str, on_ready: fn()) {
    ON_READY.with(|c| c.set(Some(on_ready)));
    let Ok(dir_c) = CString::new(dir.to_string_lossy().as_bytes()) else {
        return;
    };
    let Ok(id_c) = CString::new(id) else {
        return;
    };
    let bytes = glib::Bytes::from(json.as_bytes());
    let bytes_ptr =
        ToGlibPtr::<*const glib::ffi::GBytes>::to_glib_none(&bytes).0 as *mut glib::ffi::GBytes;
    unsafe {
        let store = ffi::webkit_user_content_filter_store_new(dir_c.as_ptr());
        if store.is_null() {
            log::error!("blocker: content-filter store_new failed");
            return;
        }
        ffi::webkit_user_content_filter_store_save(
            store,
            id_c.as_ptr(),
            bytes_ptr,
            std::ptr::null_mut(),
            Some(save_done),
            std::ptr::null_mut(),
        );
    }
    KEEPALIVE.with(|c| c.borrow_mut().push(bytes));
}

/// `GAsyncReadyCallback` trampoline — runs on the GTK main thread when a
/// `store.save` completes. `source` is the store the op was started on.
unsafe extern "C" fn save_done(
    source: *mut glib::gobject_ffi::GObject,
    result: *mut gio::ffi::GAsyncResult,
    _user_data: glib::ffi::gpointer,
) {
    let store = source as *mut ffi::WebKitUserContentFilterStore;
    let mut error: *mut glib::ffi::GError = std::ptr::null_mut();
    let filter = ffi::webkit_user_content_filter_store_save_finish(store, result, &mut error);
    if !error.is_null() {
        let err: glib::Error = from_glib_full(error);
        log::error!("blocker: content-filter compile failed: {err}");
        return;
    }
    if filter.is_null() {
        log::error!("blocker: content-filter compile returned null");
        return;
    }
    FILTERS.with(|f| f.borrow_mut().push(filter));
    log::info!("blocker: a content-filter compiled + ready");
    if let Some(cb) = ON_READY.with(Cell::get) {
        cb();
    }
}

/// Attach every ready content-filter to `ucm`. Pair with
/// `UserContentManagerExt::remove_all_filters` on reattach to stay idempotent.
pub fn add_ready_filters(ucm: &UserContentManager) {
    let ucm_ptr =
        ToGlibPtr::<*const ffi::WebKitUserContentManager>::to_glib_none(ucm).0 as *mut _;
    FILTERS.with(|f| {
        for &filter in f.borrow().iter() {
            unsafe { ffi::webkit_user_content_manager_add_filter(ucm_ptr, filter) };
        }
    });
}
