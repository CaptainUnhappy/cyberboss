# queue-root.ps1 - the machine bindings every isolated-session recipe shares.
#
# Why this file exists: these recipes hardcoded `D:\Projects\cyberboss` and
# `C:\ProgramData\cwin-probe`, so a checkout that moved (another drive, another
# machine) kept writing to the old queue and reading the old `.env` -- silently,
# because a missing queue directory looks exactly like an idle worker. Dot-source
# this instead of writing a literal:
#
#   . (Join-Path $PSScriptRoot 'queue-root.ps1')
#
# ASCII only: PowerShell 5.1 reads BOM-less files as the ANSI code page.

$repoRoot = if ($env:CYBERBOSS_REPO_ROOT) { $env:CYBERBOSS_REPO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$root = if ($env:CYBERBOSS_QUEUE_ROOT) { $env:CYBERBOSS_QUEUE_ROOT } else { 'C:\ProgramData\cwin-probe' }
$envFile = Join-Path $repoRoot '.env'
$queueIn = Join-Path $root 's4\in'
