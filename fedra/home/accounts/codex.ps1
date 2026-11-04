# herdr's + menu starts Codex through this (programs.json "codex".run): the account chosen in
# Settings > Accounts, then `codex` with the same arguments. See launch.ps1.
. (Join-Path $PSScriptRoot 'launch.ps1')
Start-HerdrAccount 'codex' $args
