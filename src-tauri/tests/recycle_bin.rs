//! Characterization tests for the recycle-bin's app-free primitives — the
//! functions that carry the silent-data-loss risk (move_path is "the one place
//! silent data loss could occur", recycle_bin.rs:213). These PIN current
//! behavior; they are not driving recycle_bin_restore (blocked by the
//! AppHandle<Wry> wall — see plan 021 Maintenance notes).

mod common;

use std::fs;
use app_lib::commands::recycle_bin::{
    copy_dir_recursive, dir_stats, leaf_name, move_path, parent_dir, resolve_target, suggested_rename,
};
use app_lib::commands::vault::VaultError;

// 1. move_path: same-device file move is byte-identical + unlinks the source.
#[test]
fn move_path_moves_file_bytes_identically() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("a.bin");
    let dst = dir.path().join("nested/b.bin"); // parent does not exist yet
    let bytes = b"\x00\x01payload\xff\xfe";
    fs::write(&src, bytes).unwrap();

    move_path(&src, &dst).unwrap();

    assert!(!src.exists(), "source must be unlinked after a move");
    assert_eq!(fs::read(&dst).unwrap(), bytes, "bytes must survive the move");
}

// 2. move_path: a whole directory subtree moves intact.
#[test]
fn move_path_moves_directory_tree() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("tree");
    fs::create_dir_all(src.join("sub")).unwrap();
    fs::write(src.join("root.txt"), b"r").unwrap();
    fs::write(src.join("sub/leaf.txt"), b"l").unwrap();
    let dst = dir.path().join("moved");

    move_path(&src, &dst).unwrap();

    assert!(!src.exists(), "source dir must be gone");
    assert_eq!(fs::read_to_string(dst.join("root.txt")).unwrap(), "r");
    assert_eq!(fs::read_to_string(dst.join("sub/leaf.txt")).unwrap(), "l");
}

// 3. copy_dir_recursive clones a nested tree (leaves the source in place).
#[test]
fn copy_dir_recursive_clones_nested_tree() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src");
    fs::create_dir_all(src.join("a/b")).unwrap();
    fs::write(src.join("a/b/x.txt"), b"deep").unwrap();
    let dst = dir.path().join("dst");

    copy_dir_recursive(&src, &dst).unwrap();

    assert!(src.join("a/b/x.txt").exists(), "copy must not remove the source");
    assert_eq!(fs::read_to_string(dst.join("a/b/x.txt")).unwrap(), "deep");
}

// 4. suggested_rename: ext / no-ext / dotfile (empty stem) / multi-dot.
#[test]
fn suggested_rename_covers_all_label_shapes() {
    assert_eq!(suggested_rename("Notes.md"), "Notes (restored).md");
    assert_eq!(suggested_rename("folder"), "folder (restored)");
    // rsplit_once('.') on ".gitignore" => ("", "gitignore"); empty stem falls to
    // the catch-all arm, so no ".gitignore.(restored)" corruption.
    assert_eq!(suggested_rename(".gitignore"), ".gitignore (restored)");
    assert_eq!(suggested_rename("archive.tar.gz"), "archive.tar (restored).gz");
}

// 5. resolve_target rejects a `..` traversal component BEFORE any root lookup
//    (no env needed — the guard is the first statement).
#[test]
fn resolve_target_rejects_dotdot_traversal() {
    let res = resolve_target(&None, "a/../b");
    assert!(
        matches!(res, Err(VaultError::Invalid(ref m)) if m.contains("traversal")),
        "expected an Invalid(\"…traversal…\") error, got {res:?}"
    );
}

// 6. resolve_target joins a clean relative path under AGENTIC_VAULT_ROOT.
#[test]
fn resolve_target_joins_relative_under_vault_root() {
    let _g = common::env_lock();
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("AGENTIC_VAULT_ROOT", dir.path().display().to_string());

    let abs = resolve_target(&None, "sub/file.md").unwrap();

    // Normalize separators so the assertion is Windows-safe (canonicalize may add
    // a \\?\ prefix and backslashes).
    let s = abs.to_string_lossy().replace('\\', "/");
    assert!(s.ends_with("sub/file.md"), "resolved path was {s}");
}

// 7. dir_stats returns (recursive file count, total bytes).
#[test]
fn dir_stats_counts_files_and_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    fs::create_dir_all(root.join("art")).unwrap();
    fs::write(root.join("track1.txt"), b"12345").unwrap();      // 5 bytes
    fs::write(root.join("art/cover.txt"), b"abc").unwrap();     // 3 bytes

    let (count, size) = dir_stats(&root);

    assert_eq!(count, 2, "two files across the subtree");
    assert_eq!(size, 8, "5 + 3 bytes");
}

// 8. leaf_name / parent_dir edge cases.
#[test]
fn leaf_name_and_parent_dir_edges() {
    assert_eq!(leaf_name("a/b/c.md"), "c.md");
    assert_eq!(leaf_name("top.md"), "top.md");
    assert_eq!(parent_dir("a/b/c.md"), Some("a/b".to_string()));
    assert_eq!(parent_dir("top.md"), None); // no slash → no parent
}
