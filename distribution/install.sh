#!/bin/sh
# Installs the Atrous app, and atrous-core if there's none yet:
#
#   curl -fsSL https://github.com/zecod/atrous/releases/latest/download/install.sh | sh
#
# Linux: the app into ~/.local/share/atrous, `atrous` in ~/.local/bin,
# a launcher entry and icon. macOS: Atrous.app into ~/Applications, keeping
# its release signature intact (ad hoc for unsigned/dev builds). The core, with its
# own installer, into ~/.local/bin/atrous-core (and `atc`) only if none is
# there yet; the app
# keeps it current after that. Running it again updates the app.
set -eu

# GitHub releases of zecod/atrous and zecod/atrous-core; ATROUS_RELEASES_URL
# points at a test server laid out as <url>/app, <url>/core.
releases=${ATROUS_RELEASES_URL:-}
if [ -n "$releases" ]; then
  app_latest="$releases/app" core_latest="$releases/core"
else
  app_latest=https://github.com/zecod/atrous/releases/latest/download
  core_latest=https://github.com/zecod/atrous-core/releases/latest/download
fi
bin="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }
fail() { say "atrous: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1"; }
need curl
need tar

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  MINGW* | MSYS* | CYGWIN*) fail "this installer is for Linux and macOS; on Windows, run this in PowerShell: irm $app_latest/install.ps1 | iex" ;;
  *) fail "no build for $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
if [ "$os" = macos ] && [ "$arch" = x86_64 ]; then
  # Rosetta reports x86_64 even on Apple Silicon.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] ||
     [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=aarch64
  else
    fail "Intel Macs aren't supported; build from source: https://github.com/zecod/atrous#build-from-source"
  fi
fi
target="$os-$arch"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$app_latest/latest.json" -o "$tmp/latest.json" || fail "no release found at $app_latest (none published yet, or offline)"
# Read without jq: the manifest is flat enough for sed once spaces are gone.
entry=$(tr -d '\n ' < "$tmp/latest.json" | sed -n "s/.*\"$target\":{\([^}]*\)}.*/\1/p")
url=$(printf '%s' "$entry" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
want=$(printf '%s' "$entry" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')
version=$(tr -d '\n ' < "$tmp/latest.json" | sed -n 's/^{"version":"\([^"]*\)".*/\1/p')
[ -n "$url" ] && [ -n "$want" ] || fail "no build for $target yet"

download=$url

say "Installing Atrous ${version:-} for $target..."
curl -fsSL "$download" -o "$tmp/app.tar.gz" || fail "download failed"
[ "$(sha256 "$tmp/app.tar.gz")" = "$want" ] || fail "download is damaged (checksum mismatch); try again"
tar -xzf "$tmp/app.tar.gz" -C "$tmp"
mkdir -p "$bin"

if [ "$os" = linux ]; then
  data=${XDG_DATA_HOME:-$HOME/.local/share}
  home="$data/atrous"
  mkdir -p "$data"
  rm -rf "$home.new"
  mv "$tmp/atrous" "$home.new"
  rm -rf "$home"
  mv "$home.new" "$home"
  ln -sfn "$home/atrous" "$bin/atrous"
  mkdir -p "$data/applications" "$data/icons/hicolor/scalable/apps"
  cp "$home/atrous.svg" "$data/icons/hicolor/scalable/apps/atrous.svg"
  cat > "$data/applications/atrous.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Atrous
Comment=Terminals and coding agents that keep running
Exec=$bin/atrous
Icon=atrous
Terminal=false
Categories=Development;
StartupWMClass=atrous
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data/applications" 2>/dev/null || true
  [ -f "$data/icons/hicolor/icon-theme.cache" ] && gtk-update-icon-cache -f -t "$data/icons/hicolor" >/dev/null 2>&1 || true
else
  apps="$HOME/Applications"
  app="$apps/Atrous.app"
  mkdir -p "$apps"
  # Prepared in the temp folder, so Spotlight never indexes a half-made
  # bundle under a temporary name in Applications.
  # Never change a certificate-signed bundle: macOS permissions follow its
  # signing identity. Only unsigned/ad-hoc development builds need this PATH.
  signed=false
  if signature=$(/usr/bin/codesign -dvv "$tmp/Atrous.app" 2>&1); then
    if printf '%s\n' "$signature" | grep -q '^Authority=Developer ID Application:'; then
      signed=true
    elif ! printf '%s\n' "$signature" | grep -qx 'Signature=adhoc'; then
      fail "cannot determine app signature: $signature"
    fi
  elif ! printf '%s\n' "$signature" | grep -q ': code object is not signed at all$'; then
    fail "cannot determine app signature: $signature"
  fi
  if [ "$signed" = true ]; then
    /usr/bin/codesign --verify --deep --strict "$tmp/Atrous.app" || fail "invalid app signature"
  else
    /usr/libexec/PlistBuddy -c "Add :LSEnvironment:PATH string $bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$tmp/Atrous.app/Contents/Info.plist"
    /usr/bin/codesign --force --sign - "$tmp/Atrous.app" >/dev/null 2>&1
  fi
  rm -rf "$app"
  mv "$tmp/Atrous.app" "$app"
  ln -sfn "$app/Contents/MacOS/Atrous" "$bin/atrous"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" 2>/dev/null || true
fi

# The core: installed only if there's none yet. One that's already there
# (yours, or from a package manager) is left alone; the app updates it.
if [ ! -e "$bin/atrous-core" ] && ! command -v atrous-core >/dev/null 2>&1; then
  curl -fsSL "$core_latest/install.sh" | ATC_INSTALL_DIR="$bin" ATROUS_RELEASES_URL="$releases" sh || say "atrous-core didn't install; Atrous will offer it when it opens."
fi

say "Atrous is installed. Open it from your apps, or run: atrous"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) say "Add $bin to your PATH to use atrous and atc from a terminal." ;;
esac
