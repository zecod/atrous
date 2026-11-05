# One build for Atrous and its core, from PowerShell (scripts/build is the
# same for bash):
#
#   scripts\build.ps1               release builds (what installs ship)
#   scripts\build.ps1 -DebugBuild   debug builds
#
# Builds the app (this workspace) and atrous-core (core\, its own workspace
# with its own Cargo.lock), then puts the core beside the app in
# target\<profile>: atrous-core.exe, atc.exe (a hard link to it) and
# conpty\, so target\release\atrous.exe runs with its own core like an
# install. A core still running from there is renamed aside, not replaced.
param([switch]$DebugBuild)
$ErrorActionPreference = "Stop"

function Invoke-Checked {
    & $args[0] @($args | Select-Object -Skip 1)
    if ($LASTEXITCODE) { throw "$($args -join ' ') failed (exit $LASTEXITCODE)" }
}

# .NET, not Get-FileHash: that one fails when PowerShell 7 starts 5.1.
function Get-Sha256($Path) {
    $stream = [IO.File]::OpenRead($Path)
    try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) } finally { $stream.Close() }
}

# Moves a file aside when it can't go (Windows won't delete a running program).
function Remove-OrMoveAside($Path) {
    try { Remove-Item -LiteralPath $Path -Force }
    catch { Rename-Item -LiteralPath $Path -NewName "$(Split-Path $Path -Leaf).old-$PID-$([guid]::NewGuid().ToString('N').Substring(0, 6))" }
}

# The core beside the app (what scripts/stage-core does in bash):
# atrous-core.exe, atc.exe (the same file, a hard link) and conpty\.
function Add-AtrousCore($AppDir, $CoreDir, $Root) {
    $core = Join-Path $CoreDir "atrous-core.exe"
    if (-not (Test-Path -LiteralPath $core)) { throw "no $core (build core\ first)" }
    Get-ChildItem -LiteralPath $AppDir -Filter "*.exe.old-*" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    $staged = Join-Path $AppDir "atrous-core.exe"
    $want = Get-Sha256 $core
    if ((Test-Path -LiteralPath $staged) -and (Get-Sha256 $staged) -ne $want) { Remove-OrMoveAside $staged }
    if (-not (Test-Path -LiteralPath $staged)) { Copy-Item -LiteralPath $core -Destination $staged }
    $atc = Join-Path $AppDir "atc.exe"
    if ((Test-Path -LiteralPath $atc) -and (Get-Sha256 $atc) -ne $want) { Remove-OrMoveAside $atc }
    if (-not (Test-Path -LiteralPath $atc)) {
        try { New-Item -ItemType HardLink -Path $atc -Target $staged | Out-Null }
        catch { Copy-Item -LiteralPath $staged -Destination $atc }
    }
    if (-not (Test-Path (Join-Path $AppDir "conpty\conpty.dll")) -or -not (Test-Path (Join-Path $AppDir "conpty\x64\OpenConsole.exe"))) {
        & (Join-Path $Root "core\scripts\fetch-conpty.ps1") -Dest $AppDir
    }
}

# Dot-sourcing exposes the functions (install-windows.ps1 uses them).
if ($MyInvocation.InvocationName -eq '.') { return }

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    foreach ($sub in "vendor/ghostty", "core/vendor/ghostty") {
        if (-not (Test-Path "$sub/build.zig")) { Invoke-Checked git submodule update --init --depth 1 $sub }
    }
    $kind = if ($DebugBuild) { "debug" } else { "release" }
    $flags = @()
    if (-not $DebugBuild) { $flags = @("--release") }
    Invoke-Checked cargo build @flags --locked
    Invoke-Checked cargo build @flags --locked --manifest-path core/Cargo.toml
    Add-AtrousCore (Join-Path $root "target\$kind") (Join-Path $root "core\target\$kind") $root
    Write-Host "build: target\$kind holds atrous.exe, atrous-core.exe, atc.exe and conpty\"
} finally {
    Pop-Location
}
