# DEVELOPERS ONLY: atrous-core ships inside Atrous (core/ of zecod/atrous)
# and installs and updates with it. This standalone installer is for working
# on the core alone.
#
# Installs atrous-core (atc) on Windows, or updates it:
#
#   powershell -c "irm https://github.com/zecod/atrous-core/releases/latest/download/install.ps1 | iex"
#
# Into %LOCALAPPDATA%\Programs\atrous-core (atrous-core.exe, Microsoft's
# ConPTY beside it), added to your PATH, with atc.exe linked to it only if no
# `atc` exists. An atc that is already there is swapped the planned way (atc
# update --from): running terminals keep running. No admin needed.
# ATC_VERSION=0.2.0 picks a version; ATC_RELEASES_URL points at other
# releases laid out like GitHub's (tests, mirrors); ATC_INSTALL_DIR installs
# elsewhere.
#
# `-File install.ps1 <release zip> [session]` installs from a zip already
# here, checked by whoever put it here, and removes both files after
# (`atc machine add` from another machine does that).

# Its own scope: under `irm | iex` it would otherwise set the caller's variables.
& {
$zip, $session = $args
if ($session) { $env:ATC_SESSION = $session }
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# throw, not exit: under `irm | iex`, exit would close the person's window.
function Fail($why) { throw "atc: $why" }

$releases = if ($env:ATC_RELEASES_URL) { $env:ATC_RELEASES_URL.TrimEnd("/") } else { "https://github.com/zecod/atrous-core/releases" }
$dir = if ($env:ATC_INSTALL_DIR) { $env:ATC_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\atrous-core" }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne "AMD64") { Fail "no build for $arch Windows yet (x64 only)" }
$target = "windows-x86_64"
# Windows' own tar opens zips; Git Bash's, often first on PATH, can't.
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue) -or -not (Test-Path $tar)) {
    Fail "needs curl.exe and tar.exe (Windows 10 1803 or newer)"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "atc-install-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  if ($zip) {
    Copy-Item $zip "$tmp\atc.zip"
  } else {
    $manifest = if ($env:ATC_VERSION) { "$releases/download/v$($env:ATC_VERSION)/manifest.json" } else { "$releases/latest/download/manifest.json" }
    curl.exe -fsSL $manifest -o "$tmp\manifest.json"
    if ($LASTEXITCODE) { Fail "cannot reach $manifest (no release published there yet?)" }
    $m = Get-Content -Raw "$tmp\manifest.json" | ConvertFrom-Json
    $t = $m.targets.$target
    if (-not $t.url -or -not $t.sha256) { Fail "no build for $target in $manifest" }

    curl.exe -fsSL $t.url -o "$tmp\atc.zip"
    if ($LASTEXITCODE) { Fail "download failed: $($t.url)" }
    # .NET, not Get-FileHash: that one fails when PowerShell 7 starts 5.1.
    $stream = [IO.File]::OpenRead("$tmp\atc.zip")
    try { $got = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) } finally { $stream.Close() }
    if ($got -ne $t.sha256) { Fail "the download is damaged (checksum mismatch); try again" }
  }
    New-Item -ItemType Directory -Force "$tmp\atc" | Out-Null
    & $tar -xf "$tmp\atc.zip" -C "$tmp\atc"
    $new = "$tmp\atc\atrous-core.exe"
    if ($LASTEXITCODE -or -not (Test-Path "$tmp\atc\conpty\conpty.dll")) { Fail "the download holds no complete atc" }
    $version = (& $new --version) -replace "^atc ", ""
    if ($LASTEXITCODE) { Fail "the downloaded atc does not run on this machine" }

    New-Item -ItemType Directory -Force $dir | Out-Null
    $exe = Join-Path $dir "atrous-core.exe"
    if (Test-Path $exe) {
        # Swapped the planned way, so its terminals keep running.
        & $exe update --from $new | Out-Null
        if ($LASTEXITCODE) { Fail "updating $exe failed (see above)" }
        Write-Host "atc updated to $version."
    } else {
        Copy-Item -Recurse -Force "$tmp\atc\atrous-core.exe", "$tmp\atc\conpty" $dir
        Write-Host "atc $version installed into $dir."
    }
    Copy-Item -Recurse -Force "$tmp\atc\THIRD-PARTY-NOTICES" $dir -ErrorAction SilentlyContinue
    if (-not (Get-Command atc -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $dir "atc.exe"))) {
        New-Item -ItemType HardLink -Path (Join-Path $dir "atc.exe") -Target $exe | Out-Null
    }

    # The raw user PATH, so %VARIABLES% in it stay unexpanded and keep their type.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $listed = $raw -split ";" | Where-Object { $_.Trim().TrimEnd("\") -ieq $dir.TrimEnd("\") }
    if (-not $listed) {
        $kind = if ($key.GetValueNames() -contains "Path") { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue("Path", $(if ($raw) { "$($raw.TrimEnd(';'));$dir" } else { $dir }), $kind)
        # Setting any user variable tells running programs the environment changed.
        [Environment]::SetEnvironmentVariable("ATC_INSTALLING", "1", "User")
        [Environment]::SetEnvironmentVariable("ATC_INSTALLING", $null, "User")
        Write-Host "Added $dir to your PATH: new terminals have atc."
    }
    $key.Close()
    if (($env:Path -split ";") -notcontains $dir) { $env:Path += ";$dir" }
    Write-Host "Agents: atc --skill. People: atc --help."
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    if ($zip) { Remove-Item -Force $zip, $PSCommandPath -ErrorAction SilentlyContinue }
}
} @args
