[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = "Cyberboss Heartbeat Watchdog",
  [switch]$PrintDefinition
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$HiddenLauncher = Join-Path $PSScriptRoot "cyberboss-watchdog-hidden.vbs"
$WscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$RepetitionInterval = [TimeSpan]::FromMinutes(2)
$ExecutionTimeLimit = [TimeSpan]::FromMinutes(10)
$ActionArguments = "//B //NoLogo `"$HiddenLauncher`""

$definition = [ordered]@{
  version = 1
  taskName = $TaskName
  executable = $WscriptPath
  arguments = $ActionArguments
  workingDirectory = $ProjectRoot
  logonType = "InteractiveToken"
  runLevel = "Limited"
  repetitionInterval = "PT2M"
  multipleInstances = "IgnoreNew"
  executionTimeLimit = "PT10M"
}

if ($PrintDefinition) {
  $definition | ConvertTo-Json -Compress
  return
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "Cyberboss watchdog task installation requires Windows"
}
if (-not (Test-Path -LiteralPath $WscriptPath -PathType Leaf)) {
  throw "wscript.exe is missing at $WscriptPath"
}
if (-not (Test-Path -LiteralPath $HiddenLauncher -PathType Leaf)) {
  throw "hidden watchdog launcher is missing at $HiddenLauncher"
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($currentIdentity)) {
  throw "the current interactive Windows identity could not be resolved"
}

$action = New-ScheduledTaskAction `
  -Execute $WscriptPath `
  -Argument $ActionArguments `
  -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval $RepetitionInterval
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentIdentity `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit $ExecutionTimeLimit `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Hidden Cyberboss end-to-end heartbeat guardian; bounded recovery and canary verification."

if ($PSCmdlet.ShouldProcess($TaskName, "register Cyberboss heartbeat watchdog task")) {
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  Write-Output "Registered scheduled task '$TaskName'."
}
