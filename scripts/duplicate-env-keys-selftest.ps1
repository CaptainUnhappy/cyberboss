# duplicate-env-keys-selftest.ps1 - two-sided proof for Repair-DuplicateEnvironmentKeys.
#
# Side A reproduces the heartbeat failure of 2026-09-28: copying a process
# environment that holds keys differing only by case (NO_PROXY/no_proxy,
# http_proxy/HTTP_PROXY, https_proxy/HTTPS_PROXY from a hosted shell) into a
# case-insensitive dictionary throws "Item has already been added", which is what
# killed the repair one second after its restart notification was activated.
# Side B runs the real function out of scripts/cyberboss-watchdog.ps1 and shows
# the same copy succeed.
$ErrorActionPreference = 'Continue'
$watchdog = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\cyberboss-watchdog.ps1'
if (-not (Test-Path -LiteralPath $watchdog)) { $watchdog = Join-Path $PSScriptRoot 'cyberboss-watchdog.ps1' }

function Copy-ProcessEnvironment {
  $copy = @{}
  foreach ($key in [Environment]::GetEnvironmentVariables('Process').Keys) {
    $copy.Add([string]$key, 'x')
  }
  return $copy.Count
}

$env:NO_PROXY = 'upper'
$env:no_proxy = 'lower'
$env:http_proxy = 'a'
$env:HTTP_PROXY = 'b'

$beforeError = ''
try { $null = Copy-ProcessEnvironment } catch { $beforeError = $_.Exception.Message.Split([char]10)[0] }
Write-Host ("before collapse: " + $(if ($beforeError) { "threw -> $beforeError" } else { "no throw" }))

$text = [IO.File]::ReadAllText($watchdog)
$match = [regex]::Match($text, '(?ms)^function Repair-DuplicateEnvironmentKeys \{.*?^\}')
if (-not $match.Success) { Write-Host 'FAIL: Repair-DuplicateEnvironmentKeys not found in watchdog'; exit 1 }
Invoke-Expression $match.Value
Repair-DuplicateEnvironmentKeys

$afterError = ''
$afterCount = 0
try { $afterCount = Copy-ProcessEnvironment } catch { $afterError = $_.Exception.Message.Split([char]10)[0] }
Write-Host ("after collapse: " + $(if ($afterError) { "threw -> $afterError" } else { "copied $afterCount keys" }))

if ($beforeError -and -not $afterError) { Write-Host 'PASS'; exit 0 }
Write-Host 'FAIL'
exit 1