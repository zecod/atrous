//! The first start of Atrous for someone coming from herdr-app: when
//! `~/.config/atrous` doesn't exist yet and `~/.config/herdr-app` does, the
//! person's own files come over once. herdr-app's folder is only read, never
//! changed, so both apps keep working side by side.
//!
//! What comes: settings.json, keys.json, programs.json, shared.json,
//! seen.json, themes/, data/ (mods' storage), the person's own layouts with
//! their clicks (layouts/.state/), and their own mods. `.config/herdr-app`
//! inside the copied JSON becomes `.config/atrous`.
//!
//! What stays: herdr's shipped mods and layouts (Atrous ships its own),
//! Fedra's mods and layout (Fedra becomes part of Atrous), `accounts/`
//! (moved by Fedra's own, junction-safe code), and anything herdr-app
//! generates (AGENTS.md, .d.ts, installed.json, window and view state, update
//! notes, the socket). Links and junctions are never followed or copied.
//!
//! `ATROUS_MIGRATE_FROM` names another herdr-app home (tests). A home set
//! with `ATROUS_HOME` (a scratch home) starts empty unless that is set too.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// herdr's shipped layouts (Atrous ships the same ones as Classic, Terminals and Atrous 98).
const HERDR_LAYOUTS: &[&str] = &["main", "terminals", "win98"];
/// Fedra, the person's setup that becomes Atrous's built-in UI
/// (fedra/sync-from-home.mjs `MODS`, and its layout).
const FEDRA_MODS: &[&str] = &[
    "accounts", "add-project", "agent-menu", "browser-panel", "my-chrome", "my-files", "my-menu",
    "my-new-menu", "my-pane", "my-settings", "my-spaces", "my-status", "my-tabs", "my-worktree", "open-in",
    "snap-split", "usage-card", "usage-stats",
];
const FEDRA_LAYOUTS: &[&str] = &["fedra"];
const FILES: &[&str] = &["settings.json", "keys.json", "programs.json", "shared.json", "seen.json"];

/// What came over, for the one toast that says so.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub files: Vec<String>,
    pub themes: usize,
    pub layouts: Vec<String>,
    pub clicks: usize,
    pub mods: Vec<String>,
    pub data: usize,
}

static NOTE: Mutex<Option<Report>> = Mutex::new(None);

/// The toast for this start, once (`None` when nothing was migrated).
pub fn take_note() -> Option<serde_json::Value> {
    let report = NOTE.lock().ok()?.take()?;
    let mut parts: Vec<String> = Vec::new();
    let has = |f: &str| report.files.iter().any(|x| x == f);
    if has("settings.json") {
        parts.push("settings".into());
    }
    if has("keys.json") {
        parts.push("keys".into());
    }
    if has("programs.json") {
        parts.push("programs".into());
    }
    if report.themes > 0 {
        parts.push(plural(report.themes, "theme"));
    }
    if !report.layouts.is_empty() {
        parts.push(format!("{} ({})", plural(report.layouts.len(), "layout"), report.layouts.join(", ")));
    }
    if report.clicks > 0 {
        parts.push("layout clicks".into());
    }
    if !report.mods.is_empty() {
        parts.push(format!("{} ({})", plural(report.mods.len(), "mod"), report.mods.join(", ")));
    }
    if report.data > 0 || has("shared.json") {
        parts.push("mod data".into());
    }
    let what = if parts.is_empty() { "nothing of yours yet".to_owned() } else { parts.join(", ") };
    Some(serde_json::json!({
        "title": "Brought over from herdr-app",
        "body": format!("{what}. Your herdr-app folder is unchanged; herdr's own layouts and mods stay there."),
        "level": "info",
        "timeout": 20000,
    }))
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 { format!("1 {word}") } else { format!("{n} {word}s") }
}

/// Runs once, before anything reads or creates the Atrous home.
pub fn from_herdr() -> Option<Report> {
    let to = crate::mods::app_dir();
    if to.exists() {
        return None;
    }
    let from = old_home()?;
    if !from.is_dir() {
        return None;
    }
    match migrate(&from, &to) {
        Ok(report) => {
            tracing::info!("brought over from {}: {report:?}", from.display());
            if let Ok(mut note) = NOTE.lock() {
                *note = Some(report.clone());
            }
            Some(report)
        }
        Err(e) => {
            tracing::warn!("cannot bring over {}: {e}", from.display());
            None
        }
    }
}

