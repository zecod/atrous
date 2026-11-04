#!/bin/sh
# herdr accounts (macOS / Linux): the terminal behind Settings > Accounts' login dialog.
#   sh login.sh <claude|codex> <account folder> [name]
# Runs `claude auth login` (CLAUDE_CONFIG_DIR = the folder) or `codex login` (CODEX_HOME = the
# folder), so the login is saved for that account only. Logged in: says so and ends after two
# seconds (the dialog closes with it). Not logged in: says so and waits for Enter. Settings
# watches this terminal: a new account whose login didn't finish is removed again.
# The PowerShell twin is login.ps1.

tool=$1
dir=$2
name=$3
if [ "$tool" = codex ]; then what="Codex"; else what="Claude Code"; fi
[ -n "$name" ] && what="$what ($name)"

if [ -z "$dir" ] || [ ! -f "$dir/.herdr-account.json" ]; then
  echo "This account's folder is missing."
  printf 'Press Enter to close'; read -r _
  exit 1
fi

printf '\033]0;Log in to %s\007' "$what"
echo ""
printf '  \033[36mLog in to %s\033[0m\n' "$what"
echo "  Your browser opens next. If it is signed in to your main account, switch account"
echo "  there first (or open the link in a private window), then approve."
echo ""

if [ "$tool" = codex ]; then
  CODEX_HOME=$dir codex login
  CODEX_HOME=$dir codex login status >/dev/null 2>&1
else
  CLAUDE_CONFIG_DIR=$dir claude auth login
  CLAUDE_CONFIG_DIR=$dir claude auth status --json >/dev/null 2>&1
fi
ok=$?

echo ""
if [ $ok -eq 0 ]; then
  printf '  \033[32mLogged in. This window closes in a moment.\033[0m\n'
  sleep 2
  exit 0
fi
printf '  \033[33mNot logged in. Close this window; the new account is not kept.\033[0m\n'
printf '  Press Enter to close'; read -r _
exit 1
