# Atrous: a fork of herdr-app

Atrous is a desktop app for terminals and coding agents. Keep work in spaces, see which agents need you, and leave terminals running when you close the window.

Atrous is a rebranded fork of [herdr-app](https://github.com/herdrdev/herdr-app) and [herdr-core](https://github.com/herdrdev/herdr-core) by herdrdev, both under the Apache License 2.0, the way Cursor forked VS Code. It starts from herdr-app 0.1.13. See [NOTICE](NOTICE) for the attribution and the list of changes, and [LICENSE](LICENSE).

## What changed from herdr-app

- **One app, core inside.** Atrous ships its core, atrous-core (short CLI `atc`, built from [`core/`](core/)), in the same install and release, at the same version. The core still runs as its own background process, so terminals and agents keep running when you close or update the window. There's no separate core to install or update.
- **New names, side by side with herdr.** The app is `atrous` (`atrous.exe`), its core is atrous-core with the short CLI `atc`, its home is `~/.config/atrous` (`ATROUS_HOME`), and every `HERDR_*` / `HC_*` variable is `ATROUS_*` / `ATC_*`. Atrous never looks at herdr's core, home, sockets or install folder, so both apps can be installed and open at the same time.
- **Your herdr-app setup comes along once.** The first time Atrous starts and `~/.config/atrous` doesn't exist, it copies your settings, keys, programs, themes, own layouts with their clicks, own mods, shared state and mod data from `~/.config/herdr-app`, rewrites `.config/herdr-app` paths in them, and says what came in a note. herdr-app's folder is only read.
- **Mods import from `"atrous"`.** `"herdr"` stays as another name for the same module, and `core()` is the new name for `hc()`, so herdr-app's mods load unchanged. The types are in `atrous.d.ts`.
- **Fedra is the built-in UI** and the default layout (see [fedra/README.md](fedra/README.md)): projects and agents in a tree, session-named tabs, the quick terminal, Files, Changes and Browser panels, the usage card, and one Settings with Accounts, Skills and Usage. The other layouts are Flow, Terminals and Classic (herdr's main layout, the safe fallback); Herdr 98 is gone.
- **No telemetry.** Atrous collects and sends no usage data, and Settings → Privacy says so.
- **Feedback** opens a new, prefilled [GitHub issue](https://github.com/zecod/atrous/issues/new) that you post yourself.
- **Updates** come from GitHub releases of zecod/atrous: one download per platform holds the app and its core, and they update together (terminals keep running). Until a release exists, a check simply finds nothing. Atrous sends no requests to herdr's servers.
- **Brand:** the Atrous mark replaces the herdr ram everywhere: app icon, setup screen, sidebar, macOS bundle and disk image.

Everything else works as in herdr-app: spaces, tabs and panes, the agents list, peek, remote machines over SSH, layouts and mods.

## Install

Atrous has no published release yet, so build it from source (below). Once [zecod/atrous releases](https://github.com/zecod/atrous/releases) exist, the installers are:

```powershell
# Windows (x64), in PowerShell
irm https://github.com/zecod/atrous/releases/latest/download/install.ps1 | iex
```

```sh
# macOS (Apple Silicon) and Linux
curl -fsSL https://github.com/zecod/atrous/releases/latest/download/install.sh | sh
```

The core comes inside: there's nothing else to install. A core still running from an earlier, separate atrous-core install keeps its terminals; Atrous's next start moves them to its own core.

## Build and install from source

One repo, one build, for every platform. You need Rust 1.95 or newer, [Zig 0.16.0](https://ziglang.org/download/) (`zig` on `PATH`, or `ZIG` set to it), libclang for bindgen (`LIBCLANG_PATH` pointing at its folder if it isn't found), git, and [just](https://github.com/casey/just) (optional). Windows also needs the Visual Studio 2022 Build Tools (C++ workload); macOS the Xcode Command Line Tools; Linux a desktop session, a working Vulkan driver and the development packages listed in [CI](.github/workflows/ci.yml).

```sh
git clone --recurse-submodules https://github.com/zecod/atrous.git
cd atrous
just build        # or: scripts/build (bash), scripts\build.ps1 (PowerShell)
just install      # or: scripts/install-linux, scripts/install-macos, scripts\install-windows.ps1
```

`just build` builds the app and its core (`cargo build --release` in the repo and in `core/`) and puts the core beside the app in `target/release`: `atrous-core`, `atc`, and on Windows `conpty\`. `just install` runs the build, then installs:

- **Windows:** `%LOCALAPPDATA%\Programs\atrous\` with `atrous.exe`, `atrous-core.exe`, `atc.exe` (a hard link to it) and `conpty\`; an **Atrous** Start menu shortcut; that one folder on your user `PATH` (`atrous` and `atc` in a new terminal).
- **macOS:** `~/Applications/Atrous.app`, with the core as a helper bundle inside (`Contents/Helpers/Atrous Core.app`, its own signing identity `io.github.zecod.atrous.core`), and `~/.local/bin/atrous` and `~/.local/bin/atc` links into it. Release builds are signed and packed by `scripts/package`; `scripts/mac-dmg` makes the drag-to-Applications `Atrous.dmg` (needs a Developer ID certificate).
- **Linux:** `~/.local/bin/atrous` and `~/.local/bin/atc` pointing at `target/release`, and a launcher entry.

Atrous starts its core when it needs one and leaves it running; terminals Atrous starts find `atc` and `atrous` first on their `PATH`. Reinstalling or updating keeps terminals running: the next start moves them to the new core. Atrous never touches an installed herdr-app or its core.

### Tests

```sh
just test         # bun tests of the shipped mods, then cargo test --locked
just test-core    # atrous-core's tests (core/)
```

Never run a bare `atrous` from `target/` on a machine where you also use the app without `ATROUS_HOME` and `ATC_SESSION` pointing at a scratch home and session: it opens a second window on your real setup and core.

### The core and its upstreams

`core/` is atrous-core, [zecod/atrous-core](https://github.com/zecod/atrous-core) brought in with `git subtree` (its history included); it keeps its own Cargo workspace and lock file. It's a fork of [herdr-core](https://github.com/herdrdev/herdr-core). To take their changes:

```sh
git subtree pull --prefix=core https://github.com/herdrdev/herdr-core master # herdr-core
git subtree pull --prefix=core https://github.com/zecod/atrous-core main     # atrous-core, while it lives on
```

Resolve the merge in `core/` (keep Atrous's names: `atrous-core`, `atc`, `ATC_*`), keep `core/crates/atrous-core/Cargo.toml` at the app's version, and run `just test-core`. The app itself (`src/`, a fork of [herdr-app](https://github.com/herdrdev/herdr-app)) merges herdr-app as usual: `git fetch https://github.com/herdrdev/herdr-app master && git merge FETCH_HEAD`. `core/vendor/ghostty` is its own submodule entry in `.gitmodules` (pinned where atrous-core pins it); after a subtree pull moves that pin, run `git submodule update --init core/vendor/ghostty`.

## Find your work

A **space** holds work on one machine, usually in one repo. Each space has **tabs**. Split a tab into **panes** to put terminals or mod panels beside each other.

The agents sidebar brings agents from your spaces into one list, including workers started by another agent. Agents that report status show as **Working**, **Blocked** (waiting for you), **Done** (finished while you were looking elsewhere) or **Idle**.

The window arranges terminals; the core runs them. Closing the window leaves them running; closing a pane or tab ends its terminals.

Add an SSH machine from Settings → Machines; spaces on that machine run their terminals there, in that machine's own atrous-core.

## Make it yours

Open the command palette to find an action by name, or open Settings to change fonts, colors, sounds and other preferences. A **layout** arranges the window. **Mods** are small JavaScript programs that draw its panels, menus and dialogs. Duplicate a shipped layout or mod before changing its structure or code; Atrous updates the shipped ones on start.

Ctrl+Shift+P shows every command and its key (Cmd+Shift+P on macOS). Change any key in `keys.json`.

[Layouts and mods](docs/mods.md) · [Commands](docs/commands.md) · [Security and privacy](docs/security.md)

Mods are trusted code, not sandboxed extensions. Read a mod before installing it.

## For agents

```sh
atrous --skill      # the agent guide for driving the window
atrous ls
atrous status
atrous commands
```

Use atrous-core (`atc --skill`) for running and coordinating programs; use the app to change what you see.

## License

Apache License 2.0. Atrous is a modified fork of herdr-app and herdr-core by herdrdev; see [NOTICE](NOTICE). Third-party components are listed in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES). "herdr" and its logo belong to their owners; Atrous uses neither as its own brand.
