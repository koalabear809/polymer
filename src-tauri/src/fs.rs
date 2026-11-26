//! File system commands used by file buffers.
//!
//! Paths arrive from JS with forward slashes; Rust accepts those on every platform.
//! Text is UTF-8. CRLF files are converted to LF on read and the caller is told, so it
//! can write them back with CRLF.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    text: String,
    crlf: bool,
    mtime_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    mtime_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    exists: bool,
    is_dir: bool,
    is_file: bool,
    mtime_ms: Option<u64>,
}

fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn err(path: &Path, e: std::io::Error) -> String {
    format!("{}: {}", path.display(), e)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<FileContents, String> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| err(&p, e))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{}: not valid UTF-8 (binary file?)", p.display()))?;
    let crlf = text.contains("\r\n");
    let text = if crlf { text.replace("\r\n", "\n") } else { text };
    let mtime = fs::metadata(&p).ok().as_ref().and_then(mtime_ms);
    Ok(FileContents { text, crlf, mtime_ms: mtime })
}

/// Write atomically: write a temp file next to the target, then rename over it.
/// Symlinks are followed (the link target is replaced) and permissions are preserved.
#[tauri::command]
pub fn write_text_file(path: String, text: String, crlf: bool) -> Result<Option<u64>, String> {
    let requested = PathBuf::from(&path);
    let target = fs::canonicalize(&requested).unwrap_or_else(|_| requested.clone());
    let dir = target.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = dir.join(format!(".{}.polymer-tmp", name));

    let data = if crlf { text.replace('\n', "\r\n") } else { text };
    let existing = fs::metadata(&target).ok();
    {
        let mut f = fs::File::create(&tmp).map_err(|e| err(&tmp, e))?;
        f.write_all(data.as_bytes()).map_err(|e| err(&tmp, e))?;
        f.sync_all().map_err(|e| err(&tmp, e))?;
    }
    if let Some(meta) = &existing {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(err(&target, e));
    }
    Ok(fs::metadata(&target).ok().as_ref().and_then(mtime_ms))
}

/// Raw bytes (returned as an ArrayBuffer in JS, without JSON encoding).
#[tauri::command]
pub fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| err(&p, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let p = PathBuf::from(&path);
    let mut out = Vec::new();
    for entry in fs::read_dir(&p).map_err(|e| err(&p, e))? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let is_symlink = entry.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        // Follow symlinks so a link to a directory reads as a directory.
        let meta = fs::metadata(entry.path()).ok();
        out.push(DirEntry {
            name,
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            is_symlink,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime_ms: meta.as_ref().and_then(mtime_ms),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub fn path_info(path: String) -> PathInfo {
    match fs::metadata(&path) {
        Ok(m) => PathInfo { exists: true, is_dir: m.is_dir(), is_file: m.is_file(), mtime_ms: mtime_ms(&m) },
        Err(_) => PathInfo { exists: false, is_dir: false, is_file: false, mtime_ms: None },
    }
}

#[tauri::command]
pub fn make_directory(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    fs::create_dir_all(&p).map_err(|e| err(&p, e))
}

#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    fs::canonicalize(&p)
        .map(|c| c.to_string_lossy().replace('\\', "/"))
        .map_err(|e| err(&p, e))
}

/// Delete a file, symlink or (with `recursive`) a directory tree.
#[tauri::command]
pub fn delete_path(path: String, recursive: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let meta = fs::symlink_metadata(&p).map_err(|e| err(&p, e))?;
    if meta.is_dir() {
        if recursive { fs::remove_dir_all(&p) } else { fs::remove_dir(&p) }.map_err(|e| err(&p, e))
    } else {
        fs::remove_file(&p).map_err(|e| err(&p, e))
    }
}

/// Rename or move. Fails rather than overwrite an existing target.
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    let (f, t) = (PathBuf::from(&from), PathBuf::from(&to));
    if fs::symlink_metadata(&t).is_ok() {
        return Err(format!("{} already exists", t.display()));
    }
    fs::rename(&f, &t).map_err(|e| err(&f, e))
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

/// Copy a file or a directory tree. Fails rather than overwrite an existing target.
#[tauri::command]
pub fn copy_path(from: String, to: String) -> Result<(), String> {
    let (f, t) = (PathBuf::from(&from), PathBuf::from(&to));
    if fs::symlink_metadata(&t).is_ok() {
        return Err(format!("{} already exists", t.display()));
    }
    copy_recursive(&f, &t).map_err(|e| err(&f, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_rename_delete_round_trip() {
        let base = std::env::temp_dir().join(format!("polymer-fs-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("a/sub")).unwrap();
        fs::write(base.join("a/sub/f.txt"), "hi").unwrap();
        let s = |p: &str| base.join(p).to_string_lossy().to_string();
        copy_path(s("a"), s("b")).unwrap();
        assert_eq!(fs::read_to_string(base.join("b/sub/f.txt")).unwrap(), "hi");
        assert!(copy_path(s("a"), s("b")).is_err(), "no overwrite");
        rename_path(s("b"), s("c")).unwrap();
        assert!(base.join("c/sub/f.txt").exists() && !base.join("b").exists());
        assert!(rename_path(s("a"), s("c")).is_err(), "no overwrite");
        assert!(delete_path(s("c"), false).is_err(), "non-empty dir needs recursive");
        delete_path(s("c"), true).unwrap();
        delete_path(s("a/sub/f.txt"), false).unwrap();
        assert!(!base.join("c").exists() && !base.join("a/sub/f.txt").exists());
        let listed = list_directory(s("a")).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].mtime_ms.is_some());
        fs::remove_dir_all(&base).unwrap();
    }
}
