//! Minimal CUDA Driver API surface — just enough to obtain a `CUcontext` to give
//! NVENC as its device (`NV_ENC_DEVICE_TYPE_CUDA`). `dlopen` of `libcuda.so.1`,
//! nothing linked. A bring-up / self-test helper (Encode SF2); the engine's real
//! dmabuf input path (GL vs CUDA) is decided by the Phase-0 interop spike (B1),
//! independent of this.

use crate::NvencError;
use libloading::Library;

pub type CUresult = i32;
pub type CUdevice = i32;
/// Opaque CUDA context handle (`CUcontext`).
pub type CUcontext = *mut std::ffi::c_void;

const CUDA_SUCCESS: CUresult = 0;

type CuInit = unsafe extern "C" fn(u32) -> CUresult;
type CuDeviceGet = unsafe extern "C" fn(*mut CUdevice, i32) -> CUresult;
type CuCtxCreate = unsafe extern "C" fn(*mut CUcontext, u32, CUdevice) -> CUresult;
type CuCtxDestroy = unsafe extern "C" fn(CUcontext) -> CUresult;

/// A CUDA context on device 0, with `libcuda.so.1` kept loaded for its lifetime.
pub struct CudaContext {
    _lib: Library,
    ctx: CUcontext,
    destroy: CuCtxDestroy,
}

impl CudaContext {
    /// `cuInit(0)` + `cuDeviceGet(0)` + `cuCtxCreate` on device 0.
    pub fn new() -> Result<Self, NvencError> {
        // SAFETY: dlopen of the driver lib + the documented CUDA Driver API ABI.
        // Fn pointers are copied out of their Symbols (the temporary Symbol is
        // dropped at the end of each `let`), so nothing borrows `lib` when it is
        // moved into the returned value, which keeps the lib loaded.
        unsafe {
            let lib = Library::new("libcuda.so.1").map_err(|_| NvencError::DriverMissing)?;
            let cu_init = *lib
                .get::<CuInit>(b"cuInit\0")
                .map_err(|_| NvencError::DriverMissing)?;
            let cu_device_get = *lib
                .get::<CuDeviceGet>(b"cuDeviceGet\0")
                .map_err(|_| NvencError::DriverMissing)?;
            // The ABI symbols are the `_v2` variants.
            let cu_ctx_create = *lib
                .get::<CuCtxCreate>(b"cuCtxCreate_v2\0")
                .map_err(|_| NvencError::DriverMissing)?;
            let destroy = *lib
                .get::<CuCtxDestroy>(b"cuCtxDestroy_v2\0")
                .map_err(|_| NvencError::DriverMissing)?;

            if cu_init(0) != CUDA_SUCCESS {
                return Err(NvencError::Unsupported);
            }
            let mut dev: CUdevice = 0;
            if cu_device_get(&mut dev, 0) != CUDA_SUCCESS {
                return Err(NvencError::DriverMissing);
            }
            let mut ctx: CUcontext = std::ptr::null_mut();
            if cu_ctx_create(&mut ctx, 0, dev) != CUDA_SUCCESS {
                return Err(NvencError::Lost);
            }
            Ok(Self { _lib: lib, ctx, destroy })
        }
    }

    /// The raw `CUcontext` to hand to NVENC's `device` field.
    pub fn as_ptr(&self) -> CUcontext {
        self.ctx
    }
}

impl Drop for CudaContext {
    fn drop(&mut self) {
        // SAFETY: single destroy of a live context on teardown.
        unsafe {
            let _ = (self.destroy)(self.ctx);
        }
    }
}
