//! Usage data: none. herdr-app sent a small anonymous report once a day;
//! Atrous removed that. Nothing is collected, written or sent, and there is
//! no setting to turn it on. The calls below stay so the window's code reads
//! as before, and they do nothing. `status()` is what Settings → Privacy and
//! `telemetry()` in mods show.

use serde_json::{Value, json};

/// What the window used to report. Kept for its callers; never stored.
#[derive(Default)]
#[allow(dead_code)]
pub struct Observation {
    pub foreground: bool,
    pub agents: Vec<Option<String>>,
    pub agents_working: usize,
    pub spaces: usize,
    pub tabs: usize,
    pub terminals: usize,
    pub layout: String,
    pub mods: Vec<String>,
    pub theme: String,
    pub welcome: Option<String>,
}

/// Never: Atrous collects nothing.
pub fn collecting() -> bool {
    false
}

pub fn observe(_: Observation) {}

pub fn command(_: &'static str) {}

pub fn count(_: &'static str) {}

pub fn window_open() {}

pub fn quit() {}

pub fn clock() {}

pub fn start() {}

/// What the settings screen and `telemetry()` show: always off, nothing sent.
pub fn status() -> Value {
    json!({
        "enabled": false,
        "setting": false,
        "off_because": "Atrous",
        "sends": false,
        "endpoint": "",
        "draft": null,
        "queued": [],
        "last_sent": null,
    })
}

/// A release version (`0.2.0`, `0.2.0-rc.1`), else `other`: never a free string.
pub(crate) fn version(v: &str) -> String {
    let v = crate::core_bin::number(v).trim_start_matches('v');
    let number = |s: &str| !s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit());
    let (core, pre) = v.split_once('-').map_or((v, None), |(c, p)| (c, Some(p)));
    let parts: Vec<&str> = core.split('.').collect();
    let pre_ok = pre.is_none_or(|p| {
        let (label, n) = p.split_once('.').map_or((p, None), |(l, n)| (l, Some(n)));
        matches!(label, "alpha" | "beta" | "rc" | "preview") && n.is_none_or(number)
    });
    if parts.len() == 3 && parts.iter().all(|p| number(p)) && pre_ok { v.to_owned() } else { "other".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_collected_or_sent() {
        assert!(!collecting());
        let s = status();
        assert_eq!(s["enabled"], false);
        assert_eq!(s["sends"], false);
        assert_eq!(s["endpoint"], "");
    }

    #[test]
    fn versions_are_release_numbers_or_other() {
        assert_eq!(version("atc 0.1.18"), "0.1.18");
        assert_eq!(version("0.2.0-rc.1"), "0.2.0-rc.1");
        assert_eq!(version("0.2.0-dirty"), "other");
    }
}
