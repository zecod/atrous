//! Finding atrous-core (`atc`). Atrous ships its core inside: beside
//! `atrous.exe` on Windows and Linux (`atrous-core`, `atc`), and on macOS as a
//! helper bundle, `Atrous.app/Contents/Helpers/Atrous Core.app`. The core runs
//! as a background process of its own, so terminals outlive the window.
//!
//! Where it looks, in order: `ATROUS_CORE_DIRS` (tests: only there);
//! `core` in settings.json; the bundled core; then, for builds without one,
//! this process's PATH, the person's login shell's PATH (an app opened from
//! the Dock or a launcher doesn't get it) and the usual install places. A
//! candidate counts only if `--version` says `atc …`: another core never
//! counts, so Atrous and the app it forks run side by side without seeing
//! each other.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

#[cfg(any(target_os = "macos", all(test, unix)))]
mod cli_link;

static BIN: OnceLock<PathBuf> = OnceLock::new();

#[cfg(target_os = "macos")]
pub fn install_cli_link() {
    if let Err(e) = std::thread::Builder::new().name("cli-link".into()).spawn(|| {
        let result = std::env::current_exe().and_then(|exe| cli_link::ensure(&crate::mods::home(), &exe));
        if let Err(e) = result {
            tracing::warn!("cannot install atrous CLI link: {e}");
        }
    }) {
        tracing::warn!("cannot start atrous CLI setup: {e}");
    }
}

/// The core the app runs (`atc` until one is found).
pub fn path() -> PathBuf {
    BIN.get().cloned().unwrap_or_else(|| PathBuf::from(crate::brand::CORE_CLI))
}

/// Uses this core from now on, and puts its folder first on PATH so mods'
/// `core()` and anything the app runs find the same one.
pub fn use_core(bin: PathBuf) {
    if let Some(dir) = bin.parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs: Vec<PathBuf> = vec![dir.to_path_buf()];
        dirs.extend(std::env::split_paths(&path).filter(|d| d != dir));
        if let Ok(joined) = std::env::join_paths(dirs) {
            // SAFETY: set once at start, before other threads read the environment.
            unsafe { std::env::set_var("PATH", joined) };
        }
    }
    let _ = BIN.set(bin);
}

/// Finder and Dock launches don't inherit the person's shell PATH.
#[cfg(target_os = "macos")]
pub fn fill_path() {
    if std::os::unix::process::parent_id() != 1 {
        return;
    }
    let home = crate::mods::home();
    let current = std::env::var_os("PATH").unwrap_or_default();
    if let Some(path) = merged_path(login_shell_path().as_deref(), &usual_dirs(&home)[..3], &current) {
        // SAFETY: called at startup, before other threads read the environment.
        unsafe { std::env::set_var("PATH", path) };
    }
}

#[cfg(any(target_os = "macos", test))]
fn merged_path(login: Option<&std::ffi::OsStr>, usual: &[PathBuf], current: &std::ffi::OsStr) -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = login.map(|path| dirs_on(path).collect()).unwrap_or_default();
    dirs.extend_from_slice(usual);
    dirs.extend(dirs_on(current));
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    std::env::join_paths(dirs).ok()
}

/// `atc X.Y.Z` if this binary is atrous-core and runs.
pub fn version(bin: &Path) -> Option<String> {
    let out = crate::spawn::command(bin).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && text.starts_with("atc ")).then_some(text)
}

/// The version number in `atc X.Y.Z`.
pub fn number(version: &str) -> &str {
    version.trim().trim_start_matches("atc ")
}

/// The core shipped with this app, if it has one: beside the executable
/// (Windows, Linux, a build staged by `scripts/build`), or the macOS helper
/// bundle inside Atrous.app.
pub fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    bundled_beside(&exe).into_iter().find(|c| c.is_file())
}

