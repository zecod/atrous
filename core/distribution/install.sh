#!/bin/sh
# DEVELOPERS ONLY: atrous-core ships inside Atrous (core/ of zecod/atrous)
# and installs and updates with it. This standalone installer is for working
# on the core alone.
#
# Installs atrous-core (atc), or updates it:
#
#   curl -fsSL https://github.com/zecod/atrous-core/releases/latest/download/install.sh | sh
#
# Into ~/.local/bin/atrous-core, with `atc` beside it only if no `atc` exists
# (another program may own that name). An atc that is already there is swapped
# the planned way (atc update --from): running terminals keep running. One
# from a package manager is left to it. ATC_VERSION=0.2.0 picks a version;
# ATC_RELEASES_URL points at other releases (tests, mirrors): it holds
# latest/download/manifest.json and download/v<version>/manifest.json, as
# GitHub releases do.
set -eu

releases=${ATC_RELEASES_URL:-https://github.com/zecod/atrous-core/releases}
bin=${ATC_INSTALL_DIR:-$HOME/.local/bin}

say() { printf '%s\n' "$*"; }
fail() { say "atc: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1"; }
need curl
need tar

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "atc runs on Linux and macOS for now" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
target="$os-$arch"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

manifest="$releases/latest/download/manifest.json"
[ -n "${ATC_VERSION:-}" ] && manifest="$releases/download/v$ATC_VERSION/manifest.json"
curl -fsSL "$manifest" -o "$tmp/manifest.json" || fail "cannot reach $manifest (no release published there yet?)"
# Read without jq: the manifest is flat enough for sed once spaces are gone.
flat=$(tr -d '\n ' < "$tmp/manifest.json")
entry=$(printf '%s' "$flat" | sed -n "s/.*\"$target\":{\([^}]*\)}.*/\1/p")
url=$(printf '%s' "$entry" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
want=$(printf '%s' "$entry" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')
version=$(printf '%s' "$flat" | sed -n 's/^{"version":"\([^"]*\)".*/\1/p')
[ -n "$url" ] && [ -n "$want" ] || fail "no build for $target in $manifest"

curl -fsSL "$url" -o "$tmp/atc.tar.gz" || fail "download failed: $url"
[ "$(sha256 "$tmp/atc.tar.gz")" = "$want" ] || fail "the download is damaged (checksum mismatch); try again"
tar -xzf "$tmp/atc.tar.gz" -C "$tmp"
"$tmp/atrous-core" --version >/dev/null 2>&1 || fail "the downloaded atc does not run on this machine"
# App completion must converge even before the first bundled release exists.
if [ "${ATC_BUNDLE_ONLY:-0}" = 1 ] && [ ! -x "$tmp/Atrous Core.app/Contents/MacOS/atrous-core" ]; then
  exit 0
fi
mkdir -p "$bin"

bundle=0
if [ "$os" = macos ] && [ "$(id -u)" != 0 ]; then
  case "$bin" in "$HOME"/*) bundle=1 ;; esac
fi
if [ "$bundle" = 1 ] && [ -x "$tmp/Atrous Core.app/Contents/MacOS/atrous-core" ]; then
  action=installed
  [ ! -x "$bin/atrous-core" ] || action=updated
  bundled="$tmp/Atrous Core.app/Contents/MacOS/atrous-core"
  if [ "$action" = updated ]; then
    installed=$("$bin/atrous-core" --version)
    candidate=$("$bundled" --version)
    awk -v old="$installed" -v new="$candidate" 'BEGIN {
      sub(/^atc /, "", old); sub(/^atc /, "", new)
      split(old, a, /[.-]/); split(new, b, /[.-]/)
      for (i=1; i<=3; i++) { if (a[i]+0 > b[i]+0) exit 1; if (a[i]+0 < b[i]+0) exit 0 }
    }' || fail "$candidate is older than $installed; use atc update --from with --force to downgrade"
  fi
  # Atrous releases are ad-hoc signed (no Developer ID team yet): the
  # identifier is what can be checked.
  case "$releases" in
    https://github.com/zecod/atrous-core/releases | https://github.com/zecod/atrous-core/releases/)
      /usr/bin/codesign --verify --strict -R '=identifier "io.github.zecod.atrous.core"' "$tmp/Atrous Core.app" || fail "not a signed Atrous Core release" ;;
  esac
  "$bundled" --atc-install-bundle "$bundled" "$bin/atrous-core" || fail "installing Atrous Core.app failed"
  # A fresh install must not start a core (especially not a system/root core).
  if [ "$action" = updated ]; then
    "$bin/atrous-core" server restart >/dev/null || fail "restarting the core failed"
  fi
  say "atc $version $action as Atrous Core.app. Recreate pre-update terminals if macOS privacy access is broken; running terminals were kept."
elif [ -x "$bin/atrous-core" ]; then
  # Swapped the planned way, so its terminals keep running.
  "$bin/atrous-core" update --from "$tmp/atrous-core" >/dev/null || fail "updating $bin/atrous-core failed (see above)"
  say "atc updated to $version."
else
  cp "$tmp/atrous-core" "$bin/atrous-core.new"
  chmod 755 "$bin/atrous-core.new"
  mv -f "$bin/atrous-core.new" "$bin/atrous-core"
  say "atc $version installed into $bin/atrous-core."
fi
if ! command -v atc >/dev/null 2>&1 && [ ! -e "$bin/atc" ]; then
  ln -s atrous-core "$bin/atc"
fi

case ":$PATH:" in
  *":$bin:"*) ;;
  *) say "Add $bin to your PATH to use atc." ;;
esac
say "Agents: atc --skill. People: atc --help."
