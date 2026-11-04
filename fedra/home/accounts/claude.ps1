# herdr's + menu starts Claude Code through this (programs.json "claude".run): the account
# chosen in Settings > Accounts, then `claude` with the same arguments. See launch.ps1.
. (Join-Path $PSScriptRoot 'launch.ps1')
Start-HerdrAccount 'claude' $args
