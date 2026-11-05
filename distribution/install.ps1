# Installs the Atrous app on Windows, and atrous-core if there's none yet:
#
#   powershell -c "irm https://github.com/zecod/atrous/releases/latest/download/install.ps1 | iex"
#
# The app into %LOCALAPPDATA%\Programs\atrous (added to your PATH for
# `atrous`), Atrous in the Start menu. The core, with its own installer,
# only if none is there yet; the app keeps it current after that. Running it
# again updates the app (an open one keeps running until it quits). No admin
# needed. Releases are GitHub releases of zecod/atrous and zecod/atrous-core;
# ATROUS_RELEASES_URL points at a test server laid out as <url>/app, <url>/core.

# Its own scope: under `irm | iex` it would otherwise set the caller's variables.
& {
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# throw, not exit: under `irm | iex`, exit would close the person's window.
function Fail($why) { throw "atrous: $why" }

$releases = if ($env:ATROUS_RELEASES_URL) { $env:ATROUS_RELEASES_URL.TrimEnd("/") } else { $null }
$appLatest = if ($releases) { "$releases/app" } else { "https://github.com/zecod/atrous/releases/latest/download" }
$coreLatest = if ($releases) { "$releases/core" } else { "https://github.com/zecod/atrous-core/releases/latest/download" }
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
    curl.exe -fsSL "$appLatest/latest.json" -o "$tmp\latest.json"
    if ($LASTEXITCODE) { Fail "no release found at $appLatest (none published yet, or offline)" }
    $m = Get-Content -Raw "$tmp\latest.json" | ConvertFrom-Json
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
    if ($LASTEXITCODE -or -not (Test-Path "$tmp\atrous\atrous.exe")) { Fail "the download holds no complete app" }

    # A running app's folder can be renamed, not deleted: the old one goes
    # now if it can, else on the next install.
    New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
    Remove-Item -Recurse -Force "$dir.old" -ErrorAction SilentlyContinue
    if (Test-Path $dir) { Rename-Item $dir "$dir.old" }
    Move-Item "$tmp\atrous" $dir
    Remove-Item -Recurse -Force "$dir.old" -ErrorAction SilentlyContinue

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

    # The core: installed only if there's none yet. One that's already there
    # is left alone; the app updates it.
    $core = Join-Path $env:LOCALAPPDATA "Programs\atrous-core\atrous-core.exe"
    if (-not (Test-Path $core) -and -not (Get-Command atrous-core -ErrorAction SilentlyContinue)) {
        try {
            if ($releases) { $env:ATROUS_RELEASES_URL = $releases }
            Invoke-RestMethod "$coreLatest/install.ps1" | Invoke-Expression
        } catch {
            Write-Host "atrous-core didn't install; Atrous will offer it when it opens."
        }
    }

    Write-Host "Atrous is installed. Open it from the Start menu, or run: atrous"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
}
