# Atrous app

The Atrous desktop app (`atrous`): a native GPUI client of atrous-core
(`atc`), which ships inside it. Atrous is a rebranded fork of herdr-app
0.1.13 (Apache-2.0, see NOTICE); its core is a fork of herdr-core.

One repo, one build, one version: the app at the root, the core in `core/`
(its own Cargo workspace and AGENTS.md, brought in with `git subtree`, see
README "The core and its upstreams"). `just build` (`scripts/build`,
`scripts/build.ps1`) builds both and stages the core beside the app;
`scripts/package` packs both into one archive per platform. The app uses the
core beside its executable (macOS: `Contents/Helpers/Atrous Core.app`) first
(`src/core_bin.rs`), and at start restarts a core running from elsewhere or
older into it, the planned way (terminals kept). Keep
`core/crates/atrous-core/Cargo.toml` at the app's version.

If AGENTS.local.md exists, read it too: the maintainer's local rules.

## Names (the fork's contract)

Keep these exact, so the app, the core and the built-in UI connect:

- App, CLI and Cargo package `atrous`; display name Atrous; window and bundle
  id `io.github.zecod.atrous` (`src/brand.rs` holds the names and addresses).
- Home `~/.config/atrous`, `ATROUS_HOME`; every app env var is `ATROUS_*`.
- Core `atrous-core` and `atc`; core env vars `ATC_*`, never `HC_*`; the
  app's core document is `atrous`; labels the app sets are `atrous.*`.
- Mods import `"atrous"`; `"herdr"` stays an alias, and `hc()` an alias of
  `core()`, so herdr-app mods keep loading.
- Updates: GitHub releases of zecod/atrous, one archive per platform with
  the app and its core. No separate core update. No request ever goes to
  herdr's servers, and there is no telemetry.
- Terminals Atrous starts for a known agent carry `atrous.agent=<key>` (the
  programs.json key, `src/programs.rs` `agent_of`).
- No herdr logo or ram/sheep art anywhere (`assets/brand/` has the Atrous mark).
- Fedra (`fedra/home/`) is the built-in UI. `build.rs` embeds its mods with
  `defaults/mods`, its layouts (`fedra`, the default; `flow` when there) beside
  Classic (`main`, hidden, the escape hatch's) and Terminals, and its
  `accounts/` launchers and `skills/`, which the app writes into the home on
  start. Settings is Fedra's `my-settings`; the first-run flow is the
  `onboarding` mod (it sets shared `atrous.onboarded`), which reads
  `data/migration.json` after a herdr-app migration.

Atrous must run side by side with an installed herdr-app: never read or
write herdr's core, sockets or install folder. The only herdr path the app
reads is `~/.config/herdr-app`, once, in `src/migrate.rs`.

## Compatibility

Preserve compatibility with released versions and installed user data.
Keep the `herdr` module alias and `hc()` working for mods written for herdr-app.

## Before you grow the app's core

The app's core (the model, machine layout documents, commands, and shared mod APIs)
stays small; everything else is mods. Before adding anything to it, answer:

1. Does the app itself act on it (it changes what the app does, not only
   how something looks)?
2. Can only the app see it (e.g. a change that happens while no mod is
   watching)?
3. Can mods not do it correctly, even with care?

If all three are no, it belongs in mods (their shared storage, their own
code), even at the price of some repetition.

`atrous --skill` prints the window manual in `src/SKILL.md`.
Keep it current when changing agent-facing behavior.

## The guide users' agents read

`defaults/AGENTS.md` is written into every user's `~/.config/atrous` on
every start: it's how their agents learn what the app can do. A change to
what users or agents can do (a command, a setting, a layout or mod
feature, a file) updates it in the same commit. `cargo test` checks that it
names every command and settings.json key; the rest is on you. Keep it a
map with rules and short examples: the `.d.ts` files are generated and are
the full API (`defaults/atrous.d.ts`; the app also writes a `herdr.d.ts`
that re-exports it for the alias).

## What ships in the box

`defaults/` is built into the app: mods, `layouts/*.json`, `keys.json`
(Linux, Windows) and `keys.macos.json` (Mac). Shipped layouts and mods are
replaced on start; edited versions are moved to personal copies. Layout
clicks are kept separately. `keys.json` is installed when missing; files matching
an earlier shipped original byte-for-byte are upgraded to the current defaults.
Edited keys files are never replaced. Keep release originals in
`src/keys/shipped/` when changing defaults.

## Platform differences

Gate per OS only where the OS really behaves differently. A one-line
`cfg!(windows)` next to the quirk is fine, with a comment saying why; anything
bigger goes behind one small module per concern rather than `#[cfg]` spread
through shared code. Give the quirk a test on its platform and keep the other
platforms' behavior unchanged (and tested). Windows and macOS changes are
checked on those systems, not only by cross-compiling.

## Building and testing

`just build`, `just test` (what CI runs, on Linux), `just check` (the tests).
`just install` builds and installs the desktop app using the platform installer.
On Windows it updates `%LOCALAPPDATA%\Programs\atrous` and the Start menu;
quit and reopen Atrous to use the new build. Windows recipes use PowerShell by default;
`just --shell pwsh --shell-arg -Command <recipe>` uses pwsh.

Never run a bare `target/*/atrous` (no arguments) on a machine where you
also use the app without `ATROUS_HOME` pointing at a scratch home: it
opens a second window on your real setup. Subcommands and `--help` only
talk. A scratch home starts empty: set `ATROUS_MIGRATE_FROM` to a copy of a
herdr-app home to try the first-start migration, never the real one.

On Linux, test UI changes in the sandbox: `scripts/sandbox up`, then `do
<command> [json]`, `status`, `shot` (screenshot), `move|click|drag`
(pointer input, window px), `type`, `key <keysym> [Control_L ...]`, `atc
...`, `restart`, `down`. It has its own core, home and a headless display
(Weston + Xwayland) under `/var/tmp/atrous-sandbox`, so nothing pops up
on your screen. Never fake input on a real display. Run `scripts/sandbox
down` when done.

## Contributing

Work on a branch and open a pull request. CI must pass. Commit messages:
lowercase conventional commits, single line.

CHANGELOG.md: every Atrous release gets a `## [x.y.z] - YYYY-MM-DD` section
(`### New` / `### Fixed`) at the top, written at release time from the
commits since the last tag; Atrous shows it as the update notes. The
sections below 0.2.0 are herdr-app's history: leave them as they are. One
line per change, in user words (what a person notices, not code).

Add `<!-- spotlight -->` below a version heading to open What's New once
when users update to it (including skipped versions). Use `<!-- spotlight macos -->`
or a space-separated list such as `<!-- spotlight macos linux -->` to open it
only on those platforms: `macos`, `linux`, `windows`. Release media are assets
of that version's GitHub release (`scripts/notes-media.ts`); the app fetches
no other notes media.

A release is a `v*` tag matching Cargo.toml; `.github/workflows/release.yml`
builds every platform and publishes the GitHub release with `manifest.json`,
the tarballs, `changelog.md` and the installers.

Never stop, signal, or restart someone else's app or core. Use an isolated
app home and core session for testing (`ATROUS_HOME`, `ATC_SESSION`), and
`ATROUS_BACKGROUND=1` so the window opens behind the others and never takes
the foreground from the person at the keyboard.
