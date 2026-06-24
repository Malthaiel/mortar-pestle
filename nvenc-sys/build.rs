use std::env;
use std::path::PathBuf;

// Generate Rust declarations from the vendored MIT nv-codec-headers
// `nvEncodeAPI.h` (NVENCAPI 13.0). Declarations only — nothing is linked; the
// NVENC entry points are dlopen'd from the driver at runtime (see lib.rs).
fn main() {
    let inc = "vendor/nv-codec-headers/include";
    let header = format!("{inc}/ffnvcodec/nvEncodeAPI.h");
    println!("cargo:rerun-if-changed={header}");
    println!("cargo:rerun-if-changed=build.rs");

    let bindings = bindgen::Builder::default()
        .header(&header)
        .clang_arg(format!("-I{inc}"))
        // Everything declared in nvEncodeAPI.h (types, enums + their consts,
        // function decls, codec/profile GUIDs) — excludes system headers
        // (stdint/stddef), which keeps the bindings NVENC-only.
        .allowlist_file(".*nvEncodeAPI\\.h")
        // Plain integer consts — no rustified-enum UB when the driver returns a
        // status value outside the known set; the safe wrapper adds the typing.
        .default_enum_style(bindgen::EnumVariation::Consts)
        .layout_tests(false)
        .generate()
        .expect("bindgen failed over nvEncodeAPI.h");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out.join("nvenc_bindings.rs"))
        .expect("write nvenc_bindings.rs");
}
