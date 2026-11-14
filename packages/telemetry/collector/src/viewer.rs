//! The trace viewer's files (`--viewer <dir>`), served at the origin root beside the API.
//!
//! The directory is read once, at start: its `index.html` and the regular files under `assets/`,
//! at most `ASSET_DEPTH` directories deep. A request is looked up by name in that table and
//! answered from memory, so nothing a request carries ever becomes a path on disk.
//!
//! The directory is part of the installation and is trusted: whoever can write to it already
//! decides what the viewer serves. Reading it guards against a directory assembled by mistake, not
//! against someone changing it while the collector starts. A symbolic link anywhere inside it, and
//! anything that is not a regular file or a directory, ends the start; each file is opened without
//! following a final symbolic link, so no check stands apart from the open. A hard link is a regular
//! file and is served, and the directory itself may be reached through a link.
//!
//! What is read is bounded before it is allocated: at most `VIEWER_ENTRIES` files and directories,
//! `index.html` and `assets` included, and at most `VIEWER_BYTES` in all, counting each file's
//! contents, each entry's stored path (its whole path under `assets/`) and `ENTRY_BYTES` for each
//! entry. A directory past either bound ends the start, before the data directory is touched.

use std::collections::HashMap;
use std::path::Path;

use axum::body::{Body, Bytes};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

/// The most the viewer's files may hold in all, names and entries counted. The build is about
/// 0.6 MB in three files.
pub const VIEWER_BYTES: u64 = 16 * 1024 * 1024;
/// The most files and directories the viewer's directory may hold. The build has three files.
pub const VIEWER_ENTRIES: usize = 4096;
/// What one entry of the table costs beyond its name and contents: its map slot, key and value.
const ENTRY_BYTES: u64 = 256;
/// How deep `assets/` may nest. Vite writes it flat.
const ASSET_DEPTH: usize = 4;

pub struct Viewer {
    index: Bytes,
    /// By their path under `assets/`, with `/` between names.
    assets: HashMap<String, Asset>,
}

struct Asset {
    bytes: Bytes,
    content_type: &'static str,
}

