#!/bin/sh
# herdr's + menu starts Claude Code through this on macOS/Linux (programs.json "claude".run).
exec sh "$(dirname -- "$0")/launch.sh" claude "$@"
