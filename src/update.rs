//! The app's own updates. An installed app (Linux: `~/.local/share/atrous`,
//! macOS: `Atrous.app`, Windows: `%LOCALAPPDATA%\Programs\atrous`) checks the
//! `manifest.json` of zecod/atrous's latest GitHub release a little
//! after it opens and every hour, downloads a newer build for this
//! machine, checks its sha256 and unpacks it next to itself (`<install>.new`).
//! The frame then shows "Restart"; the swap happens on restart or the next
//! quit, or before opening the next window after a crash. Until there are
//! releases, a check finds nothing (a missing release is not an error).
//!
//! One release holds the app and its core (atrous-core, `atc`): they share a
//! version and update together. The core keeps running through the swap
//! (from the old folder or bundle), so terminals do too; the next start
//! restarts it into the new one the planned way (`handover`), every
//! terminal kept.
//!
//! A build from source never updates: only `scripts/package` (the release
//! builds) sets `ATROUS_RELEASE`. `scripts/install-macos` makes a
//! Atrous.app too, so the install's shape alone can't tell.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

const EVERY: Duration = Duration::from_secs(60 * 60);
/// After a failed check or download (offline, a damaged file).
const RETRY: Duration = Duration::from_secs(30 * 60);

/// Where this app is installed: the folder (Linux) or bundle (macOS) an
/// update replaces. Read once: after a swap this process's own file is gone.
fn root() -> Option<PathBuf> {
    static ROOT: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    ROOT.get_or_init(find_root).clone()
}

fn find_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let dir = exe.parent()?;
    if cfg!(target_os = "macos") {
        // Atrous.app/Contents/MacOS/Atrous
        let bundle = dir.parent()?.parent()?;
        (bundle.extension()? == "app").then(|| bundle.to_path_buf())
    } else {
        // The release folder holds the binary and its icon; cargo's target/ doesn't.
        dir.join("atrous.svg").is_file().then(|| dir.to_path_buf())
    }
}

/// The folder or bundle name inside a release tarball.
const PACKED: &str = if cfg!(target_os = "macos") { "Atrous.app" } else { "atrous" };

fn beside(root: &Path, suffix: &str) -> PathBuf {
    let mut name = root.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    // macOS: Spotlight skips a folder ending in `.noindex`, so a staged
    // `Atrous.app.new` never shows up in search under that name.
    if cfg!(target_os = "macos") {
        name.push(".noindex");
    }
    root.with_file_name(name)
}

fn target() -> String {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    };
    format!("{os}-{}", std::env::consts::ARCH)
}


/// The version downloaded and waiting for a restart.
static READY: Mutex<Option<String>> = Mutex::new(None);

pub fn ready() -> Option<String> {
    READY.lock().unwrap().clone()
}

/// The core the app runs, from its `server.status`. It ships inside Atrous
/// and updates with it: `ready` stays null (kept for mods that read it);
/// `updating` while it restarts into the bundled core, `error` if that failed.
#[derive(Clone, Default, serde::Serialize)]
pub struct CoreInfo {
    pub version: Option<String>,
    /// Who owns it: `atrous` for the bundled core, or a package manager.
    pub managed: Option<String>,
    pub ready: Option<String>,
    pub updating: bool,
    pub error: Option<String>,
}

static CORE: Mutex<CoreInfo> = Mutex::new(CoreInfo { version: None, managed: None, ready: None, updating: false, error: None });
/// When the last check succeeded (unix seconds); a failed check clears it.
static CHECKED: Mutex<Option<u64>> = Mutex::new(None);
/// "Check now" wakes the checker early.
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
/// The checker runs (a release, or pointed at a test server), and is looking right now.
static RUNNING: AtomicBool = AtomicBool::new(false);
static CHECKING: AtomicBool = AtomicBool::new(false);

pub fn core() -> CoreInfo {
    CORE.lock().unwrap().clone()
}

