# atrous-core

If AGENTS.local.md exists, read it too: the maintainer's local rules.

`atrous-core` (alias `atc`) is a terminal runtime for coding agents: it runs
programs in terminals, keeps them alive, relays raw bytes to any viewer,
reads status from OSC 7501, and lets agents start, talk to, read, wait on and
get notified by other agents. It draws nothing.

Read the code. This file only holds what reading won't tell you: the rules,
the traps, and the handful of decisions that look arbitrary until you know
why.

It is the core of Atrous ([zecod/atrous](https://github.com/zecod/atrous)), a
rebranded fork of herdr-core ([herdrdev/herdr-core](https://github.com/herdrdev/herdr-core),
Apache-2.0; see NOTICE). zecod maintains the fork. The code is authoritative;
ask the maintainer about conflicting requirements. Keep the fork's names
(`atrous-core`, `atc`, `ATC_*`, `atrous-core` folders and pipes): Atrous runs
beside an installed herdr-core and must never share its binaries, state,
sockets or variables.

`atc --skill` prints the manual in `crates/atrous-core/src/SKILL.md`. The
installable skill is the short stub in `skills/atrous-core/SKILL.md`: it says
when to use atc and points to `atc --skill`, so it rarely changes.
Keep the manual current when changing agent-facing behavior.

## The rule

Core is a runtime, not a multiplexer. If a feature only makes sense with a
layout or a workspace to return to, it does not belong here.

## Rules that aren't in the code

- libghostty-vt comes from fresh upstream Ghostty master (the
  `vendor/ghostty` submodule), not a vendored copy.
- Status comes only from OSC 7501. No screen detection, no agent registry,
  no vendor-specific logic. This is the one most likely to be helpfully
  added; don't.
- Every action reports what was observed, never what was assumed.
- One API; the CLI is one call per command. The schema is generated from one
  method table, so params and results in `api/types.rs` are also CLI args and
  the published schema. Change them and regenerate:
  `ATC_UPDATE_SCHEMA=1 cargo test -p atrous-core --test m0`.
- Lean, KISS, always. Fewer lines, fewer files, fewer dependencies. No
  abstraction before a second real caller, no config for things nobody asked
  to configure.
- Deciding code stays separate from IO, so it tests without processes.
- Gate per OS only where the OS really behaves differently, and keep it in
  `platform/` (`unix.rs`, `windows.rs`) behind one interface: shared code
  calls `platform::…` and has no `#[cfg]` of its own. A platform quirk gets
  a test on its platform, and other platforms keep their behavior.
- TDD. A test first for every required documented behavior. One good test per
  behavior, not five checking the same thing. A few end-to-end tests with real
  PTYs beat many mocks. The suite runs in seconds; keep it that way.
- Do not change documented behavior silently. Behavior changes need maintainer
  agreement.
- Aim for source files under ~32 KB, hard cap 48 KB because read tools stop
  near 50. Split along a real seam when you next touch one that's over.

## Traps

- Tests and smokes run in isolated sessions (`ATC_SESSION`) with scratch XDG
  paths under `/var/tmp`. Never touch the machine's real core, Atrous, an
  installed herdr-core, or their running agents. Clean up scratch data.
- `just install` replaces the installed binary and restarts core. Running
  terminals are kept.
- Real-agent smokes (Claude Code with haiku, Pi with a cheap model) cost
  money. Ask before running them.
- A dependency change (crates or Ghostty) needs `just notices`; a test fails
  if a crate is missing from the notices.
- `rustfmt.toml` width 120 is the format and CI checks it: `just fmt`.
  `just lint` is fmt, clippy, and clippy for Windows from Linux. `just check`
  is lint plus the whole suite. Run it before proposing a commit.

## Contributing

Work on a branch and open a pull request to `main`. CI must pass and the
maintainer approves. Commit messages: lowercase conventional commits. Only the
maintainer releases (a `v*` tag publishes a GitHub release).
CHANGELOG.md: every release gets a `## [x.y.z] - YYYY-MM-DD` section
(`### New` / `### Fixed`), written at release time from the commits since the
last tag; `just release-prepare` refuses without it. One line per change, in
user words (what a person notices, not code), with the issue or PR number and
`thanks @name` for contributors. Leave out internal changes and fixes for bugs
that never shipped.
