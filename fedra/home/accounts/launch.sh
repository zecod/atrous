#!/bin/sh
# Atrous accounts (macOS / Linux): starts Claude Code or Codex under the account picked in
# Settings > Accounts. The PowerShell twin is launch.ps1; both read state.json beside them.
#
#   launch.sh <claude|codex> [arguments for the tool...]
#
# - The main account ("default") runs exactly as before: nothing set.
# - Another account: CLAUDE_CONFIG_DIR / CODEX_HOME points at its folder for this launch only.
#   Its copies of your main settings are refreshed first (node profile.mjs sync).
# - While it runs, the terminal carries the label atrous-account=<tool>:<id>.

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tool=$1
shift
case "$tool" in
  claude) var=CLAUDE_CONFIG_DIR ;;
  codex) var=CODEX_HOME ;;
  *) echo "Atrous: unknown tool '$tool'" >&2; exit 2 ;;
esac

label() {
  [ -n "$ATC_TERMINAL_ID" ] && command -v atc >/dev/null 2>&1 && atc label "$ATC_TERMINAL_ID" "atrous-account=$1" >/dev/null 2>&1
  return 0
}

# The active account for this tool, as: dir<TAB>name<TAB>id<TAB>pending (nothing for the main one).
pick=""
if [ -f "$here/state.json" ] && command -v node >/dev/null 2>&1; then
  pick=$(node -e '
    const fs = require("fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const id = s.active && s.active[process.argv[2]];
      if (!id || id === "default") process.exit(0);
      const a = (s.accounts || []).find((x) => x.tool === process.argv[2] && x.id === id);
      if (a) process.stdout.write([a.dir || "", a.name || a.email || a.id, a.id, a.pending ? "1" : ""].join("\t"));
    } catch {}
  ' "$here/state.json" "$tool" 2>/dev/null)
fi

tag="$tool:default"
if [ -n "$pick" ]; then
  dir=$(printf '%s' "$pick" | cut -f1)
  name=$(printf '%s' "$pick" | cut -f2)
  id=$(printf '%s' "$pick" | cut -f3)
  pending=$(printf '%s' "$pick" | cut -f4)
  if [ -n "$pending" ]; then
    printf "Atrous: account '%s' hasn't finished logging in; starting with your main account.\n" "$name" >&2
  elif [ -n "$dir" ] && [ -f "$dir/.atrous-account.json" ]; then
    node "$here/profile.mjs" sync "$tool" "$dir" >/dev/null 2>&1
    export "$var=$dir"
    tag="$tool:$id"
    printf "Atrous account: %s\n" "$name"
  else
    printf "Atrous: the folder of account '%s' is missing; starting with your main account.\n" "$name" >&2
  fi
fi

label "$tag"
"$tool" "$@"
code=$?
label ""
exit $code
