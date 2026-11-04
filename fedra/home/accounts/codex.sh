#!/bin/sh
# herdr's + menu starts Codex through this on macOS/Linux (programs.json "codex".run).
exec sh "$(dirname -- "$0")/launch.sh" codex "$@"
