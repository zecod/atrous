#!/bin/sh
# herdr accounts (macOS / Linux): the sign-in behind Settings > Accounts. The PowerShell twin is
# login.ps1; see it for how the sign-in dialog drives this terminal.
#   sh login.sh <claude|codex> <account folder>
# Runs `claude auth login` (CLAUDE_CONFIG_DIR = the folder) or `codex login` (CODEX_HOME = the
# folder), then exits 0 when the account is logged in, else 1, after a last line
# "herdr-login: ok|failed". Never waits for a key.

tool=$1
dir=$2

if [ -z "$dir" ] || [ ! -f "$dir/.herdr-account.json" ]; then
  echo "herdr-login: failed (the account's folder is missing)"
  exit 1
fi

if [ "$tool" = codex ]; then
  CODEX_HOME=$dir codex login
  CODEX_HOME=$dir codex login status >/dev/null 2>&1
else
  CLAUDE_CONFIG_DIR=$dir claude auth login
  CLAUDE_CONFIG_DIR=$dir claude auth status --json >/dev/null 2>&1
fi
if [ $? -eq 0 ]; then
  echo "herdr-login: ok"
  exit 0
fi
echo "herdr-login: failed"
exit 1
