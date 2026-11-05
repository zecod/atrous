#!/bin/sh
# DEVELOPERS ONLY: Atrous builds and installs its core itself (just build,
# just install at the repo root). This installs core/ alone, for working on it.
# Builds a release binary into ~/.local/bin (replacing any older one), then
# restarts the core the planned way so running terminals pick up the new build.
set -eu
cd "$(dirname "$0")/.."
nice -n 10 cargo build --release
bin="${ATC_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$bin"
if [ "$(uname -s)" = Darwin ]; then
  app="target/release/Atrous Core.app"
  rm -rf "$app"
  sh scripts/mac-bundle target/release/atrous-core "$app"
  bash scripts/mac-sign "$app"
  "$app/Contents/MacOS/atrous-core" --atc-install-bundle "$app/Contents/MacOS/atrous-core" "$bin/atrous-core"
else
  install -m 755 target/release/atrous-core "$bin/atrous-core.new"
  mv -f "$bin/atrous-core.new" "$bin/atrous-core"
fi
[ -e "$bin/atc" ] || [ -L "$bin/atc" ] || ln -s atrous-core "$bin/atc"
"$bin/atrous-core" server restart