fn bundled_beside(exe: &Path) -> Vec<PathBuf> {
    let Some(dir) = exe.parent() else { return Vec::new() };
    let mut found = Vec::new();
    // Atrous.app/Contents/MacOS/Atrous -> Atrous.app/Contents/Helpers/Atrous Core.app/Contents/MacOS/atrous-core
    if cfg!(target_os = "macos")
        && let Some(contents) = dir.parent()
    {
        found.push(contents.join("Helpers/Atrous Core.app/Contents/MacOS/atrous-core"));
    }
    found.push(dir.join(format!("atrous-core{}", std::env::consts::EXE_SUFFIX)));
    found
}

/// `atc` beside the bundled core, if an unpacked release or an older install
/// lacks it: a hard link on Windows (the same file, as installers make it), a
/// symlink on Linux. macOS's is inside the signed helper bundle already.
pub fn ensure_atc() {
    if cfg!(target_os = "macos") {
        return;
    }
    let Some(core) = bundled() else { return };
    let atc = core.with_file_name(format!("{}{}", crate::brand::CORE_CLI, std::env::consts::EXE_SUFFIX));
    if atc.symlink_metadata().is_ok() {
        return;
    }
    #[cfg(windows)]
    let made = std::fs::hard_link(&core, &atc).or_else(|_| std::fs::copy(&core, &atc).map(|_| ()));
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink("atrous-core", &atc);
    if let Err(e) = made {
        tracing::warn!("cannot add {}: {e}", atc.display());
    }
}

/// The first atrous-core found, or None.
pub fn find(configured: Option<&str>) -> Option<PathBuf> {
    let home = crate::mods::home();
    let pick = |candidates: Vec<PathBuf>| candidates.into_iter().filter(|c| c.is_file()).find(|c| version(c).is_some());
    // Tests: ATROUS_CORE_DIRS replaces every place Atrous would look.
    if let Some(dirs) = std::env::var_os("ATROUS_CORE_DIRS") {
        return pick(std::env::split_paths(&dirs).flat_map(|d| names(&d)).collect());
    }
    if let Some(found) = pick(configured.map(|c| vec![expand(c, &home)]).unwrap_or_default()) {
        return Some(found);
    }
    // The one Atrous ships with.
    if let Some(found) = pick(std::env::current_exe().map(|e| bundled_beside(&e)).unwrap_or_default()) {
        return Some(found);
    }
    // The quick places first; the login shell (slow) only if they have none.
    let path = std::env::var_os("PATH").unwrap_or_default();
    let quick: Vec<PathBuf> = dirs_on(&path).chain(usual_dirs(&home)).flat_map(|d| names(&d)).collect();
    pick(quick).or_else(|| pick(dirs_on(&login_shell_path()?).flat_map(|d| names(&d)).collect()))
}

fn expand(p: &str, home: &Path) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(p),
    }
}

fn names(dir: &Path) -> [PathBuf; 2] {
    let exe = std::env::consts::EXE_SUFFIX;
    [dir.join(format!("atrous-core{exe}")), dir.join(format!("atc{exe}"))]
}

fn dirs_on(path: &std::ffi::OsStr) -> impl Iterator<Item = PathBuf> + '_ {
    std::env::split_paths(path)
}

/// Where a separate atrous-core was installed before Atrous shipped its own:
/// its old installer (~/.local/bin on Linux and macOS,
/// `%LOCALAPPDATA%\Programs\atrous-core` on Windows), Homebrew, mise, Nix, cargo.
fn usual_dirs(home: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Local"));
        return vec![local.join("Programs/atrous-core"), home.join(".cargo/bin")];
    }
    let mut dirs = vec![
        home.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local/share/mise/shims"),
        home.join(".nix-profile/bin"),
        PathBuf::from("/run/current-system/sw/bin"),
        home.join(".cargo/bin"),
    ];
    if cfg!(target_os = "macos") {
        // atrous-core's bundle: `current` selects the newest; `active` is its fixed path.
        dirs.push(home.join(".local/share/atrous-core/current/Contents/MacOS"));
        dirs.push(home.join(".local/share/atrous-core/active/Atrous Core.app/Contents/MacOS"));
    }
    dirs
}

