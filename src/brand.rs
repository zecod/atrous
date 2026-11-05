//! Atrous's names and addresses, in one place. Atrous is a fork of herdr-app
//! (see NOTICE): the app is `atrous`, its core `atrous-core` with the short
//! CLI `atc`, and its releases are GitHub releases of zecod/atrous and
//! zecod/atrous-core. Nothing here, or anywhere in the app, talks to herdr's
//! servers.

/// What people read.
pub const NAME: &str = "Atrous";
/// The app's command and Cargo package.
pub const BIN: &str = "atrous";
/// The window and bundle id (also the default `app_id`, so the dock and
/// taskbar keep Atrous apart from herdr running beside it).
pub const APP_ID: &str = "io.github.zecod.atrous";
/// The core: its full binary, and the short CLI installed beside it.
pub const CORE: &str = "atrous-core";
pub const CORE_CLI: &str = "atc";
/// The app's document in the core.
pub const DOC: &str = "atrous";

pub const REPO: &str = "https://github.com/zecod/atrous";
pub const CORE_REPO: &str = "https://github.com/zecod/atrous-core";
/// Release notes media (screenshots, clips) are assets of the release they
/// describe: `<MEDIA>v0.2.0/peek.webp`. The app fetches no other notes media.
pub const MEDIA: &str = "https://github.com/zecod/atrous/releases/download/";
/// Feedback opens a new issue here, prefilled; nothing is posted for the person.
pub const ISSUES_NEW: &str = "https://github.com/zecod/atrous/issues/new";

fn env_url(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|u| !u.is_empty()).map(|u| u.trim_end_matches('/').to_owned())
}

/// Another place for the app's releases (`ATROUS_RELEASES_URL`: tests,
/// mirrors), laid out like `<url>/app/manifest.json`.
pub fn test_releases() -> Option<String> {
    env_url("ATROUS_RELEASES_URL")
}

/// Another place for the core's releases: atrous-core's own override,
/// `ATC_RELEASES_URL`, laid out like GitHub's `<url>/latest/download/<file>`
/// (the core's installer and `atc update` read the same variable).
pub fn core_releases() -> Option<String> {
    env_url("ATC_RELEASES_URL")
}

/// A file of the app's latest release (`manifest.json`, `install.sh`).
pub fn app_latest(file: &str) -> String {
    match test_releases() {
        Some(url) => format!("{url}/app/{file}"),
        None => format!("{REPO}/releases/latest/download/{file}"),
    }
}

/// A file of one app release (`changelog.md` of 0.2.0: tag `v0.2.0`).
pub fn app_release(version: &str, file: &str) -> String {
    match test_releases() {
        Some(url) => format!("{url}/app/{version}/{file}"),
        None => format!("{REPO}/releases/download/v{version}/{file}"),
    }
}

/// A file of the core's latest release (`manifest.json`, `install.ps1`).
pub fn core_latest(file: &str) -> String {
    let base = core_releases().unwrap_or_else(|| format!("{CORE_REPO}/releases"));
    format!("{base}/latest/download/{file}")
}

/// The command that installs the app, for people to copy.
pub fn app_install_command() -> String {
    if cfg!(windows) {
        format!("powershell -c \"irm {} | iex\"", app_latest("install.ps1"))
    } else {
        format!("curl -fsSL {} | sh", app_latest("install.sh"))
    }
}

/// The command that installs the core, for people to copy.
pub fn core_install_command() -> String {
    if cfg!(windows) {
        format!("powershell -c \"irm {} | iex\"", core_latest("install.ps1"))
    } else {
        format!("curl -fsSL {} | sh", core_latest("install.sh"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releases_are_github_releases_of_zecod() {
        if test_releases().is_some() || core_releases().is_some() {
            return;
        }
        assert_eq!(app_latest("manifest.json"), "https://github.com/zecod/atrous/releases/latest/download/manifest.json");
        assert_eq!(app_release("0.2.0", "changelog.md"), "https://github.com/zecod/atrous/releases/download/v0.2.0/changelog.md");
        assert_eq!(core_latest("install.sh"), "https://github.com/zecod/atrous-core/releases/latest/download/install.sh");
        for url in [app_latest("x"), core_latest("x"), app_install_command(), core_install_command()] {
            assert!(!url.contains("herdr"), "{url}");
        }
    }
}
