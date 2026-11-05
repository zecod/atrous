$ErrorActionPreference = "Stop"
. "$PSScriptRoot\install-windows.ps1"

function Assert($Condition, $Message) {
    if (-not $Condition) { throw $Message }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "atrous-install-test-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $binary = Join-Path $tmp "build.exe"
    $icon = Join-Path $tmp "icon.svg"
    $destination = Join-Path $tmp "Programs\atrous"
    Set-Content -LiteralPath $binary -Value "first build"
    Set-Content -LiteralPath $icon -Value "icon"
    Install-AtrousFiles $binary $icon $destination
    Assert ((Get-Content "$destination\atrous.exe") -eq "first build") "First install lost the binary"
    Assert ((Get-Content "$destination\atrous.svg") -eq "icon") "First install lost the icon"

    Set-Content -LiteralPath $binary -Value "new build"
    Install-AtrousFiles $binary $icon $destination
    Assert ((Get-Content "$destination\atrous.exe") -eq "new build") "Replacement kept the old binary"
    Assert ((Get-ChildItem (Split-Path $destination)).Count -eq 1) "Replacement left temporary files"

    # With the core: atrous-core.exe, atc.exe (the same file) and conpty\ beside the app.
    $core = Join-Path $tmp "core"
    New-Item -ItemType Directory -Path "$core\conpty\x64" | Out-Null
    Set-Content -LiteralPath "$core\atrous-core.exe" -Value "core build"
    Set-Content -LiteralPath "$core\conpty\conpty.dll" -Value "conpty"
    Set-Content -LiteralPath "$core\conpty\x64\OpenConsole.exe" -Value "console"
    Install-AtrousFiles $binary $icon $destination $core
    Assert ((Get-Content "$destination\atrous-core.exe") -eq "core build") "Install lost the core"
    Assert ((Get-Content "$destination\atc.exe") -eq "core build") "Install lost atc"
    Assert ((Get-Content "$destination\conpty\x64\OpenConsole.exe") -eq "console") "Install lost conpty"
    Assert ((Get-ChildItem (Split-Path $destination)).Count -eq 1) "Install with the core left temporary files"

    # Fail the promotion, then the rollback too, using real moves otherwise.
    function Rename-Item {
        param($LiteralPath, $NewName)
        $script:moves++
        if ($script:failMoves -contains $script:moves) { throw "injected move failure $script:moves" }
        Microsoft.PowerShell.Management\Rename-Item -LiteralPath $LiteralPath -NewName $NewName
    }
    foreach ($failures in @(@(2), @(2, 3))) {
        $script:moves = 0
        $script:failMoves = $failures
        $errorText = $null
        try { Install-AtrousFiles $binary $icon $destination }
        catch { $errorText = $_.ToString() }
        Assert ($null -ne $errorText) "Failed installation reported success"
        if ($failures.Count -eq 1) {
            Assert ((Get-Content "$destination\atrous.exe") -eq "new build") "Rollback lost the previous build"
        } else {
            $backup = Get-ChildItem (Split-Path $destination) -Directory -Filter "atrous.old-*"
            Assert ($backup.Count -eq 1) "Failed rollback lost the backup"
            Assert ($errorText.Contains($backup.FullName)) "Failed rollback did not report the backup path"
            Assert ((Get-Content "$($backup.FullName)\atrous.exe") -eq "new build") "Failed rollback damaged the backup"
        }
        Assert (-not (Get-ChildItem (Split-Path $destination) -Directory -Filter "atrous.install-*")) "Failed install left staging files"
    }
    Write-Host "Installer file replacement and rollback checks passed."
} finally {
    Remove-Item Function:Rename-Item -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmp -Recurse -Force
}