/// What the connected core says about itself (on connect and every reconnect).
pub fn set_core(version: Option<String>, managed: Option<String>) {
    let mut c = CORE.lock().unwrap();
    if let (Some(have), Some(ready)) = (&version, &c.ready)
        && !newer(ready, have)
    {
        c.ready = None;
    }
    c.version = version;
    c.managed = managed;
}

fn checks_app() -> Option<PathBuf> {
    root().filter(|_| option_env!("ATROUS_RELEASE").is_some() || std::env::var_os("ATROUS_RELEASES_URL").is_some())
}

/// For the settings screen: the app (with its core), what's waiting, when we last looked.
pub fn status() -> serde_json::Value {
    serde_json::json!({
        "app": { "version": env!("CARGO_PKG_VERSION"), "ready": ready(), "updates": checks_app().is_some() },
        "notes": crate::update_notes::notes(ready().as_deref()),
        "core": core(),
        "checked": *CHECKED.lock().unwrap(),
        "checks": RUNNING.load(Ordering::Relaxed),
        "checking": CHECKING.load(Ordering::Relaxed),
    })
}

pub fn check_now() {
    if RUNNING.load(Ordering::Relaxed) {
        CHECKING.store(true, Ordering::Relaxed);
    }
    *WAKE.0.lock().unwrap() = true;
    WAKE.1.notify_all();
}

fn sleep(d: Duration) {
    let woken = WAKE.0.lock().unwrap();
    let (mut woken, _) = WAKE.1.wait_timeout_while(woken, d, |w| !*w).unwrap();
    *woken = false;
}

/// Starts checking in the background if this is an installed release.
pub fn start() {
    let Some(root) = checks_app() else {
        tracing::info!("a build from source: no updates");
        return;
    };
    RUNNING.store(true, Ordering::Relaxed);
    CHECKING.store(true, Ordering::Relaxed);
    std::thread::spawn(move || {
        sleep(Duration::from_secs(10));
        loop {
            CHECKING.store(true, Ordering::Relaxed);
            let mut wait = EVERY;
            let mut succeeded = true;
            match check(&root) {
                Ok(found) => {
                    if found.is_some() {
                        *READY.lock().unwrap() = found;
                    }
                }
                Err(e) => {
                    tracing::warn!("update check: {e}");
                    crate::telemetry::count("app_update_failed");
                    wait = RETRY;
                    succeeded = false;
                }
            }
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            *CHECKED.lock().unwrap() = checked_at(succeeded, now);
            CHECKING.store(false, Ordering::Relaxed);
            sleep(wait);
        }
    });
}

fn checked_at(succeeded: bool, now: u64) -> Option<u64> {
    succeeded.then_some(now)
}

/// Before the app connects: a core running from elsewhere (the separately
/// installed atrous-core, an older Atrous) or an older one restarts into the
/// core this app ships, the planned way: every terminal keeps running.
pub fn handover() {
    CORE.lock().unwrap().updating = true;
    let result = crate::core_bin::handover();
    let mut c = CORE.lock().unwrap();
    c.updating = false;
    match result {
        Ok(Some(now)) => {
            tracing::info!("atrous-core restarted into the bundled {now}; terminals kept");
            c.error = None;
        }
        Ok(None) => {}
        Err(e) => {
            tracing::warn!("atrous-core restart into the bundled core: {e}");
            c.error = Some(e);
        }
    }
}

/// Downloads the latest release if it's newer. Ok(Some): a version is ready.
fn check(root: &Path) -> Result<Option<String>, String> {
    check_from(root, &crate::brand::app_latest("manifest.json"), |version| crate::brand::app_release(version, "changelog.md"))
}

