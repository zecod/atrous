# Installs Atrous on Windows, with its core inside:
#
#   powershell -c "irm https://github.com/zecod/atrous/releases/latest/download/install.ps1 | iex"
#
# Into %LOCALAPPDATA%\Programs\atrous: atrous.exe, atrous-core.exe, atc.exe
# (a hard link to it) and conpty\; that folder goes on your PATH (`atrous`,
# `atc`) and Atrous in the Start menu. Running it again updates both (an
# open Atrous and its core keep running from the old folder; the core
# moves to the new one on Atrous's next start, terminals kept). No admin
# needed. Releases are GitHub releases of zecod/atrous; ATROUS_RELEASES_URL
# points at a test server (<url>/app).

# Its own scope: under `irm | iex` it would otherwise set the caller's variables.
& {
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# throw, not exit: under `irm | iex`, exit would close the person's window.
function Fail($why) { throw "atrous: $why" }

$releases = if ($env:ATROUS_RELEASES_URL) { $env:ATROUS_RELEASES_URL.TrimEnd("/") } else { $null }
$appLatest = if ($releases) { "$releases/app" } else { "https://github.com/zecod/atrous/releases/latest/download" }
$dir = Join-Path $env:LOCALAPPDATA "Programs\atrous"
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne "AMD64") { Fail "no build for $arch Windows yet (x64 only)" }
$target = "windows-x86_64"
# Windows' own tar: Git Bash's, often first on PATH, takes C:\ for a remote host.
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue) -or -not (Test-Path $tar)) {
    Fail "needs curl.exe and tar.exe (Windows 10 1803 or newer)"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "atrous-install-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    curl.exe -fsSL "$appLatest/manifest.json" -o "$tmp\manifest.json"
    if ($LASTEXITCODE) { Fail "no release found at $appLatest (none published yet, or offline)" }
    $m = Get-Content -Raw "$tmp\manifest.json" | ConvertFrom-Json
    $t = $m.targets.$target
    if (-not $t.url -or -not $t.sha256) { Fail "no build for $target yet" }

    $download = $t.url

    Write-Host "Installing Atrous $($m.version) for $target..."
    curl.exe -fsSL $download -o "$tmp\app.tar.gz"
    if ($LASTEXITCODE) { Fail "download failed: $($t.url)" }
    # .NET, not Get-FileHash: that one fails when PowerShell 7 starts 5.1.
    $stream = [IO.File]::OpenRead("$tmp\app.tar.gz")
    try { $got = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) } finally { $stream.Close() }
    if ($got -ne $t.sha256) { Fail "the download is damaged (checksum mismatch); try again" }
    & $tar -xzf "$tmp\app.tar.gz" -C $tmp
    if ($LASTEXITCODE -or -not (Test-Path "$tmp\atrous\atrous.exe") -or -not (Test-Path "$tmp\atrous\atrous-core.exe")) { Fail "the download holds no complete app" }
    # atc.exe: the same file as atrous-core.exe.
    if (-not (Test-Path "$tmp\atrous\atc.exe")) {
        try { New-Item -ItemType HardLink -Path "$tmp\atrous\atc.exe" -Target "$tmp\atrous\atrous-core.exe" | Out-Null }
        catch { Copy-Item "$tmp\atrous\atrous-core.exe" "$tmp\atrous\atc.exe" }
    }

    # A running app's folder can be renamed, not deleted. A previous one
    # goes now unless something still runs from it (a core starts its
    # terminals with the conpty\ beside it): then it moves aside whole.
    New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
    function Remove-Previous($old) {
        if (-not (Test-Path $old)) { return }
        $busy = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$old\", [StringComparison]::OrdinalIgnoreCase) }
        if ($busy) { Rename-Item $old "$(Split-Path $old -Leaf)-$([guid]::NewGuid().ToString('N').Substring(0, 8))" }
        else { Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }
    }
    Remove-Previous "$dir.old"
    if (Test-Path $dir) { Rename-Item $dir "$dir.old" }
    Move-Item "$tmp\atrous" $dir
    Remove-Previous "$dir.old"

    $exe = Join-Path $dir "atrous.exe"
    $menu = Join-Path ([Environment]::GetFolderPath("Programs")) "Atrous.lnk"
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)
    $link.TargetPath = $exe
    $link.WorkingDirectory = $env:USERPROFILE
    $link.Description = "Terminals and coding agents that keep running"
    $link.Save()

    # The raw user PATH, so %VARIABLES% in it stay unexpanded and keep their type.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $listed = $raw -split ";" | Where-Object { $_.Trim().TrimEnd("\") -ieq $dir.TrimEnd("\") }
    if (-not $listed) {
        $kind = if ($key.GetValueNames() -contains "Path") { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue("Path", $(if ($raw) { "$($raw.TrimEnd(';'));$dir" } else { $dir }), $kind)
        # Setting any user variable tells running programs the environment changed.
        [Environment]::SetEnvironmentVariable("ATROUS_INSTALLING", "1", "User")
        [Environment]::SetEnvironmentVariable("ATROUS_INSTALLING", $null, "User")
    }
    $key.Close()
    if (($env:Path -split ";") -notcontains $dir) { $env:Path += ";$dir" }

    Write-Host "Atrous is installed. Open it from the Start menu, or run: atrous"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
}
