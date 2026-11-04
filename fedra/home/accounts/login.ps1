# herdr accounts: the terminal behind Settings > Accounts' login dialog.
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File login.ps1 <claude|codex> <account folder> [name]
# Runs `claude auth login` (CLAUDE_CONFIG_DIR = the folder) or `codex login` (CODEX_HOME = the
# folder), so the login is saved in that account's folder only. Logged in: says so and ends after
# two seconds (the dialog closes with it). Not logged in (cancelled in the browser, an error): says
# so and waits for Enter. Settings watches this terminal: a new account whose login didn't finish is
# removed again. ASCII only (Windows PowerShell 5.1 reads files without a BOM as ANSI).
param([string]$Tool, [string]$Dir, [string]$Name)

$label = if ($Tool -eq 'codex') { 'Codex' } else { 'Claude Code' }
if (-not $Dir -or -not (Test-Path -LiteralPath (Join-Path $Dir '.herdr-account.json'))) {
  Write-Host "This account's folder is missing." -ForegroundColor Red
  Read-Host 'Press Enter to close' | Out-Null
  exit 1
}
$what = if ($Name) { "$label ($Name)" } else { $label }
try { $Host.UI.RawUI.WindowTitle = "Log in to $what" } catch { }

Write-Host ''
Write-Host "  Log in to $what" -ForegroundColor Cyan
Write-Host '  Your browser opens next. If it is signed in to your main account, switch account'
Write-Host '  there first (or open the link in a private window), then approve.'
Write-Host ''

if ($Tool -eq 'codex') {
  $env:CODEX_HOME = $Dir
  & codex login
  & codex login status *> $null
} else {
  $env:CLAUDE_CONFIG_DIR = $Dir
  & claude auth login
  & claude auth status --json *> $null
}
$ok = ($LASTEXITCODE -eq 0)

Write-Host ''
if ($ok) {
  Write-Host '  Logged in. This window closes in a moment.' -ForegroundColor Green
  Start-Sleep -Seconds 2
  exit 0
}
Write-Host '  Not logged in. Close this window; the new account is not kept.' -ForegroundColor Yellow
Read-Host '  Press Enter to close' | Out-Null
exit 1