/// `latest`: the manifest's URL; `notes`: a version's changelog URL.
fn check_from(root: &Path, latest: &str, notes: impl Fn(&str) -> String) -> Result<Option<String>, String> {
    let path = "manifest.json";
    // No release yet (zecod/atrous has published none): nothing to find.
    let Some(text) = curl_found(latest)? else { return Ok(None) };
    let manifest: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    let version = manifest["version"].as_str().ok_or(format!("{path}: no version"))?;
    if !newer(version, env!("CARGO_PKG_VERSION")) {
        return Ok(None);
    }
    // Notes are optional: a missing feed must never hold up the update.
    if !crate::update_notes::has(version)
        && let Ok(text) = curl_text(&notes(version))
    {
        crate::update_notes::cache(&text);
    }
    let staged = beside(root, ".new");
    if staged_version(root).as_deref() == Some(version) {
        return Ok(Some(version.to_owned()));
    }
    let entry = &manifest["targets"][target()];
    let (Some(url), Some(sha)) = (entry["url"].as_str(), entry["sha256"].as_str()) else {
        return Ok(None);
    };
    tracing::info!("downloading Atrous {version}");
    let work = beside(root, ".download");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| format!("{}: {e}", work.display()))?;
    let result = unpack(url, sha, &work).and_then(|unpacked| {
        if version_of(&unpacked).as_deref() != Some(version) {
            return Err(format!("the download doesn't run as {version}"));
        }
        let _ = std::fs::remove_file(beside(root, ".new.json"));
        let _ = std::fs::remove_dir_all(&staged);
        std::fs::rename(&unpacked, &staged).map_err(|e| format!("{}: {e}", staged.display()))?;
        // Outside the bundle: writing a receipt must not change its signature.
        std::fs::write(beside(root, ".new.json"), serde_json::json!({ "version": version }).to_string()).map_err(|e| e.to_string())
    });
    let _ = std::fs::remove_dir_all(&work);
    result.map(|()| Some(version.to_owned()))
}

/// Downloads, checks and unpacks a release into `work`; returns the app inside.
fn unpack(url: &str, sha: &str, work: &Path) -> Result<PathBuf, String> {
    let tarball = work.join("app.tar.gz");
    run(crate::spawn::command(system("curl")).args(["-fsSL", "--max-time", "600", "-o"]).arg(&tarball).arg(url))?;
    let bytes = std::fs::read(&tarball).map_err(|e| e.to_string())?;
    if sha256(&bytes) != sha.to_ascii_lowercase() {
        return Err("the download is damaged (checksum mismatch)".into());
    }
    run(crate::spawn::command(system("tar")).arg("-xzf").arg(&tarball).arg("-C").arg(work))?;
    let app = work.join(PACKED);
    if cfg!(target_os = "macos") {
        // Authority is absent at -dv, even for a Developer ID release.
        let signature = Command::new("/usr/bin/codesign").arg("-dvv").arg(&app).output().map_err(|e| format!("codesign: {e}"))?;
        prepare_macos_bundle(&app, &signature)?;
    }
    Ok(app)
}

fn prepare_macos_bundle(app: &Path, signature: &std::process::Output) -> Result<(), String> {
    if release_signature(signature.status.success(), &String::from_utf8_lossy(&signature.stderr))? {
        run(Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(app))?;
    } else {
        // Only known dev builds may change the plist and lose their signature.
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
        let plist = app.join("Contents/Info.plist");
        run(Command::new("/usr/libexec/PlistBuddy").arg("-c").arg(format!("Add :LSEnvironment:PATH string {path}")).arg(&plist))?;
        run(Command::new("/usr/bin/codesign").args(["--force", "--sign", "-"]).arg(app))?;
    }
    Ok(())
}

fn release_signature(success: bool, signature: &str) -> Result<bool, String> {
    if success && signature.lines().any(|line| line.starts_with("Authority=Developer ID Application:")) {
        Ok(true)
    } else if (success && signature.lines().any(|line| line == "Signature=adhoc"))
        || (!success && signature.lines().any(|line| line.ends_with(": code object is not signed at all")))
    {
        Ok(false)
    } else {
        Err(format!("cannot determine app signature: {}", signature.trim()))
    }
}

