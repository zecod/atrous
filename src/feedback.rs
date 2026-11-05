//! Feedback, written by the person (or drafted by an agent and read by the
//! person) and posted by them: the app opens a new GitHub issue on
//! zecod/atrous, prefilled with the message and the versions below. Nothing
//! is sent by the app itself; screenshots go into the issue on GitHub.
use serde_json::{Value, json};
use std::path::PathBuf;

pub const MAX_IMAGES: usize = 3;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// Browsers and GitHub take URLs of a few thousand characters; a longer
/// message is cut, with a note, rather than failing to open.
const MAX_URL: usize = 7000;

/// The issue as it will open: `title`, `body` (Markdown) and the `url` that opens it.
pub fn draft(message: &str, _email: &str, _images: usize, from: &str, layout: &str) -> Value {
    let message = message.trim();
    let title: String = message.lines().next().unwrap_or_default().chars().take(80).collect();
    let core = crate::update::core().version.as_deref().map(crate::telemetry::version).unwrap_or_else(|| "unknown".into());
    let layout = if crate::window::shipped_layouts().contains(&layout) { layout } else { "other" };
    let about = format!(
        "{} {} · {} {} · {} {core} · layout {layout}",
        crate::brand::NAME,
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        crate::brand::CORE,
    );
    let drafted = if from == "agent" { "\n_Drafted by an agent, read by the person before opening._" } else { "" };
    let mut text = message.to_owned();
    let mut body = format!("{text}\n\n---\n{about}{drafted}\n");
    let mut url = issue_url(&title, &body);
    while url.len() > MAX_URL && !text.is_empty() {
        let keep = text.chars().count() * 3 / 4;
        text = text.chars().take(keep).collect();
        body = format!("{text}\n\n_(shortened: paste the rest here)_\n\n---\n{about}{drafted}\n");
        url = issue_url(&title, &body);
    }
    json!({
        "from": if from == "agent" { "agent" } else { "person" },
        "title": title,
        "body": body,
        "url": url,
    })
}

fn issue_url(title: &str, body: &str) -> String {
    format!("{}?title={}&body={}", crate::brand::ISSUES_NEW, encode(title), encode(body))
}

/// Percent-encodes a query value (RFC 3986 unreserved characters stay).
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Where the form keeps the screenshots it shows (its data folder: `image()` reads from the app home).
fn shots_dir() -> PathBuf { crate::mods::app_dir().join("data").join("frame-feedback") }

fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("png") }
    else if bytes.starts_with(&[0xff, 0xd8, 0xff]) { Some("jpg") }
    else { None }
}

/// Keeps a pasted or picked image for the form: PNG or JPEG as is, any other
/// image as PNG. Returns its path from the app home.
pub fn attach(bytes: &[u8]) -> Result<String, String> {
    let (bytes, ext) = match sniff(bytes) {
        Some(ext) => (bytes.to_vec(), ext),
        None => {
            let img = image::load_from_memory(bytes).map_err(|_| "That isn't an image Atrous can read.".to_owned())?;
            let mut png = std::io::Cursor::new(Vec::new());
            img.write_to(&mut png, image::ImageFormat::Png).map_err(|_| "Couldn't convert that image.".to_owned())?;
            (png.into_inner(), "png")
        }
    };
    if bytes.len() > MAX_IMAGE_BYTES { return Err("That image is over 5 MB.".into()); }
    let dir = shots_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let name = format!("shot-{stamp}.{ext}");
    std::fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(format!("data/frame-feedback/{name}"))
}

/// Picker and external drops share the same conversion and size limits.
pub fn attach_files(paths: &[PathBuf]) -> Vec<Value> {
    paths.iter().take(MAX_IMAGES).map(|p| {
        match std::fs::read(p) {
            Ok(bytes) => match attach(&bytes) {
                Ok(path) => json!({ "path": path }),
                Err(error) => json!({ "error": error }),
            },
            Err(_) => json!({ "error": "Couldn't read that file." }),
        }
    }).collect()
}

/// Drops the form's screenshots (a new form starts empty).
pub fn clear_shots() {
    let Ok(entries) = std::fs::read_dir(shots_dir()) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with("shot-") { let _ = std::fs::remove_file(e.path()); }
    }
}

/// Always: opening an issue needs only a browser.
pub fn available() -> bool { true }

fn validate(body: &Value) -> Result<(), String> {
    let title = body["title"].as_str().unwrap_or_default();
    if title.trim().is_empty() { return Err("Write a message first.".into()); }
    let url = body["url"].as_str().unwrap_or_default();
    // Only ever a new issue on Atrous's own repo.
    if !url.starts_with(&format!("{}?", crate::brand::ISSUES_NEW)) { return Err("Not an Atrous issue link.".into()); }
    Ok(())
}

/// Opens the prefilled issue in the browser; the person posts it there.
pub async fn send(body: Value, _shots: Vec<String>) -> Result<(), String> {
    validate(&body)?;
    let url = body["url"].as_str().unwrap_or_default().to_owned();
    crate::links::open(&crate::links::Target::Url(url));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_issue_is_prefilled_and_custom_layouts_are_hidden() {
        let body = draft("  broken  \nmore", "a@b.c", 2, "agent", "private-layout");
        assert_eq!(body["title"], "broken");
        assert_eq!(body["from"], "agent");
        let text = body["body"].as_str().unwrap();
        assert!(text.starts_with("broken  \nmore\n"), "{text}");
        assert!(text.contains("layout other"), "{text}");
        assert!(!text.contains("a@b.c"), "no email in the issue: {text}");
        let url = body["url"].as_str().unwrap();
        assert!(url.starts_with("https://github.com/zecod/atrous/issues/new?title=broken&body="), "{url}");
        assert!(draft("ok", "", 0, "person", "main")["body"].as_str().unwrap().contains("layout main"));
    }
    #[test]
    fn long_messages_are_cut_to_a_url_browsers_open() {
        let body = draft(&"é".repeat(4000), "", 0, "person", "main");
        assert!(body["url"].as_str().unwrap().len() <= MAX_URL);
        assert!(body["body"].as_str().unwrap().contains("shortened"));
    }
    #[test]
    fn only_atrous_issue_links_open() {
        assert!(validate(&draft("", "", 0, "person", "main")).is_err());
        assert!(validate(&draft("ok", "", 0, "person", "main")).is_ok());
        assert!(validate(&json!({ "title": "x", "url": "https://example.com/?x" })).is_err());
    }
    #[test]
    fn only_png_and_jpeg_leave_as_they_are() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        assert_eq!(sniff(b"GIF89a"), None);
        assert_eq!(encode("a b/é"), "a%20b%2F%C3%A9");
    }
}
