# Atrous accounts: starts Claude Code or Codex under the account picked in Settings > Accounts.
#
# programs.json's "run" points Atrous's + menu at claude.ps1 / codex.ps1 beside this file, and Atrous
# starts them as   powershell.exe -NoExit -Command "& '<this folder>\claude.ps1' '--dangerously-skip-permissions'"
# They dot-source this file and call Start-AtrousAccount with their arguments, unchanged.
#
# - state.json (beside this file; written by Settings > Accounts and the usage card) names the
#   active account of each tool. The main account ("default") runs exactly as before: nothing set.
# - Another account: CLAUDE_CONFIG_DIR / CODEX_HOME is set to its folder for this launch only and
#   put back when the program exits, so the shell that stays open (-NoExit) is unchanged. Agents
#   already running keep the account they started with.
# - Before starting, that folder's copies of your main settings are refreshed when a main file is
#   newer than its marker (node profile.mjs sync).
# - While it runs, the terminal carries the label atrous-account=<tool>:<id> (Settings counts the
#   agents running on each account with it).
# ASCII only: Windows PowerShell 5.1 reads files without a BOM in the ANSI code page.

function Update-AtrousAccount([string]$Tool, [string]$Dir, [string]$Here) {
  try {
    $markerPath = Join-Path $Dir '.atrous-account.json'
    $markerTime = (Get-Item -LiteralPath $markerPath).LastWriteTimeUtc
    $marker = Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath | ConvertFrom-Json
    $newer = @($marker.sources) | Where-Object { $_ -and (Test-Path -LiteralPath $_) -and (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $markerTime }
    if ($newer) { & node (Join-Path $Here 'profile.mjs') sync $Tool $Dir *> $null }
  } catch { }
}

function Set-AtrousLabel([string]$Value) {
  $t = $env:ATC_TERMINAL_ID
  if (-not $t -or -not (Get-Command atc -ErrorAction SilentlyContinue)) { return }
  try { & atc label $t "atrous-account=$Value" *> $null } catch { }
}

function Start-AtrousAccount([string]$Tool, $Rest) {
  $var = @{ claude = 'CLAUDE_CONFIG_DIR'; codex = 'CODEX_HOME' }[$Tool]
  $here = $PSScriptRoot
  $acc = $null
  try {
    $state = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $here 'state.json') | ConvertFrom-Json
    $id = $state.active.$Tool
    if ($id -and $id -ne 'default') {
      $acc = @($state.accounts) | Where-Object { $_.tool -eq $Tool -and $_.id -eq $id } | Select-Object -First 1
    }
  } catch { }
  $before = [Environment]::GetEnvironmentVariable($var)
  $label = "${Tool}:default"
  if ($acc) {
    $name = if ($acc.name) { $acc.name } elseif ($acc.email) { $acc.email } else { $acc.id }
    if ($acc.pending) {
      Write-Host "Atrous: account '$name' hasn't finished logging in; starting with your main account." -ForegroundColor Yellow
    } elseif ($acc.dir -and (Test-Path -LiteralPath (Join-Path $acc.dir '.atrous-account.json'))) {
      Update-AtrousAccount $Tool $acc.dir $here
      [Environment]::SetEnvironmentVariable($var, [string]$acc.dir)
      $label = "${Tool}:$($acc.id)"
      Write-Host "Atrous account: $name" -ForegroundColor DarkGray
    } else {
      Write-Host "Atrous: the folder of account '$name' is missing; starting with your main account." -ForegroundColor Yellow
    }
  }
  Set-AtrousLabel $label
  try {
    & $Tool @Rest
  } finally {
    [Environment]::SetEnvironmentVariable($var, $before)
    Set-AtrousLabel ''
  }
}