/// curl and tar: on Windows its own (System32), since Git's tar, often first
/// on PATH, takes `C:\...` for a remote host.
pub fn system(name: &str) -> PathBuf {
    match std::env::var_os("SystemRoot").filter(|_| cfg!(windows)) {
        Some(root) => PathBuf::from(root).join("System32").join(format!("{name}.exe")),
        None => PathBuf::from(name),
    }
}

pub(crate) fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn curl_text(url: &str) -> Result<String, String> {
    curl_found(url)?.ok_or_else(|| format!("{url}: not found"))
}

/// Like `curl_text`, but a 404 (no such release yet) is Ok(None), not an error.
fn curl_found(url: &str) -> Result<Option<String>, String> {
    let out = crate::spawn::command(system("curl")).args(["-fsSL", "--max-time", "30", url]).stdin(Stdio::null()).output().map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // curl -f exits 22 on an HTTP error and names the status.
        if out.status.code() == Some(22) && err.contains("404") {
            return Ok(None);
        }
        return Err(format!("{url}: {}", err.trim()));
    }
    String::from_utf8(out.stdout).map(Some).map_err(|e| e.to_string())
}

fn run(cmd: &mut Command) -> Result<(), String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| format!("{:?}: {e}", cmd.get_program()))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{:?}: {}", cmd.get_program(), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn exe_in(app: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        app.join("Contents/MacOS/Atrous")
    } else {
        app.join(format!("atrous{}", std::env::consts::EXE_SUFFIX))
    }
}

/// What `atrous --version` says in this folder or bundle (`0.2.0`).
fn version_of(app: &Path) -> Option<String> {
    let out = crate::spawn::command(exe_in(app)).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        return None;
    }
    text.trim().strip_prefix("atrous ").map(str::to_owned)
}

/// `a` is a later version than `b` (semver; `0.2.0-rc.1` comes before `0.2.0`).
pub(crate) fn newer(a: &str, b: &str) -> bool {
    fn parts(v: &str) -> (Vec<u64>, Option<&str>) {
        let (core, pre) = v.trim_start_matches('v').split_once('-').map_or((v.trim_start_matches('v'), None), |(c, p)| (c, Some(p)));
        (core.split('.').map(|n| n.parse().unwrap_or(0)).collect(), pre)
    }
    let ((ca, pa), (cb, pb)) = (parts(a), parts(b));
    match ca.cmp(&cb) {
        std::cmp::Ordering::Equal => match (pa, pb) {
            (None, Some(_)) => true,
            (Some(x), Some(y)) => x > y,
            _ => false,
        },
        o => o == std::cmp::Ordering::Greater,
    }
}

/// A receipt is published only after the archive and its executable were verified.
/// Legacy stages without one are left for the normal checker to download again.
fn staged_version(root: &Path) -> Option<String> {
    let staged = beside(root, ".new");
    let receipt = beside(root, ".new.json");
    let version = std::fs::read(&receipt).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value["version"].as_str().map(str::to_owned));
    let version = version?;
    if version_of(&staged).as_deref() != Some(&version) {
        tracing::warn!("update: staged executable does not match its verified manifest; discarding it");
        let _ = std::fs::remove_file(receipt);
        let _ = std::fs::remove_dir_all(staged);
        return None;
    }
    Some(version)
}

fn startup_target<'a>(running: &str, staged: Option<&'a str>, relaunched: Option<&str>) -> Option<&'a str> {
    if relaunched.is_some() {
        return None;
    }
    staged.filter(|version| newer(version, running))
}