/// herdr-app's home: `$XDG_CONFIG_HOME/herdr-app`, else `~/.config/herdr-app`.
fn old_home() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(from) = env("ATROUS_MIGRATE_FROM") {
        return Some(from);
    }
    if env("ATROUS_HOME").is_some() {
        return None;
    }
    Some(env("XDG_CONFIG_HOME").unwrap_or_else(|| crate::mods::home().join(".config")).join("herdr-app"))
}

/// Copies into a folder beside `to`, then renames it into place: a start
/// that stops halfway leaves no half-made home (it tries again next time).
pub fn migrate(from: &Path, to: &Path) -> std::io::Result<Report> {
    let parent = to.parent().ok_or_else(|| std::io::Error::other("no parent folder"))?;
    std::fs::create_dir_all(parent)?;
    let stage = parent.join(format!(".atrous-migrating-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage)?;
    let result = copy_all(from, &stage, to);
    match result {
        Ok(report) => {
            if let Err(e) = std::fs::rename(&stage, to) {
                let _ = std::fs::remove_dir_all(&stage);
                return Err(e);
            }
            Ok(report)
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&stage);
            Err(e)
        }
    }
}

fn copy_all(from: &Path, stage: &Path, to: &Path) -> std::io::Result<Report> {
    let mut report = Report::default();
    let rewrite = Rewrite::new(from, to);
    for name in FILES {
        let src = from.join(name);
        if plain_file(&src) {
            copy_file(&src, &stage.join(name), &rewrite)?;
            report.files.push((*name).to_owned());
        }
    }
    drop_herdr_core(&stage.join("settings.json"));
    report.themes = copy_tree(&from.join("themes"), &stage.join("themes"), &rewrite)?;
    report.data = copy_tree(&from.join("data"), &stage.join("data"), &rewrite)?;

    // Layouts: the person's own, every layout's clicks.
    let (shipped_mods, shipped_layouts) = herdr_shipped(from);
    let skip_layout = |stem: &str| shipped_layouts.iter().any(|l| l == stem) || FEDRA_LAYOUTS.contains(&stem);
    let layouts = from.join("layouts");
    for entry in read_dir(&layouts) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if name == ".state" {
            report.clicks = copy_tree(&path, &stage.join("layouts/.state"), &rewrite)?;
            continue;
        }
        let stem = name.split('.').next().unwrap_or_default();
        if name.starts_with('.') || skip_layout(stem) || !plain_file(&path) {
            continue;
        }
        copy_file(&path, &stage.join("layouts").join(&name), &rewrite)?;
        if let Some(layout) = name.strip_suffix(".json") {
            report.layouts.push(layout.to_owned());
        }
    }

    // Mods: the person's own (an edited shipped mod is theirs as `<name>-edited`).
    for entry in read_dir(&from.join("mods")) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if name.starts_with('.') || shipped_mods.iter().any(|m| *m == name) || FEDRA_MODS.contains(&name.as_str()) || !plain_dir(&path) {
            continue;
        }
        copy_tree(&path, &stage.join("mods").join(&name), &rewrite)?;
        report.mods.push(name);
    }
    report.layouts.sort();
    report.mods.sort();
    Ok(report)
}

