# Atrous: a fork of herdr-app

Atrous is a desktop app for terminals and coding agents. Keep work in spaces, see which agents need you, and leave terminals running when you close the window.

Atrous is a rebranded fork of [herdr-app](https://github.com/herdrdev/herdr-app) and [herdr-core](https://github.com/herdrdev/herdr-core) by herdrdev, both under the Apache License 2.0, the way Cursor forked VS Code. It starts from herdr-app 0.1.13. See [NOTICE](NOTICE) for the attribution and the list of changes, and [LICENSE](LICENSE).

## What changed from herdr-app

- **New names, side by side with herdr.** The app is `atrous` (`atrous.exe`), its core is [atrous-core](https://github.com/zecod/atrous-core) with the short CLI `atc`, its home is `~/.config/atrous` (`ATROUS_HOME`), and every `HERDR_*` / `HC_*` variable is `ATROUS_*` / `ATC_*`. Atrous never looks at herdr's core, home, sockets or install folder, so both apps can be installed and open at the same time.
- **Your herdr-app setup comes along once.** The first time Atrous starts and `~/.config/atrous` doesn't exist, it copies your settings, keys, programs, themes, own layouts with their clicks, own mods, shared state and mod data from `~/.config/herdr-app`, rewrites `.config/herdr-app` paths in them, and says what came in a note. herdr-app's folder is only read.
- **Mods import from `"atrous"`.** `"herdr"` stays as another name for the same module, and `core()` is the new name for `hc()`, so herdr-app's mods load unchanged. The types are in `atrous.d.ts`.
- **Fedra is the built-in UI** and the default layout (see [fedra/README.md](fedra/README.md)): projects and agents in a tree, session-named tabs, the quick terminal, Files, Changes and Browser panels, the usage card, and one Settings with Accounts, Skills and Usage. The other layouts are Flow, Terminals and Classic (herdr's main layout, the safe fallback); Herdr 98 is gone.
- **No telemetry.** Atrous collects and sends no usage data, and Settings → Privacy says so.
- **Feedback** opens a new, prefilled [GitHub issue](https://github.com/zecod/atrous/issues/new) that you post yourself.
- **Updates** come from GitHub releases of zecod/atrous and zecod/atrous-core. Until a release exists, a check simply finds nothing. Atrous sends no requests to herdr's servers.
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

They also install atrous-core if it's missing, and Atrous offers to install or update a core it can't use.

## Build and install from source

Clone with submodules. You need Rust 1.95 or newer, [Zig 0.16.0](https://ziglang.org/download/), libclang (for bindgen) and [just](https://github.com/casey/just) (optional).

```sh
git clone --recurse-submodules https://github.com/zecod/atrous.git
cd atrous
```

### Windows

Also needed: the Visual Studio 2022 Build Tools (C++ workload) and LLVM (`LIBCLANG_PATH` pointing at the folder with `libclang.dll`, for example `C:\Program Files\LLVM\bin`). Put `zig` on `PATH` or set `ZIG` to `zig.exe`.

```powershell
cargo build --release --locked
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1   # or: just install
```

This installs `%LOCALAPPDATA%\Programs\atrous\atrous.exe`, adds an **Atrous** Start menu shortcut, and adds that folder to your user `PATH` (open a new terminal to use `atrous`). It never touches an installed herdr-app (`%LOCALAPPDATA%\Programs\herdr-app`).

Atrous needs atrous-core: build and install [zecod/atrous-core](https://github.com/zecod/atrous-core), which puts `atrous-core.exe` and `atc.exe` in `%LOCALAPPDATA%\Programs\atrous-core`. Without one, Atrous opens a screen that installs it or lets you pick one.

### macOS

Also needed: the Xcode Command Line Tools.

```sh
cargo build --release --locked
scripts/install-macos          # or: just install
```

This makes `~/Applications/Atrous.app` (bundle id `io.github.zecod.atrous`, the Atrous icon) and links `~/.local/bin/atrous`. Install atrous-core into `~/.local/bin` (`atrous-core` and `atc`). Release builds are signed and packed by `scripts/package`; `scripts/mac-dmg` makes the drag-to-Applications `Atrous.dmg` (needs a Developer ID certificate).

### Linux

```sh
cargo build --release --locked
scripts/install-linux          # or: just install
```

Linux needs a desktop session, a working Vulkan driver and the development packages listed in [CI](.github/workflows/ci.yml).

### Tests

```sh
just test        # bun tests of the shipped mods, then cargo test --locked
```

Never run a bare `atrous` from `target/` on a machine where you also use the app without `ATROUS_HOME` pointing at a scratch home: it opens a second window on your real setup.

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