/// Recover a staged hotfix even when the previous window never quit cleanly.
/// The inherited expected version allows only one automatic relaunch.
pub fn apply_on_startup() -> bool {
    let expected = std::env::var("ATROUS_UPDATE_EXPECTED").ok();
    if let Some(expected) = &expected {
        // SAFETY: startup runs before any app threads. Do not leak the guard
        // into the core's environment and every terminal it later starts.
        unsafe { std::env::remove_var("ATROUS_UPDATE_EXPECTED") };
        if expected != env!("CARGO_PKG_VERSION") {
            tracing::warn!("update: relaunched as {}, expected {expected}; not retrying", env!("CARGO_PKG_VERSION"));
        }
        return false;
    }
    let Some(root) = checks_app() else { return false };
    let staged = staged_version(&root);
    let Some(version) = startup_target(env!("CARGO_PKG_VERSION"), staged.as_deref(), expected.as_deref()) else { return false };
    if !swap(&root) {
        return false;
    }
    relaunch_expected(Some(version))
}

/// Puts the downloaded version in place of this one. The running app keeps
/// its files open, so it can go on until it quits. True if it swapped.
/// Windows lets a running program's folder be renamed, not deleted: the old
/// one goes on the next start (`after_update`).
pub fn apply() -> bool {
    let Some(root) = root() else { return false };
    let staged = staged_version(&root);
    if ready().as_deref() != staged.as_deref() || !staged.as_deref().is_some_and(|version| newer(version, env!("CARGO_PKG_VERSION"))) {
        return false;
    }
    swap(&root)
}

fn swap(root: &Path) -> bool {
    let staged = beside(root, ".new");
    let old = beside(root, ".old");
    retire(&old);
    if let Err(e) = std::fs::rename(root, &old) {
        tracing::warn!("update: cannot move {} aside: {e}", root.display());
        return false;
    }
    if let Err(e) = std::fs::rename(&staged, root) {
        tracing::warn!("update: cannot put the new version in place: {e}");
        if let Err(rollback) = std::fs::rename(&old, root) {
            tracing::error!("update: cannot restore the previous version: {rollback}");
        }
        return false;
    }
    let _ = std::fs::remove_file(beside(root, ".new.json"));
    *READY.lock().unwrap() = None;
    let _ = std::fs::write(marker(), "");
    true
}

/// Opens the app again once this process has exited (after `apply`).
pub fn relaunch() {
    relaunch_expected(None);
}

#[cfg(windows)]
fn relaunch_expected(expected: Option<&str>) -> bool {
    let Some(root) = root() else { return false };
    let exe = exe_in(&root).to_string_lossy().replace('\'', "''");
    let script = format!("Wait-Process -Id {} -ErrorAction SilentlyContinue; Start-Process '{exe}'", std::process::id());
    let mut command = crate::spawn::command("powershell");
    if let Some(expected) = expected {
        command.env("ATROUS_UPDATE_EXPECTED", expected);
    }
    let spawned = command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match spawned {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!("update: cannot reopen the app: {e}");
            false
        }
    }
}

/// Opens the app again once this process has exited (after `apply`).
#[cfg(unix)]
fn relaunch_expected(expected: Option<&str>) -> bool {
    let Some(root) = root() else { return false };
    // LaunchServices need not preserve the startup guard or an isolated home.
    let open = if cfg!(target_os = "macos") {
        if expected.is_some() { "exec \"$1/Contents/MacOS/Atrous\"" } else { "open \"$1\"" }
    } else {
        "exec \"$1/atrous\""
    };
    let script = format!("while kill -0 \"$0\" 2>/dev/null; do sleep 0.1; done; {open}");
    let spawned = {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("sh");
        if let Some(expected) = expected {
            command.env("ATROUS_UPDATE_EXPECTED", expected);
        }
        command
            .arg("-c")
            .arg(script)
            .arg(std::process::id().to_string())
            .arg(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
    };
    match spawned {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!("update: cannot reopen the app: {e}");
            false
        }
    }
}

/// Left by `apply`: the next start clears the previous version away.
fn marker() -> PathBuf {
    crate::mods::app_dir().join(".updated")
}