/// The mods and layouts herdr-app installed itself (its installed.json), and
/// the ones Atrous ships under the same names.
fn herdr_shipped(from: &Path) -> (Vec<String>, Vec<String>) {
    let installed: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(from.join("installed.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let mut mods: Vec<String> = installed.keys().filter(|k| !k.starts_with("layout:")).cloned().collect();
    mods.extend(crate::mods::shipped_mod_names().into_iter().map(str::to_owned));
    let mut layouts: Vec<String> = installed.keys().filter_map(|k| k.strip_prefix("layout:").map(str::to_owned)).collect();
    layouts.extend(HERDR_LAYOUTS.iter().map(|l| (*l).to_owned()));
    (mods, layouts)
}

/// settings.json's `core` pointing at herdr's core would be skipped anyway
/// (it isn't atrous-core); dropped so Atrous looks in its own places.
fn drop_herdr_core(settings: &Path) {
    let Ok(text) = std::fs::read_to_string(settings) else { return };
    let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let herdr = map.get("core").and_then(|c| c.as_str()).is_some_and(|c| {
        let c = c.to_ascii_lowercase();
        c.contains("herdr") || c.ends_with("hc") || c.ends_with("hc.exe")
    });
    if herdr {
        map.remove("core");
        if let Ok(text) = serde_json::to_string_pretty(&serde_json::Value::Object(map)) {
            let _ = std::fs::write(settings, text + "\n");
        }
    }
}

/// Old home paths in JSON text, and what they become.
struct Rewrite {
    pairs: Vec<(String, String)>,
}

impl Rewrite {
    fn new(from: &Path, to: &Path) -> Rewrite {
        let mut pairs = Vec::new();
        let (f, t) = (from.to_string_lossy().into_owned(), to.to_string_lossy().into_owned());
        // The exact folders, as written in JSON (backslashes escaped) and with forward slashes.
        pairs.push((f.replace('\\', "\\\\"), t.replace('\\', "\\\\")));
        pairs.push((f.replace('\\', "/"), t.replace('\\', "/")));
        if f != f.replace('\\', "/") {
            pairs.push((f.clone(), t.clone()));
        }
        // Any spelling of the default home.
        pairs.push((".config\\\\herdr-app".into(), ".config\\\\atrous".into()));
        pairs.push((".config/herdr-app".into(), ".config/atrous".into()));
        Rewrite { pairs }
    }

    fn apply(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for (a, b) in &self.pairs {
            if !a.is_empty() && a != b {
                out = out.replace(a.as_str(), b);
            }
        }
        out
    }
}

/// Copies one file; JSON gets its herdr-app paths rewritten (if it stays valid JSON).
fn copy_file(src: &Path, dst: &Path, rewrite: &Rewrite) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if src.extension().is_some_and(|e| e == "json")
        && let Ok(text) = std::fs::read_to_string(src)
    {
        let new = rewrite.apply(&text);
        if new != text && serde_json::from_str::<serde_json::Value>(new.trim_start_matches('\u{feff}')).is_ok() {
            return std::fs::write(dst, new);
        }
    }
    std::fs::copy(src, dst).map(|_| ())
}

/// Copies a folder's plain files and folders; returns how many files.
/// Links, junctions, sockets and other reparse points are skipped, never followed.
fn copy_tree(src: &Path, dst: &Path, rewrite: &Rewrite) -> std::io::Result<usize> {
    if !plain_dir(src) {
        return Ok(0);
    }
    let mut n = 0;
    for entry in read_dir(src) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if skipped(&name) {
            continue;
        }
        let path = entry.path();
        if plain_dir(&path) {
            n += copy_tree(&path, &dst.join(&name), rewrite)?;
        } else if plain_file(&path) {
            copy_file(&path, &dst.join(&name), rewrite)?;
            n += 1;
        }
    }
    Ok(n)
}

/// Generated or temporary: Atrous writes its own.
fn skipped(name: &str) -> bool {
    matches!(name, "node_modules" | "gpui-kit.d.ts" | "jsconfig.json" | ".git")
        || name.contains(".tmp")
        || name.ends_with(".error")
}

fn read_dir(dir: &Path) -> Vec<std::fs::DirEntry> {
    let mut entries: Vec<_> = std::fs::read_dir(dir).into_iter().flatten().flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    entries
}

/// Not a link, junction or other reparse point.
fn plain(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    !meta.file_type().is_symlink()
}

fn plain_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| plain(&m) && m.is_file())
}

