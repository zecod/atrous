# Atrous accounts: the sign-in behind Settings > Accounts (Windows; the macOS / Linux twin is login.sh).
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File login.ps1 <claude|codex> <account folder>
# Started in a background atrous-core terminal named login-<tool>-<id> by the sign-in dialog
# (mods/accounts), which reads this terminal (`atc read`: the sign-in link, Claude Code's code prompt)
# and its exit code (`atc get`), and types a pasted code into it (`atc send`). Nobody needs to look at
# this terminal; it ends by itself:
# - runs `claude auth login` (CLAUDE_CONFIG_DIR = the folder) or `codex login` (CODEX_HOME = the
#   folder), so the login lands in that account's folder only;
# - then exits 0 when the account is logged in, else 1, after a last line "atrous-login: ok|failed".
# It never waits for a key: closing the dialog doesn't end the sign-in; only Cancel does (it kills
# this terminal). Only one `codex login` can run at a time (a second one cancels the first: they share
# localhost:1455), so the dialog refuses to start a second sign-in of the same tool.
# ASCII only (Windows PowerShell 5.1 reads files without a BOM as ANSI).
param([string]$Tool, [string]$Dir)

if (-not $Dir -or -not (Test-Path -LiteralPath (Join-Path $Dir '.atrous-account.json'))) {
  Write-Host "atrous-login: failed (the account's folder is missing)"
  exit 1
}

if ($Tool -eq 'codex') {
  $env:CODEX_HOME = $Dir
  & codex login
  & codex login status *> $null
} else {
  $env:CLAUDE_CONFIG_DIR = $Dir
  & claude auth login
  & claude auth status --json *> $null
}
if ($LASTEXITCODE -eq 0) {
  Write-Host 'atrous-login: ok'
  exit 0
}
Write-Host 'atrous-login: failed'
exit 1