/// Removes a previous version. Programs it started can still run from it
/// (an older core's terminal holders, until their terminals end); Windows
/// won't delete their files but will rename the folder, so what can't go
/// moves aside and goes on a later start.
fn retire(old: &Path) {
    if in_use(old) || std::fs::remove_dir_all(old).is_err() && old.exists() {
        let mut name = old.file_name().unwrap_or_default().to_os_string();
        name.push(format!("-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
        if let Err(e) = std::fs::rename(old, old.with_file_name(name)) {
            tracing::warn!("update: cannot move {} aside: {e}", old.display());
        }
    }
}

/// Windows: a program still runs from `dir` (its own file or a DLL it
/// loaded won't open for writing). Deleting around it would take files it
/// still starts (a core's conpty\OpenConsole.exe), so such a folder stays
/// whole. A process's reported path can't tell: it keeps the old one after
/// its folder is renamed. Elsewhere running files can go: never in use.
fn in_use(dir: &Path) -> bool {
    if !cfg!(windows) {
        return false;
    }
    fn walk(dir: &Path) -> bool {
        std::fs::read_dir(dir).into_iter().flatten().flatten().any(|e| {
            let p = e.path();
            if p.is_dir() {
                return walk(&p);
            }
            let program = p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe") || x.eq_ignore_ascii_case("dll"));
            program && std::fs::OpenOptions::new().write(true).open(&p).is_err()
        })
    }
    walk(dir)
}

/// Previous versions beside the install (`atrous.old`, `atrous.old-…`).
fn previous(root: &Path) -> Vec<PathBuf> {
    let Some(parent) = root.parent() else { return Vec::new() };
    let mut prefix = root.file_name().unwrap_or_default().to_string_lossy().into_owned();
    prefix.push_str(".old");
    std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix) && e.path().is_dir())
        .map(|e| e.path())
        .collect()
}

