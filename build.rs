//! Embeds the default mods (defaults/mods/** and Fedra's, fedra/home/mods/**),
//! the shipped layouts (Fedra's, fedra/home/layouts/*), the files Fedra keeps
//! in the home (fedra/home/accounts/*, fedra/home/skills/**), the program
//! icons (defaults/icons/*) and the frame's mods (defaults/frame/**) so Atrous
//! can install them.
//!
//! Worktrees may share one target dir, and with it this script and its output.
//! So nothing here names this checkout: paths are relative to the package and
//! the generated code includes files through the compiling crate's
//! `CARGO_MANIFEST_DIR`.

use std::path::Path;

/// Development leftovers that never ship: editor and build output, logs.
fn skipped(p: &Path) -> bool {
    let name = p.file_name().unwrap_or_default().to_string_lossy();
    name.starts_with('.')
        || matches!(name.as_ref(), "node_modules" | "bin" | "obj" | "jsconfig.json" | "gpui-kit.d.ts" | "state.json")
        || [".tmp", ".error", ".log", ".fedra-tmp", ".exe", ".dll", ".pdb"].iter().any(|e| name.ends_with(e))
}

fn walk(dir: &Path, base: &Path, root: &Path, out: &mut Vec<String>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).filter(|p| !skipped(p)).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            walk(&p, base, root, out);
        } else {
            let path = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            println!("cargo:rerun-if-changed={path}");
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.push(format!("    ({rel:?}, include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/{path}\"))),"));
        }
    }
}

fn embed(base: &Path, folder: &str, name: &str, file: &str) {
    embed_all(base, &[(folder, "")], name, file);
}

/// Mod folders from several roots as one list (`<mod>/<path>`). A folder
/// without a main.js isn't a mod yet (one still being written): it's left out.
fn embed_mods(base: &Path, roots: &[&str], name: &str, file: &str) {
    let mut lines = Vec::new();
    for root in roots {
        println!("cargo:rerun-if-changed={root}");
        let dir = base.join(root);
        let mut mods: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_dir() && !skipped(p)).collect();
        mods.sort();
        for m in mods {
            println!("cargo:rerun-if-changed={}", m.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"));
            if !m.join("main.js").is_file() {
                println!("cargo:warning=not shipped (no main.js yet): {}", m.display());
                continue;
            }
            walk(&m, base, &dir, &mut lines);
        }
    }
    let code = format!("pub const {name}: &[(&str, &[u8])] = &[\n{}\n];\n", lines.join("\n"));
    std::fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join(file), code).unwrap();
}

/// Several folders as one list; each file's path is `<prefix><path in its folder>`.
fn embed_all(base: &Path, folders: &[(&str, &str)], name: &str, file: &str) {
    let mut lines = Vec::new();
    for (folder, prefix) in folders {
        println!("cargo:rerun-if-changed={folder}");
        let root = base.join(folder);
        let mut found = Vec::new();
        walk(&root, base, &root, &mut found);
        lines.extend(found.into_iter().map(|l| l.replacen("    (\"", &format!("    (\"{prefix}"), 1)));
    }
    let code = format!("pub const {name}: &[(&str, &[u8])] = &[\n{}\n];\n", lines.join("\n"));
    std::fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join(file), code).unwrap();
}

fn main() {
    let base = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // Fedra is the built-in UI: its mods ship beside the stock ones.
    embed_mods(&base, &["defaults/mods", "fedra/home/mods"], "DEFAULT_MODS", "default_mods.rs");
    embed(&base, "fedra/home/layouts", "FEDRA_LAYOUTS", "fedra_layouts.rs");
    embed_all(&base, &[("fedra/home/accounts", "accounts/"), ("fedra/home/skills", "skills/")], "HOME_FILES", "home_files.rs");
    embed(&base, "defaults/icons", "DEFAULT_ICONS", "default_icons.rs");
    embed(&base, "defaults/frame", "FRAME_MODS", "frame_mods.rs");

    // Windows takes the window, taskbar and Start menu icon from the program file.
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=assets/brand/atrous.ico");
        winresource::WindowsResource::new()
            .set_icon("assets/brand/atrous.ico")
            .set("ProductName", "Atrous")
            .set("FileDescription", "Atrous")
            .compile()
            .expect("cannot embed the icon");
    }
}
