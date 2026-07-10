// ── Creative LUT storage (Color Grading SF7) — split from mod.rs, plan 026 B3.
// Content-addressed .cube import/read under <project>/luts/. The `pub use lut::*;`
// shim in mod.rs keeps the vedit_lut_* command paths + ACL entries resolving.

use std::fs;

use serde::Serialize;

use crate::commands::vault::VaultError;
use super::{canonical_file, project_paths, projects_root};

// ── Creative LUT storage (Color Grading SF7) ───────────────────────────────
// LUTs are content-addressed under <project>/luts/<sha1-16>.cube: import
// hashes the TEXT, so re-importing the same file from any path dedupes to one
// copy, and grades persist a project-relative `file` that survives project
// folder moves. Reads validate the filename shape instead of canonicalizing —
// the grade is the only caller and never holds a user path.

const LUT_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LutImportOut {
    pub file: String,
    pub name: String,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LutReadOut {
    pub text: String,
}

#[tauri::command]
pub async fn vedit_lut_import(name: String, path: String) -> Result<LutImportOut, VaultError> {
    use sha1::{Digest, Sha1};
    let (clean, _) = project_paths(&name)?;
    let src = canonical_file(&path)?;
    let meta = fs::metadata(&src).map_err(|e| VaultError::Io(format!("lut stat: {e}")))?;
    if meta.len() > LUT_MAX_BYTES {
        return Err(VaultError::Invalid("LUT exceeds the 16 MB cap".into()));
    }
    let text = fs::read_to_string(&src)
        .map_err(|_| VaultError::Invalid("not a text .cube file (binary or non-UTF-8)".into()))?;
    if !text
        .lines()
        .any(|l| l.trim_start().starts_with("LUT_3D_SIZE"))
    {
        return Err(VaultError::Invalid(
            "missing LUT_3D_SIZE — only 3D .cube LUTs are supported".into(),
        ));
    }
    let digest = Sha1::digest(text.as_bytes());
    let mut hash16 = String::with_capacity(16);
    for b in digest.iter().take(8) {
        hash16.push_str(&format!("{b:02x}"));
    }
    let file = format!("{hash16}.cube");
    let dir = projects_root().join(&clean).join("luts");
    fs::create_dir_all(&dir).map_err(|e| VaultError::Io(format!("luts dir: {e}")))?;
    let dst = dir.join(&file);
    if !dst.exists() {
        fs::write(&dst, &text).map_err(|e| VaultError::Io(format!("lut write: {e}")))?;
    }
    let display_name = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| hash16.clone());
    Ok(LutImportOut {
        file,
        name: display_name,
        text,
    })
}

fn valid_lut_file(file: &str) -> bool {
    file.len() == 21
        && file.ends_with(".cube")
        && file.as_bytes()[..16]
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[tauri::command]
pub fn vedit_lut_read(name: String, file: String) -> Result<LutReadOut, VaultError> {
    let (clean, _) = project_paths(&name)?;
    if !valid_lut_file(&file) {
        return Err(VaultError::Invalid(format!("bad LUT filename: {file}")));
    }
    let p = projects_root().join(&clean).join("luts").join(&file);
    let text = fs::read_to_string(&p).map_err(|_| VaultError::NotFound(file))?;
    Ok(LutReadOut { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lut_filename_validation() {
        assert!(valid_lut_file("0123456789abcdef.cube"));
        assert!(!valid_lut_file("0123456789ABCDEF.cube"));
        assert!(!valid_lut_file("0123456789abcd.cube"));
        assert!(!valid_lut_file("../23456789abcdef.cube"));
        assert!(!valid_lut_file("0123456789abcdef.CUBE"));
    }
}