impl Viewer {
    /// Read the viewer's files from `directory`, or say why they cannot be served.
    pub fn load(directory: &Path) -> Result<Viewer, String> {
        let mut total = 0u64;
        let mut count = 0usize;
        // `index.html` and the `assets` directory are entries like any other.
        admit(&mut count, &mut total, "index.html".len())?;
        let index = read_file(&directory.join("index.html"), &mut total)?;
        let mut assets = HashMap::new();
        let root = directory.join("assets");
        match std::fs::symlink_metadata(&root) {
            Ok(metadata) if metadata.is_dir() => {
                admit(&mut count, &mut total, "assets".len())?;
                read_assets(&root, "", 0, &mut assets, &mut total, &mut count)?
            }
            Ok(_) => return Err(format!("{} is not a directory", root.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot read {}: {error}", root.display())),
        }
        Ok(Viewer {
            index: Bytes::from(index),
            assets,
        })
    }

    /// `index.html`, for the viewer's own routes; the browser's router takes it from there.
    pub fn index(&self) -> Response {
        file(self.index.clone(), "text/html; charset=utf-8", "no-cache")
    }

    /// A file under `assets/`, or 404. Vite names every one by a hash of its content, so a name
    /// always means the same bytes and the browser may keep it.
    pub fn asset(&self, name: &str) -> Response {
        match self.assets.get(name) {
            Some(asset) => file(
                asset.bytes.clone(),
                asset.content_type,
                "public, max-age=31536000, immutable",
            ),
            None => (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({ "error": "Not found" })),
            )
                .into_response(),
        }
    }
}

fn file(bytes: Bytes, content_type: &'static str, cache: &'static str) -> Response {
    let mut response = Body::from(bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// The open flags that refuse a symbolic link as the final component, and keep a FIFO or a device
/// from blocking the open; the handle's own metadata then says what was opened.
#[cfg(unix)]
fn open_regular(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const NO_FOLLOW: i32 = 0o400_000;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const NON_BLOCK: i32 = 0o4000;
    #[cfg(target_vendor = "apple")]
    const NO_FOLLOW: i32 = 0x0100;
    #[cfg(target_vendor = "apple")]
    const NON_BLOCK: i32 = 0x0004;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(NO_FOLLOW | NON_BLOCK)
        .open(path)
}

/// On Windows the link itself is opened (`FILE_FLAG_OPEN_REPARSE_POINT`), and its metadata says so.
#[cfg(windows)]
fn open_regular(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

/// Counts one more entry against `VIEWER_ENTRIES`, and its stored name of `name_bytes` and
/// `ENTRY_BYTES` against `VIEWER_BYTES`, before either is allocated.
fn admit(count: &mut usize, total: &mut u64, name_bytes: usize) -> Result<(), String> {
    *count += 1;
    if *count > VIEWER_ENTRIES {
        return Err(format!(
            "the viewer's directory holds more than {VIEWER_ENTRIES} files and directories"
        ));
    }
    charge(total, ENTRY_BYTES + name_bytes as u64)
}

/// Counts `bytes` against `VIEWER_BYTES`, before they are allocated.
fn charge(total: &mut u64, bytes: u64) -> Result<(), String> {
    *total = total.saturating_add(bytes);
    if *total > VIEWER_BYTES {
        return Err(format!(
            "the viewer's files hold more than {VIEWER_BYTES} bytes, names and entries counted"
        ));
    }
    Ok(())
}

/// One regular file, opened without following a link, read only up to what is left of
/// `VIEWER_BYTES`: a file that grows while it is read still cannot take more.
fn read_file(path: &Path, total: &mut u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let unreadable = |error: std::io::Error| format!("cannot read {}: {error}", path.display());
    let file = open_regular(path).map_err(|error| {
        // ELOOP on Linux and macOS: the final component is a symbolic link.
        if error.raw_os_error() == Some(40) || error.raw_os_error() == Some(62) {
            format!("{} is a symbolic link", path.display())
        } else {
            unreadable(error)
        }
    })?;
    let kind = file.metadata().map_err(unreadable)?.file_type();
    if kind.is_symlink() {
        return Err(format!("{} is a symbolic link", path.display()));
    }
    if !kind.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let left = VIEWER_BYTES.saturating_sub(*total);
    let mut bytes = Vec::new();
    file.take(left + 1)
        .read_to_end(&mut bytes)
        .map_err(unreadable)?;
    charge(total, bytes.len() as u64)?;
    Ok(bytes)
}

fn read_assets(
    directory: &Path,
    prefix: &str,
    depth: usize,
    assets: &mut HashMap<String, Asset>,
    total: &mut u64,
    count: &mut usize,
) -> Result<(), String> {
    if depth > ASSET_DEPTH {
        return Err(format!("{} nests too deep", directory.display()));
    }
    let entries = std::fs::read_dir(directory)
        .map_err(|error| format!("cannot read {}: {error}", directory.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("cannot read {}: {error}", directory.display()))?;
        let path = entry.path();
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| format!("{} is not named in UTF-8", path.display()))?;
        // The key the table stores for it: its whole path under `assets/`.
        admit(count, total, prefix.len() + name.len())?;
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        let key = format!("{prefix}{name}");
        if metadata.is_dir() {
            read_assets(&path, &format!("{key}/"), depth + 1, assets, total, count)?;
        } else if metadata.is_file() {
            let bytes = read_file(&path, total)?;
            assets.insert(
                key,
                Asset {
                    bytes: Bytes::from(bytes),
                    content_type: content_type(&name),
                },
            );
        } else {
            return Err(format!(
                "{} is not a regular file or directory",
                path.display()
            ));
        }
    }
    Ok(())
}

fn content_type(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map_or("", |(_, extension)| extension);
    match extension.to_ascii_lowercase().as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
