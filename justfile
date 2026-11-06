set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

notes-clip scene version="":
    bun scripts/notes-media.ts clip "{{scene}}" "{{version}}"

notes-upload version:
    bun scripts/notes-media.ts upload "{{version}}"

notes-check version:
    bun scripts/notes-media.ts check "{{version}}"

check: test test-core

notices:
    bun scripts/notices.ts

# Before a release: tests, docs, the next version's notes and clips, then what
# changed since the last release, to review by hand.
[unix]
pre-release: test docs-check
    #!/usr/bin/env bash
    set -euo pipefail
    version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
    last=$(git describe --tags --abbrev=0 --match 'v*')
    if grep -q "^## \[$version\]" CHANGELOG.md; then
      bun scripts/notes-media.ts check "$version"
    else
      echo "note: CHANGELOG.md has no [$version] entry yet: write the release notes before tagging."
    fi
    echo; echo "Since $last:"; git log --oneline "$last"..HEAD
    echo
    if git diff --quiet "$last"..HEAD -- src/SKILL.md; then
      echo "review: the agent manual (atrous --skill, src/SKILL.md) is unchanged since $last. Does it still match the changes above?"
    else
      echo "review: the agent manual (atrous --skill) changed since $last. Read it once more."
    fi
    echo "review: the mod guide (defaults/AGENTS.md), README.md and docs/ describe the changes above."

# One build: the app and its core (core/), release builds, with atrous-core,
# atc (and conpty on Windows) put beside target/release/atrous.
[unix]
build:
    bash scripts/build

[windows]
build:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1

# The app alone, debug (what docs and quick checks run).
build-app:
    cargo build --locked

test:
    bun test scripts/files.test.ts scripts/picker.test.ts scripts/palette.test.ts scripts/agents.test.ts scripts/spaces.test.ts scripts/worktree.test.ts scripts/browser.test.ts
    cargo test --locked

# atrous-core's own tests (core/ is its own workspace).
[unix]
test-core:
    cargo test --locked --manifest-path core/Cargo.toml

# Windows' own ConPTY swallows answers to programs: atc's tests need the one it ships.
[windows]
test-core:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File core/scripts/fetch-conpty.ps1 -Dest core/target/debug
    cargo test --locked --manifest-path core/Cargo.toml

docs-generate: build-app
    bun scripts/docs.ts generate

docs-check: build-app
    bun test scripts/docs.test.ts
    bun scripts/docs.ts check

[linux]
install:
    bash scripts/install-linux

[macos]
install:
    bash scripts/install-macos

[windows]
install:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1
