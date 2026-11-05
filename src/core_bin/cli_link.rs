//! The DMG has no installer to put the app's CLI on PATH: Atrous links
//! `~/.local/bin/atrous` to itself and `~/.local/bin/atc` to the core inside
//! it (`Contents/Helpers/Atrous Core.app/Contents/MacOS/atrous-core`).

use std::io;
use std::path::{Path, PathBuf};

const CORE_IN_APP: &str = "Contents/Helpers/Atrous Core.app/Contents/MacOS/atrous-core";

fn atrous_bundle(exe: &Path) -> bool {
    exe.is_absolute() && exe.ends_with("Atrous.app/Contents/MacOS/Atrous")
}

fn installed_bundle(exe: &Path) -> bool {
    atrous_bundle(exe)
        && !exe.starts_with("/Volumes")
        && !exe.components().any(|c| c.as_os_str() == "AppTranslocation" || c.as_os_str() == "target")
}

/// The core inside the bundle `exe` runs from (`Atrous.app/Contents/MacOS/Atrous`).
fn bundled_core(exe: &Path) -> Option<PathBuf> {
    Some(exe.parent()?.parent()?.parent()?.join(CORE_IN_APP))
}

/// A link Atrous may repoint: into an Atrous.app's core, or to the separately
/// installed atrous-core this replaces (`~/.local/share/atrous-core/...`).
fn our_core_link(home: &Path, target: &Path) -> bool {
    target.ends_with(CORE_IN_APP) || target.starts_with(home.join(".local/share/atrous-core"))
}

pub(super) fn ensure(home: &Path, exe: &Path) -> io::Result<()> {
    if !installed_bundle(exe) {
        return Ok(());
    }
    link(&home.join(".local/bin/atrous"), exe, atrous_bundle)?;
    if let Some(core) = bundled_core(exe).filter(|c| c.is_file()) {
        link(&home.join(".local/bin/atc"), &core, |t| our_core_link(home, t))?;
    }
    Ok(())
}

/// Points `link` at `target`: made if missing, repointed only if it's a
/// symlink `ours` claims; anything else is someone's and stays.
fn link(link: &Path, target: &Path, ours: impl Fn(&Path) -> bool) -> io::Result<()> {
    match std::fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let current = std::fs::read_link(link)?;
            if current == target {
                return Ok(());
            }
            let resolved = if current.is_absolute() { current } else { link.parent().unwrap().join(current) };
            if !ours(&resolved) {
                return Ok(());
            }
            std::fs::remove_file(link)?;
        }
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::fs::create_dir_all(link.parent().unwrap())?;
    std::os::unix::fs::symlink(target, link)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn repairs_only_our_cli_link() {
        let home = std::env::temp_dir().join(format!("atrous-cli-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let exe = home.join("Applications/Atrous.app/Contents/MacOS/Atrous");
        let link = home.join(".local/bin/atrous");
        ensure(&home, &exe).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), exe);
        // Running it again leaves the same link alone.
        ensure(&home, &exe).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), exe);

        for old in [
            home.join("old/Atrous.app/Contents/MacOS/Atrous"),
            "../../Applications/Atrous.app/Contents/MacOS/Atrous".into(),
            "/Volumes/Atrous/Atrous.app/Contents/MacOS/Atrous".into(),
            "/private/var/folders/AppTranslocation/old/d/Atrous.app/Contents/MacOS/Atrous".into(),
        ] {
            std::fs::remove_file(&link).unwrap();
            symlink(old, &link).unwrap();
            ensure(&home, &exe).unwrap();
            assert_eq!(std::fs::read_link(&link).unwrap(), exe);
        }
        let old = home.join("previous/Atrous.app/Contents/MacOS/Atrous");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, "previous executable").unwrap();
        std::fs::remove_file(&link).unwrap();
        symlink(&old, &link).unwrap();
        ensure(&home, &exe).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), exe);
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "previous executable");

        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, "personal CLI").unwrap();
        ensure(&home, &exe).unwrap();
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "personal CLI");
        std::fs::remove_file(&link).unwrap();
        let foreign = home.join("other-app");
        symlink(&foreign, &link).unwrap();
        ensure(&home, &exe).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), foreign);
        std::fs::remove_file(&link).unwrap();

        for skipped in [
            "/Volumes/Atrous/Atrous.app/Contents/MacOS/Atrous",
            "/private/var/folders/AppTranslocation/random/d/Atrous.app/Contents/MacOS/Atrous",
            "/work/target/debug/Atrous.app/Contents/MacOS/Atrous",
            "/work/target/debug/atrous",
            "/Applications/Other.app/Contents/MacOS/Atrous",
        ] {
            ensure(&home, Path::new(skipped)).unwrap();
            assert!(link.symlink_metadata().is_err(), "{skipped}");
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn links_atc_to_the_core_inside_the_app() {
        let home = std::env::temp_dir().join(format!("atrous-atc-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let exe = home.join("Applications/Atrous.app/Contents/MacOS/Atrous");
        let core = home.join("Applications/Atrous.app").join(CORE_IN_APP);
        std::fs::create_dir_all(core.parent().unwrap()).unwrap();
        std::fs::write(&core, "core").unwrap();
        let atc = home.join(".local/bin/atc");
        ensure(&home, &exe).unwrap();
        assert_eq!(std::fs::read_link(&atc).unwrap(), core);
        // The separate install's link moves over; someone's own atc stays.
        std::fs::remove_file(&atc).unwrap();
        symlink(home.join(".local/share/atrous-core/current/Contents/MacOS/atrous-core"), &atc).unwrap();
        ensure(&home, &exe).unwrap();
        assert_eq!(std::fs::read_link(&atc).unwrap(), core);
        std::fs::remove_file(&atc).unwrap();
        symlink("/opt/homebrew/bin/something-else", &atc).unwrap();
        ensure(&home, &exe).unwrap();
        assert_eq!(std::fs::read_link(&atc).unwrap(), Path::new("/opt/homebrew/bin/something-else"));
        std::fs::remove_dir_all(&home).unwrap();
    }
}
