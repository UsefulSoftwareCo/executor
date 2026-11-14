//! What the test files share: scratch directories that a killed run does not leave behind.

use std::path::PathBuf;
use std::sync::Once;

/// Every scratch directory this suite makes starts with this, and ends with its process's id.
const PREFIX: &str = "executor-collector-";

/// A new, empty scratch directory `executor-collector-{kind}-{name}-{pid}`. The first in each
/// test process first removes those a run that is no longer running left behind (one killed
/// before its directories' `Drop` ran).
pub fn directory(kind: &str, name: &str) -> PathBuf {
    within(std::env::temp_dir(), kind, name)
}

/// As `directory`, under the build's own temporary directory (`target/tmp`) rather than the
/// system's, for a test whose files pass 100 MB.
#[allow(dead_code)]
pub fn large_directory(kind: &str, name: &str) -> PathBuf {
    within(PathBuf::from(env!("CARGO_TARGET_TMPDIR")), kind, name)
}

fn within(base: PathBuf, kind: &str, name: &str) -> PathBuf {
    static SWEPT: Once = Once::new();
    SWEPT.call_once(|| {
        remove_left_behind(std::env::temp_dir());
        remove_left_behind(PathBuf::from(env!("CARGO_TARGET_TMPDIR")));
    });
    let path = base.join(format!("{PREFIX}{kind}-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn remove_left_behind(base: PathBuf) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(PREFIX) {
            continue;
        }
        let Some(pid) = name
            .rsplit('-')
            .next()
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid != std::process::id() && !running(pid) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Whether a process `pid` exists (any process: a reused id keeps the directory, which is safe).
#[cfg(unix)]
fn running(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map_or(true, |status| status.success())
}

#[cfg(not(unix))]
fn running(_: u32) -> bool {
    true
}