/// The PATH the person's login shell sets up, or None if it doesn't answer quickly.
fn login_shell_path() -> Option<std::ffi::OsString> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut child = Command::new(shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // A slow or interactive shell profile must not hold up the app.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if child.try_wait().ok()?.is_some() {
            break;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    Some(out.into())
}

/// The running core hands over to the bundled one when it is older, or as
/// new but installed separately (or too old to say where it runs). Never
/// back to an older core.
fn needs_handover(have: &str, ours: &str, exe: Option<&Path>) -> bool {
    if crate::update::newer(ours, have) {
        return true;
    }
    if crate::update::newer(have, ours) {
        return false;
    }
    !exe.is_some_and(shipped_with_atrous)
}

/// A core Atrous ships: beside an `atrous` binary (a real file, not the link
/// in ~/.local/bin), or the helper bundle inside Atrous.app.
fn shipped_with_atrous(exe: &Path) -> bool {
    let Some(dir) = exe.parent() else { return false };
    let app = dir.join(format!("{}{}", crate::brand::BIN, std::env::consts::EXE_SUFFIX));
    app.symlink_metadata().is_ok_and(|m| m.is_file()) || exe.ends_with("Helpers/Atrous Core.app/Contents/MacOS/atrous-core")
}

/// What the running core says about itself (`atc server status`), without
/// starting one where status doesn't (Windows).
fn running(bin: &Path) -> Option<serde_json::Value> {
    let out = crate::spawn::command(bin).args(["server", "status", "--json"]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

/// At start, before connecting: a core already running from elsewhere (the
/// separately installed atrous-core, the folder an update moved aside) or an
/// older one served until now; it restarts into the core this app ships,
/// the planned way, so every terminal keeps running. Ok(Some): the version
/// it runs now; Ok(None): nothing to do (no bundled core, another one
/// chosen in settings, none running, or it already is ours).
pub fn handover() -> Result<Option<String>, String> {
    let Some(ours) = bundled() else { return Ok(None) };
    if path() != ours {
        return Ok(None);
    }
    let Some(status) = running(&ours) else { return Ok(None) };
    let have = status.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0").to_owned();
    let want = version(&ours).map(|v| number(&v).to_owned()).ok_or("the core Atrous ships doesn't run")?;
    let exe = status.get("exe").and_then(|v| v.as_str()).map(PathBuf::from);
    if !needs_handover(&have, &want, exe.as_deref()) {
        return Ok(None);
    }
    tracing::info!("atrous-core {have} ({}) hands over to the bundled {want}", exe.as_deref().map(|e| e.display().to_string()).unwrap_or_else(|| "where it runs is unknown".into()));
    restart_into(&ours).map(Some)
}

/// Restarts the running core into `bin` the planned way (`atc server
/// restart`): every terminal keeps running, and the core comes back from
/// this binary. Ok: the version it runs now.
pub fn restart_into(bin: &Path) -> Result<String, String> {
    let out = crate::spawn::command(bin)
        .args(["server", "restart", "--json"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run {} server restart: {e}", bin.display()))?;
    let reply: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    if out.status.success() {
        return Ok(reply.get("version").and_then(|v| v.as_str()).unwrap_or_default().to_owned());
    }
    let err: serde_json::Value = serde_json::from_slice(&out.stderr).unwrap_or_default();
    let message = err.pointer("/error/message").and_then(|v| v.as_str()).map(str::to_owned);
    Err(message.unwrap_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn the_independent_core_bundle_is_a_discovery_fallback() {
        let home = Path::new("/Users/test");
        let dir = home.join(".local/share/atrous-core/current/Contents/MacOS");
        let active = home.join(".local/share/atrous-core/active/Atrous Core.app/Contents/MacOS");
        let dirs = usual_dirs(home);
        assert_eq!(&dirs[dirs.len() - 2..], &[dir.clone(), active]);
        assert_eq!(names(&dir)[0], dir.join("atrous-core"));
    }

    #[test]
    fn a_separate_or_older_core_hands_over_never_a_newer_one() {
        let dir = std::env::temp_dir().join(format!("atrous-handover-{}", std::process::id()));
        let shipped = dir.join("atrous");
        let alone = dir.join("atrous-core-alone");
        std::fs::create_dir_all(&shipped).unwrap();
        std::fs::create_dir_all(&alone).unwrap();
        let exe = std::env::consts::EXE_SUFFIX;
        std::fs::write(shipped.join(format!("atrous{exe}")), "").unwrap();
        let ours = shipped.join(format!("atrous-core{exe}"));
        let theirs = alone.join(format!("atrous-core{exe}"));
        assert!(needs_handover("0.1.18", "0.2.0", Some(&theirs)), "older, separate");
        assert!(needs_handover("0.1.18", "0.2.0", Some(&ours)), "older, an earlier Atrous");
        assert!(needs_handover("0.2.0", "0.2.0", Some(&theirs)), "as new, but installed separately");
        assert!(needs_handover("0.2.0", "0.2.0", None), "too old to say where it runs");
        assert!(!needs_handover("0.2.0", "0.2.0", Some(&ours)));
        assert!(!needs_handover("0.3.0", "0.2.0", Some(&theirs)), "never back to an older core");
        assert!(shipped_with_atrous(Path::new("/Applications/Atrous.app/Contents/Helpers/Atrous Core.app/Contents/MacOS/atrous-core")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_core_and_the_app_share_one_version() {
        let core = include_str!("../core/crates/atrous-core/Cargo.toml");
        assert!(core.contains(&format!("\nversion = \"{}\"", env!("CARGO_PKG_VERSION"))), "core/crates/atrous-core/Cargo.toml must be {}", env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn the_bundled_core_sits_beside_the_app_or_in_its_helper_bundle() {
        let exe = Path::new("/apps/atrous/atrous");
        let found = bundled_beside(exe);
        assert_eq!(found.last().unwrap(), &Path::new("/apps/atrous").join(format!("atrous-core{}", std::env::consts::EXE_SUFFIX)));
        if cfg!(target_os = "macos") {
            let app = Path::new("/Applications/Atrous.app/Contents/MacOS/Atrous");
            assert_eq!(bundled_beside(app)[0], Path::new("/Applications/Atrous.app/Contents/Helpers/Atrous Core.app/Contents/MacOS/atrous-core"));
        }
    }

    #[test]
    fn startup_path_keeps_shell_order_and_falls_back_to_usual_dirs() {
        let usual = [PathBuf::from("/home/test/.local/bin"), PathBuf::from("/opt/homebrew/bin")];
        let current = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
        let login = std::env::join_paths(["/custom/bin", "/opt/homebrew/bin", "/usr/bin"]).unwrap();
        let merged = merged_path(Some(&login), &usual, &current).unwrap();
        assert_eq!(std::env::split_paths(&merged).collect::<Vec<_>>(), ["/custom/bin", "/opt/homebrew/bin", "/usr/bin", "/home/test/.local/bin", "/bin"].map(PathBuf::from));
        let fallback = merged_path(None, &usual, &current).unwrap();
        assert_eq!(std::env::split_paths(&fallback).collect::<Vec<_>>(), ["/home/test/.local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    }

    // Fakes the binary with a shell script.
    #[cfg(unix)]
    #[test]
    fn only_a_binary_that_says_atc_counts() {
        // Runtime writes can leave a writer fd in a parallel fork, causing ETXTBSY.
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/core-bin");
        // Another core (`hc 0.1.1`) is never Atrous's.
        assert_eq!(version(&dir.join("hc")), None);
        let real = dir.join("atrous-core");
        assert_eq!(version(&real).as_deref(), Some("atc 0.1.1"));
        assert_eq!(find(Some(real.to_str().unwrap())), Some(real));
    }
}