/// The first start after an app update clears the previous versions away
/// (the core was already restarted into the new one by `handover`). What a
/// still-running program holds stays until a later update.
pub fn after_update() {
    if std::fs::remove_file(marker()).is_err() {
        return;
    }
    let Some(root) = root() else { return };
    // A core that didn't move to the new version still runs from the old
    // folder and starts terminals with its files: keep it whole.
    if core().error.is_some() {
        return;
    }
    std::thread::spawn(move || {
        for old in previous(&root).into_iter().filter(|old| !in_use(old)) {
            let _ = std::fs::remove_dir_all(&old);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_check_clears_success_and_recovery_records_a_new_time() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        // An isolated release server drops the first connection, then recovers.
        // No environment changes, app window, core, or installed files are involved.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for recover in [false, true] {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                assert!(request.starts_with(b"GET /app/manifest.json HTTP/1.1\r\n"));
                if recover {
                    let body = format!(r#"{{"version":"{}"}}"#, env!("CARGO_PKG_VERSION"));
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            }
        });
        let home = std::env::temp_dir().join(format!("atrous-offline-check-{}", std::process::id()));
        let mut checked = checked_at(true, 100);
        assert_eq!(checked, Some(100));
        let latest = format!("{url}/app/manifest.json");
        let notes = |v: &str| format!("{url}/app/{v}/changelog.md");
        let failed = check_from(&home, &latest, notes);
        assert!(failed.is_err(), "a dropped connection must fail: {failed:?}");
        checked = checked_at(failed.is_ok(), 200);
        assert_eq!(checked, None);
        let recovered = check_from(&home, &latest, notes);
        assert_eq!(recovered, Ok(None));
        checked = checked_at(recovered.is_ok(), 300);
        assert_eq!(checked, Some(300));
        server.join().unwrap();
    }

    #[test]
    fn startup_applies_only_a_newer_version_and_never_relaunches_twice() {
        assert_eq!(startup_target("0.1.7", Some("0.1.8"), None), Some("0.1.8"));
        for staged in [None, Some("0.1.6"), Some("0.1.7")] {
            assert_eq!(startup_target("0.1.7", staged, None), None);
        }
        for expected in ["0.1.7", "0.1.8", "0.1.9"] {
            assert_eq!(startup_target("0.1.7", Some("0.1.8"), Some(expected)), None);
        }
    }

    #[cfg(unix)]
    #[test]
    fn stages_need_a_receipt_and_a_matching_executable() {
        use std::os::unix::fs::PermissionsExt;
        let work = std::env::temp_dir().join(format!("atrous-update-{}", std::process::id()));
        let root = work.join(PACKED);
        let staged = beside(&root, ".new");
        let receipt = beside(&root, ".new.json");
        let exe = exe_in(&staged);
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "#!/bin/sh\necho atrous 0.1.8\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(staged_version(&root), None);
        assert!(staged.is_dir()); // Legacy stages are left for the checker.
        std::fs::write(&receipt, r#"{"version":"0.1.8"}"#).unwrap();
        assert_eq!(staged_version(&root).as_deref(), Some("0.1.8"));
        std::fs::write(&receipt, r#"{"version":"0.1.9"}"#).unwrap();
        assert_eq!(staged_version(&root), None);
        assert!(!staged.exists());
        assert!(!receipt.exists());
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "corrupt").unwrap();
        std::fs::write(&receipt, r#"{"version":"0.1.8"}"#).unwrap();
        assert_eq!(staged_version(&root), None);
        assert!(!staged.exists());
        std::fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn signature_inspection_fails_closed() {
        let release = include_str!("../scripts/fixtures/codesign/developer-id.txt");
        let adhoc = include_str!("../scripts/fixtures/codesign/adhoc.txt");
        let unsigned = include_str!("../scripts/fixtures/codesign/unsigned.txt");
        assert_eq!(release_signature(true, release), Ok(true));
        assert_eq!(release_signature(true, adhoc), Ok(false));
        assert_eq!(release_signature(false, unsigned), Ok(false));
        for (success, output) in [(false, release), (false, adhoc), (true, unsigned), (true, ""), (false, "codesign: internal error"), (true, "Authority=Apple Development: Someone")] {
            assert!(release_signature(success, output).unwrap_err().starts_with("cannot determine app signature:"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unknown_signature_does_not_modify_the_bundle() {
        use std::os::unix::process::ExitStatusExt;
        let work = std::env::temp_dir().join(format!("atrous-unknown-signature-{}", std::process::id()));
        let plist = work.join("Contents/Info.plist");
        std::fs::create_dir_all(plist.parent().unwrap()).unwrap();
        std::fs::write(&plist, "unchanged plist").unwrap();
        let signature = std::process::Output {
            status: std::process::ExitStatus::from_raw(1 << 8),
            stdout: Vec::new(),
            stderr: b"codesign: internal error".to_vec(),
        };
        assert_eq!(prepare_macos_bundle(&work, &signature), Err("cannot determine app signature: codesign: internal error".into()));
        assert_eq!(std::fs::read_to_string(plist).unwrap(), "unchanged plist");
        assert_eq!(std::fs::read_dir(work.join("Contents")).unwrap().count(), 1);
        std::fs::remove_dir_all(work).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "downloads the current release; runs real codesign on isolated bundles"]
    fn macos_unpack_preserves_release_signature_and_prepares_dev_builds() {
        let version = env!("CARGO_PKG_VERSION");
        let manifest: serde_json::Value = serde_json::from_str(&curl_text(&crate::brand::app_release(version, "manifest.json")).unwrap()).unwrap();
        let work = std::env::temp_dir().join(format!("atrous-signature-test-{}", std::process::id()));
        let signed = work.join("signed");
        let reference = work.join("reference");
        std::fs::create_dir_all(&signed).unwrap();
        std::fs::create_dir_all(&reference).unwrap();
        let entry = &manifest["targets"][target()];
        let app = unpack(entry["url"].as_str().unwrap(), entry["sha256"].as_str().unwrap(), &signed).unwrap();
        let signature = Command::new("/usr/bin/codesign").arg("-dvv").arg(&app).output().unwrap();
        assert_eq!(release_signature(signature.status.success(), &String::from_utf8_lossy(&signature.stderr)), Ok(true));
        run(Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&app)).unwrap();
        run(Command::new("tar").arg("-xzf").arg(signed.join("app.tar.gz")).arg("-C").arg(&reference)).unwrap();
        for file in ["Contents/Info.plist", "Contents/MacOS/Atrous", "Contents/_CodeSignature/CodeResources"] {
            assert_eq!(std::fs::read(app.join(file)).unwrap(), std::fs::read(reference.join(PACKED).join(file)).unwrap(), "{file} was modified");
        }
        for kind in ["adhoc", "unsigned"] {
            let source = reference.join(PACKED);
            let mut codesign = Command::new("/usr/bin/codesign");
            if kind == "adhoc" {
                codesign.args(["--force", "--sign", "-"]);
            } else {
                codesign.arg("--remove-signature");
            }
            run(codesign.arg(&source)).unwrap();
            let archive = work.join(format!("{kind}.tar.gz"));
            run(Command::new("tar").arg("-czf").arg(&archive).arg("-C").arg(&reference).arg(PACKED)).unwrap();
            let dev = work.join(kind);
            std::fs::create_dir_all(&dev).unwrap();
            let sha = sha256(&std::fs::read(&archive).unwrap());
            let app = unpack(&format!("file://{}", archive.display()), &sha, &dev).unwrap();
            let signature = Command::new("/usr/bin/codesign").arg("-dvv").arg(&app).output().unwrap();
            assert!(signature.status.success());
            let signature = String::from_utf8_lossy(&signature.stderr);
            assert_eq!(release_signature(true, &signature), Ok(false));
            assert!(signature.lines().any(|line| line == "Signature=adhoc"));
            run(Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&app)).unwrap();
            let path = Command::new("/usr/libexec/PlistBuddy").args(["-c", "Print :LSEnvironment:PATH"]).arg(app.join("Contents/Info.plist")).output().unwrap();
            assert!(path.status.success());
            assert!(String::from_utf8_lossy(&path.stdout).contains("/opt/homebrew/bin"));
        }
        std::fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn versions_compare_like_semver() {
        assert!(newer("0.2.0", "0.1.9"));
        assert!(newer("0.10.0", "0.9.0"));
        assert!(newer("1.0.0", "1.0.0-rc.1"));
        assert!(!newer("1.0.0-rc.1", "1.0.0"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("0.0.9", "0.1.0"));
    }

    #[test]
    fn previous_versions_are_the_old_folders_beside_the_install() {
        let work = std::env::temp_dir().join(format!("atrous-previous-{}", std::process::id()));
        let root = work.join("atrous");
        for dir in ["atrous", "atrous.old", "atrous.old-1234", "atrous.new", "atrous-core", "other.old"] {
            std::fs::create_dir_all(work.join(dir)).unwrap();
        }
        let mut found: Vec<String> = previous(&root).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        found.sort();
        assert_eq!(found, ["atrous.old", "atrous.old-1234"]);
        retire(&work.join("atrous.old"));
        assert!(!work.join("atrous.old").exists());
        std::fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn sha256_is_hex() {
        assert_eq!(sha256(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}

#[cfg(test)]
mod missing_release_tests {
    use super::*;

    /// A repo with no release answers 404: a check finds nothing, without an error.
    #[test]
    fn a_missing_release_finds_nothing() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found").unwrap();
        });
        let home = std::env::temp_dir().join(format!("atrous-no-release-{}", std::process::id()));
        let latest = format!("{url}/app/manifest.json");
        assert_eq!(check_from(&home, &latest, |v| format!("{url}/app/{v}/changelog.md")), Ok(None));
        server.join().unwrap();
    }
}
