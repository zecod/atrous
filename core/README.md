# atrous-core (`atc`)

`atc` runs programs and coding agents in terminals that stay alive after you leave.
Agents can start other agents, send them work, and hear back; you can attach to any terminal and take over.

Core draws nothing. Use it from your shell, an agent, or your own app.
It is the terminal runtime of [Atrous](https://github.com/zecod/atrous).

Atrous core is a modified fork of [herdr-core](https://github.com/herdrdev/herdr-core) by herdrdev, under the Apache License 2.0.
See [NOTICE](NOTICE) for what changed.

## Install

atrous-core ships inside [Atrous](https://github.com/zecod/atrous): this folder is `core/` of the Atrous
repo, built by its one build (`just build`), released in the same download at the same version, and
updated with the app. Install Atrous and you have `atc`: Windows puts `atrous-core.exe` and `atc.exe`
beside `atrous.exe` in `%LOCALAPPDATA%\Programs\atrous`; macOS nests `Atrous Core.app` in
`Atrous.app/Contents/Helpers` and links `~/.local/bin/atc` to it; Linux keeps both beside `atrous`.
Terminals the core starts find `atc` first on their PATH. Such a core refuses `atc update`: update Atrous.

### Standalone (developers only)

The standalone installers, releases and `atc update` below are for developing the core on its own.
People get the core with Atrous.

Linux and macOS:

```sh
curl -fsSL https://github.com/zecod/atrous-core/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
powershell -c "irm https://github.com/zecod/atrous-core/releases/latest/download/install.ps1 | iex"
```

| | Windows | macOS and Linux |
| --- | --- | --- |
| Binaries | `%LOCALAPPDATA%\Programs\atrous-core\atrous-core.exe` and `atc.exe` (same file) | `~/.local/bin/atrous-core` and `atc` (a link to it) |
| macOS bundle | | `~/.local/share/atrous-core/active/Atrous Core.app` |
| PATH | the installer adds the folder for your user | add `~/.local/bin` yourself |

Builds are for Linux and macOS on x86_64 and aarch64, and Windows on x86_64.
Linux builds are static. On Windows, templates and quoted shell commands need `sh` on PATH, such as Git for Windows provides.

Run `atc update` to update. Running terminals keep running.
`atc` never checks for updates on its own and sends no telemetry.
See [security](docs/security.md) for the trust and signing details.

### Beside herdr-core

Atrous core shares nothing with an installed herdr-core: other binaries (`atrous-core`/`atc`, not `herdr-core`/`hc`),
other folders (`atrous-core`), other sockets and pipes, and `ATC_*` variables instead of `HC_*`.
Both can run at once, each with its own terminals.

## Run it and come back

```sh
atc run cargo test                  # stream output and wait for it
atc run --bg --name web bun dev     # start it and return
atc ls                             # see live terminals
atc attach web                     # take over; Ctrl+\ detaches
atc read web --lines 100            # read without attaching
```

Closing your viewer does not end the program.
A waiting run checks in after 180 seconds by default, leaving the program running.
It prints the terminal's address so you can read it or wait again.

For a terminal you want to keep even if its program is lost, use `atc run --keep`.
Recovery starts a fresh shell, never reruns the task.
A normal exit or an explicit kill still ends it.

## Default shell

With no program, `atc run --bg` starts the machine's shell: `$SHELL` (or
`/bin/sh`) on Unix, PowerShell 7 on Windows if available, else Windows PowerShell.
Override it in `~/.config/atrous-core/config.toml` (Windows:
`%APPDATA%\atrous-core\config.toml`, or `$XDG_CONFIG_HOME/atrous-core/config.toml`
when set):

```toml
shell = ["nu"]
# Windows Git Bash (literal strings keep backslashes):
# shell = ['C:\Program Files\Git\bin\bash.exe', '--login', '-i']
```

The list is an executable followed by separate arguments, without extra path
quoting. It must contain a nonempty executable. Changes apply to the next new
shell or `keep` recovery, including recovery after a restart; no restart is
needed. Running terminals, explicit programs, and quoted command lines keep
their behavior. A bad setting reports a config error; a shell that cannot start
reports `spawn_failed`. Recovery stays pending and retries, with errors in
`core.log` (config) or `holder.log` (spawn); it never silently falls back to another shell.

## Agents run agents

Give an agent `atc --skill`. It prints the agent docs in one read, including how to delegate, wait, report back, and clean up.

[Templates](docs/templates.md) give an agent a command and a role.
After saving the reviewer example from that page:

```sh
atc templates
atc run --bg --name review reviewer "Review src/x.rs. Read-only."
atc send review "Focus on the error path."
atc read review --lines 100
```

Agents started inside an atc terminal become its children.
They can report back with `atc send` and wait for their children with `atc wait --children all`.
The parent gets notes when a child needs attention or ends.
Children end with their parent unless started with `--outlive-parent`.

## Every machine

```sh
atc machine add my-ssh-host --name box
atc run --on box --cwd /srv/app cargo test
atc attach box/t3
```

Use the address returned by your run, not the example's `box/t3`.
Programs and files stay on that machine. Your local core brings its terminals into the same list.
[Machines](docs/machines.md) covers SSH, custom connections, remote files, and reconnecting.

## Status comes from the program

An agent can say it is working, done, blocked, or in error through OSC 7501, the Program Status Protocol.
Core stores what it reports. It does not guess from screen text or recognize agent brands.
A program that does not report status has none.

Use `atc get review` for a snapshot or `atc events` to follow changes.

## Build your own client

`atc schema` prints the request/response API as OpenRPC with JSON Schema.
[The API docs](schema/README.md) cover connecting, terminal streams, events, and status.
Use `atc connect` to carry the protocol over stdin and stdout, including through SSH.

## Docs

- [Commands](docs/commands.md): generated from the binary's help.
- [Machines](docs/machines.md): work across machines.
- [Templates](docs/templates.md): reusable agent roles.
- [Security](docs/security.md): access, state, and updates.
- [API](schema/README.md): build a client.

For a quick lookup, run `atc --help` or a command's help, such as `atc run --help`.
For agents, use `atc --skill`.

## Build from source

You need Rust, Zig 0.16 (on PATH, or `ZIG=/path/to/zig`), and optionally [just](https://just.systems/).
CI pins the Rust version in [.github/workflows/ci.yml](.github/workflows/ci.yml).

```sh
git submodule update --init --depth 1
cargo build --release --locked -p atrous-core
just check
```

The build makes one binary, `atrous-core`; `atc` is the same program under its short name (a link the installers add).
`just install` installs this checkout and restarts your core. Running terminals keep running.
`just docs` refreshes the command reference. `just docs-check` checks it and the examples; CI runs the same tests.

### Build and install on a Mac

1. Install the tools: Xcode's command line tools (`xcode-select --install`), Rust from [rustup.rs](https://rustup.rs),
   and Zig **0.16**. Check `zig version`: if Homebrew's `zig` isn't 0.16, download 0.16.0 for your Mac
   from [ziglang.org/download](https://ziglang.org/download/), unpack it, and put its folder on PATH or set `ZIG`
   to its `zig`. `brew install just` is optional.

2. Get the source with its Ghostty submodule:

   ```sh
   git clone --recurse-submodules https://github.com/zecod/atrous-core.git
   cd atrous-core
   ```

   In an existing checkout: `git submodule update --init --depth 1`.

3. Build, bundle and install:

   ```sh
   sh scripts/install-local.sh
   ```

   (`just install` does the same.) It builds the release binary, wraps it in `Atrous Core.app`,
   signs that ad-hoc as `io.github.zecod.atrous.core`, installs the bundle into
   `~/.local/share/atrous-core/active/Atrous Core.app`, links `~/.local/bin/atrous-core` and `~/.local/bin/atc` to it,
   and starts (or restarts) your core. Set `ATC_INSTALL_DIR` to put the links elsewhere.

4. Put `~/.local/bin` on your PATH if it isn't, for example in `~/.zshrc`:

   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   ```

5. Check it:

   ```sh
   atc --version
   atc server status
   atc run --bg --name hello -- echo hi
   atc read hello
   ```

   `atc --version` prints `atc` and the version. macOS may ask once to let **Atrous Core** reach your local
   network or use the microphone: those requests come from programs in your terminals.

To update after pulling new commits, run `sh scripts/install-local.sh` again: running terminals keep running.
herdr-core, if installed, keeps its own `herdr-core`, `hc` and `~/.local/share/herdr-core`: nothing of it is replaced.

### Build and install on Windows

```powershell
git submodule update --init --depth 1
$env:ZIG = "C:\path\to\zig-x86_64-windows-0.16.0\zig.exe"   # if zig 0.16 isn't on PATH
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1
```

(`just install` does the same.) It builds the release binary, fetches Microsoft's ConPTY beside it, and installs
`atrous-core.exe`, `atc.exe` and `conpty\` into `%LOCALAPPDATA%\Programs\atrous-core\`, adding that folder to your
user PATH. An installed core is updated the planned way: running terminals keep running.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor setup and checks.

## License

[Apache-2.0](LICENSE). Atrous core is a modified fork of [herdr-core](https://github.com/herdrdev/herdr-core);
see [NOTICE](NOTICE). `atc --licenses` prints the included third-party licenses.
After a dependency change, regenerate them with `just notices`.
