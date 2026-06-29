//! Phase-0 spikes that seed the engine crate (Game Capture Engine Scaffolding,
//! Stage B). Each is a gated `spike <name>` subcommand. Linux: `interop` (B1) —
//! resolves the GL-vs-CUDA NVENC-input fork. Windows: `d3d11wgc` (Game Capture
//! SF0 feasibility gate — WGC -> D3D11 -> NVENC DirectX register-direct).

#[cfg(target_os = "linux")]
pub mod interop;
#[cfg(windows)]
pub mod d3d11wgc;