fn plain_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| plain(&m) && m.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn brings_the_persons_own_files_and_leaves_the_old_home() {
        let root = std::env::temp_dir().join(format!("atrous-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let from = root.join(".config/herdr-app");
        let to = root.join(".config/atrous");
        let home_json = from.to_string_lossy().replace('\\', "\\\\");
        write(&from.join("settings.json"), &format!("{{\"zoom\": 1.1, \"core\": \"{}\", \"font\": \"{home_json}\\\\fonts\\\\x.ttf\"}}\n", "/opt/herdr-core/hc"));
        write(&from.join("keys.json"), "{}\n");
        write(&from.join("shared.json"), "{\"layout\": \"mine\", \"where\": \"~/.config/herdr-app/data\"}\n");
        write(&from.join("installed.json"), "{\"files\": {}, \"layout:main\": {}}\n");
        write(&from.join("AGENTS.md"), "herdr's guide");
        write(&from.join("window.json"), "{}");
        write(&from.join("themes/mine.json"), "{}");
        write(&from.join("layouts/main.json"), "{}");
        write(&from.join("layouts/fedra.json"), "{}");
        write(&from.join("layouts/fedra.svg"), "<svg/>");
        write(&from.join("layouts/mine.json"), "{\"preview\": \"mine.svg\"}");
        write(&from.join("layouts/mine.svg"), "<svg/>");
        write(&from.join("layouts/.state/main.json"), "{}");
        write(&from.join("layouts/.state/mine.json"), "{}");
        write(&from.join("mods/files/main.js"), "shipped");
        write(&from.join("mods/my-spaces/main.js"), "fedra");
        write(&from.join("mods/own/main.js"), "import { run } from \"herdr\";");
        write(&from.join("mods/own/gpui-kit.d.ts"), "generated");
        write(&from.join("mods/own/node_modules/x/index.js"), "dep");
        write(&from.join("data/files/store.json"), "{}");
        write(&from.join("data/files/store.json.tmp.1"), "{}");
        write(&from.join("accounts/state.json"), "{}");
        let before: Vec<_> = walk(&from);

        let report = migrate(&from, &to).unwrap();
        assert_eq!(report.files, ["settings.json", "keys.json", "shared.json"]);
        assert_eq!(report.themes, 1);
        assert_eq!(report.layouts, ["mine"]);
        assert_eq!(report.clicks, 2);
        assert_eq!(report.mods, ["own"]);
        assert_eq!(report.data, 1);

        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(to.join("settings.json")).unwrap()).unwrap();
        assert!(settings.get("core").is_none(), "herdr's core is not Atrous's");
        let font = settings["font"].as_str().unwrap();
        assert!(font.contains("atrous") && !font.contains("herdr-app"), "{font}");
        let shared = std::fs::read_to_string(to.join("shared.json")).unwrap();
        assert!(shared.contains("~/.config/atrous/data"), "{shared}");
        for gone in ["AGENTS.md", "window.json", "installed.json", "layouts/main.json", "layouts/fedra.json", "layouts/fedra.svg",
            "mods/files", "mods/my-spaces", "mods/own/gpui-kit.d.ts", "mods/own/node_modules", "accounts", "data/files/store.json.tmp.1"] {
            assert!(!to.join(gone).exists(), "{gone} came over");
        }
        for kept in ["layouts/mine.svg", "layouts/.state/main.json", "mods/own/main.js", "themes/mine.json", "data/files/store.json"] {
            assert!(to.join(kept).exists(), "{kept} is missing");
        }
        // The old home is exactly as it was.
        assert_eq!(walk(&from), before);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_never_followed() {
        let root = std::env::temp_dir().join(format!("atrous-migrate-junction-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let from = root.join("herdr-app");
        let outside = root.join("outside");
        write(&outside.join("secret.txt"), "not ours");
        write(&from.join("settings.json"), "{}");
        std::fs::create_dir_all(from.join("data/mod")).unwrap();
        let link = from.join("data/mod/linked");
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&outside).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
        let to = root.join("atrous");
        migrate(&from, &to).unwrap();
        assert!(!to.join("data/mod/linked").exists());
        assert!(outside.join("secret.txt").exists());
        std::fs::remove_dir(&link).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_toast_says_what_came() {
        *NOTE.lock().unwrap() = Some(Report { files: vec!["settings.json".into(), "keys.json".into()], themes: 2, layouts: vec!["mine".into()], clicks: 3, mods: vec![], data: 0 });
        let note = take_note().unwrap();
        let body = note["body"].as_str().unwrap();
        assert!(body.starts_with("settings, keys, 2 themes, 1 layout (mine), layout clicks."), "{body}");
        assert!(take_note().is_none(), "once");
    }

    fn walk(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push((p.clone(), std::fs::read(&p).unwrap()));
            }
        }
        out.sort();
        out
    }
}
