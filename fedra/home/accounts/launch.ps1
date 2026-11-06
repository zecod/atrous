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
#   already running keep their account until a confirmed quota stop, when the Node launcher
#   can resume the exact conversation if automatic account switching and resume are enabled.
# - Before starting, that folder's copies of your main settings are refreshed when a main file is
#   newer than its marker (node profile.mjs sync).
# - While it runs, the terminal carries the label atrous-account=<tool>:<id> (Settings counts the
#   agents running on each account with it).
# ASCII only: Windows PowerShell 5.1 reads files without a BOM in the ANSI code page.

function Update-AtrousAccount([string]$Tool, [string]$Dir, [string]$Here) {
  try {
    $markerPath = Join-Path $Dir '.atrous-account.json'
    $markerTime = (Get-Item -LiteralPath $markerPath -ErrorAction Stop).LastWriteTimeUtc
    $marker = Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $newer = @($marker.sources) | Where-Object { $_ -and (Test-Path -LiteralPath $_) -and (Get-Item -LiteralPath $_ -ErrorAction Stop).LastWriteTimeUtc -gt $markerTime }
    if ($newer) { & node (Join-Path $Here 'profile.mjs') sync $Tool $Dir *> $null }
  } catch { }
}

function Set-AtrousLabel([string]$Value) {
  $t = $env:ATC_TERMINAL_ID
  if (-not $t -or -not (Get-Command atc -ErrorAction SilentlyContinue)) { return }
  try { & atc label $t "atrous-account=$Value" *> $null } catch { }
}

function Start-AtrousAccount([string]$Tool, $Rest) {
  # The Node supervisor preserves native terminal stdio and resumes this CLI only after a
  # confirmed quota stop. Old/custom shell functions keep the original launcher below.
  $program = Get-Command $Tool -ErrorAction SilentlyContinue
  $native = $program.Source -match '\.(exe|ps1)$'
  if ($program.Source -match '\.cmd$') {
    # Only known npm shims have an executable argv entry point. Custom cmd/bat launchers
    # retain PowerShell's existing invocation instead of passing their arguments to cmd /c.
    $entry = if ($Tool -eq 'codex') { 'node_modules/@openai/codex/bin/codex.js' } else { 'node_modules/@anthropic-ai/claude-code/bin/claude.exe' }
    $native = Test-Path -LiteralPath (Join-Path (Split-Path $program.Source) $entry)
  }
  if ($native -and (Get-Command node -ErrorAction SilentlyContinue) -and $program.Source -and (Test-Path -LiteralPath $program.Source)) {
    & node (Join-Path $PSScriptRoot 'launch.mjs') $Tool --command $program.Source -- @Rest
    return
  }
  $var = @{ claude = 'CLAUDE_CONFIG_DIR'; codex = 'CODEX_HOME' }[$Tool]
  $here = $PSScriptRoot
  $acc = $null
  # No state.json yet (nobody opened Settings > Accounts) or an unreadable one: the main account,
  # silently. (-ErrorAction Stop: a missing file is otherwise a non-terminating error that prints
  # in red at the top of the agent's terminal, try/catch or not.)
  $statePath = Join-Path $here 'state.json'
  if (Test-Path -LiteralPath $statePath) {
    try {
      $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $id = $state.active.$Tool
      if ($id -and $id -ne 'default') {
        $acc = @($state.accounts) | Where-Object { $_.tool -eq $Tool -and $_.id -eq $id } | Select-Object -First 1
      }
    } catch { }
  }
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
