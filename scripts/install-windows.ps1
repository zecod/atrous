# Builds this checkout (the app and its core, scripts/build.ps1) and installs
# it for the current Windows user into %LOCALAPPDATA%\Programs\atrous:
# atrous.exe, atrous-core.exe, atc.exe (a hard link to it), conpty\.
# A running Atrous and its core keep running from the folder moved aside;
# the next start restarts the core into the new one, terminals kept.
# $Core: the folder holding the built atrous-core.exe and conpty\ (none: app only).
# Whether a program still runs from $Dir: Windows won't open a running
# program's file (or a DLL it loaded) for writing. Process paths can't tell:
# after its folder is renamed a process still reports the old path.
function Test-FolderBusy($Dir) {
    foreach ($f in Get-ChildItem -LiteralPath $Dir -Recurse -File -Include *.exe, *.dll -ErrorAction SilentlyContinue) {
        try { [IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None').Close() } catch { return $true }
    }
    return $false
}

function Install-AtrousFiles($Binary, $Icon, $Destination, $Core = $null) {
    $ErrorActionPreference = "Stop"
    $Destination = [IO.Path]::GetFullPath($Destination)
    $stage = "$Destination.install-$([guid]::NewGuid().ToString('N'))"
    $backup = "$Destination.old-$([guid]::NewGuid().ToString('N'))"
    $installed = $false
    try {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        Copy-Item -LiteralPath $Binary -Destination "$stage\atrous.exe"
        Copy-Item -LiteralPath $Icon -Destination "$stage\atrous.svg"
        if ($Core) {
            Copy-Item -LiteralPath (Join-Path $Core "atrous-core.exe") -Destination "$stage\atrous-core.exe"
            # atc.exe: the same file, as the core's own installer makes it.
            try { New-Item -ItemType HardLink -Path "$stage\atc.exe" -Target "$stage\atrous-core.exe" | Out-Null }
            catch { Copy-Item -LiteralPath "$stage\atrous-core.exe" -Destination "$stage\atc.exe" }
            Copy-Item -LiteralPath (Join-Path $Core "conpty") -Destination "$stage\conpty" -Recurse
        }
        # Renaming the folder leaves an already running app alive.
        if (Test-Path -LiteralPath $Destination) {
            Rename-Item -LiteralPath $Destination -NewName (Split-Path $backup -Leaf)
        }
        try {
            Rename-Item -LiteralPath $stage -NewName (Split-Path $Destination -Leaf)
        } catch {
            $installError = $_
            if (Test-Path -LiteralPath $backup) {
                try {
                    Rename-Item -LiteralPath $backup -NewName (Split-Path $Destination -Leaf)
                } catch {
                    throw "Installation failed: $installError. Could not restore the previous build at ${backup}: $_"
                }
            }
            throw $installError
        }
        $installed = $true
    } finally {
        if (Test-Path -LiteralPath $stage) {
            Remove-Item -LiteralPath $stage -Recurse -Force
        }
        if ($installed -and (Test-Path -LiteralPath $backup)) {
            # Never half of it: a core still running from there starts its
            # terminals with the conpty\ beside it.
            if (Test-FolderBusy $backup) {
                Write-Warning "Previous build remains at ${backup}: a program still runs from it. Remove it after quitting Atrous; its core moves to the new build on Atrous's next start."
            } else {
                try { Remove-Item -LiteralPath $backup -Recurse -Force }
                catch { Write-Warning "Previous build remains at $backup. Remove it after quitting Atrous." }
            }
        }
    }
}

# Dot-sourcing exposes only the file operation for isolated installer tests.
if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "This installer requires Windows." }

Push-Location "$PSScriptRoot\.."
try {
    & "$PSScriptRoot\build.ps1"
    $dir = Join-Path $env:LOCALAPPDATA "Programs\atrous"
    Install-AtrousFiles "target\release\atrous.exe" "assets\brand\atrous.svg" $dir "target\release"
} finally {
    Pop-Location
}

$menu = Join-Path ([Environment]::GetFolderPath("Programs")) "Atrous.lnk"
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)
$link.TargetPath = Join-Path $dir "atrous.exe"
$link.WorkingDirectory = $env:USERPROFILE
$link.Description = "Terminals and coding agents that keep running"
$link.Save()

# Keep literal %VARIABLES% and the existing registry value type in PATH.
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
try {
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $listed = $raw -split ";" | Where-Object { $_.Trim().TrimEnd("\") -ieq $dir.TrimEnd("\") }
    if (-not $listed) {
        $kind = if ($key.GetValueNames() -contains "Path") { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue("Path", $(if ($raw) { "$($raw.TrimEnd(';'));$dir" } else { $dir }), $kind)
        [Environment]::SetEnvironmentVariable("ATROUS_INSTALLING", "1", "User")
        [Environment]::SetEnvironmentVariable("ATROUS_INSTALLING", $null, "User")
    }
} finally {
    $key.Close()
}
if (($env:Path -split ";") -notcontains $dir) { $env:Path += ";$dir" }
Write-Host "Installed atrous with atrous-core and atc in $dir. Quit and reopen Atrous to use the new build; its terminals keep running."
