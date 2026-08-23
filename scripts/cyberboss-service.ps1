[CmdletBinding()]
param(
  [ValidateSet("Start", "Restart", "FullRestart", "Status")]
  [string]$Mode = "Start"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProjectEnvFile = Join-Path $ProjectRoot ".env"

function Repair-DuplicatePathEnvironment {
  # Some launchers inject both `Path` and `PATH`. Windows PowerShell 5.1 then
  # throws from Start-Process while copying the environment dictionary.
  $environment = [Environment]::GetEnvironmentVariables("Process")
  $pathKeys = @($environment.Keys | Where-Object { [string]$_ -ieq "Path" })
  if ($pathKeys.Count -le 1) {
    return
  }

  $pathValue = ""
  foreach ($key in @("Path", "PATH") + $pathKeys) {
    $candidate = [string]$environment[$key]
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      $pathValue = $candidate
      break
    }
  }
  foreach ($key in $pathKeys) {
    [Environment]::SetEnvironmentVariable([string]$key, $null, "Process")
  }
  [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
}

Repair-DuplicatePathEnvironment

function Get-ProjectEnvValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue.Trim()
  }
  if (-not (Test-Path -LiteralPath $ProjectEnvFile)) {
    return ""
  }

  foreach ($line in Get-Content -LiteralPath $ProjectEnvFile) {
    if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return ""
}

$configuredStateDir = Get-ProjectEnvValue -Name "CYBERBOSS_STATE_DIR"
$StateDir = if ($configuredStateDir) { $configuredStateDir } else { Join-Path $HOME ".cyberboss" }
$configuredPort = Get-ProjectEnvValue -Name "CYBERBOSS_SHARED_PORT"
$Port = if ($configuredPort -match "^\d+$") { [int]$configuredPort } else { 8765 }
$LogDir = Join-Path $StateDir "logs"
$BridgePidFile = Join-Path $LogDir "shared-wechat.pid"
$AppServerPidFile = Join-Path $LogDir "shared-app-server.pid"
$WeFlowUiaBridgePidFile = Join-Path $LogDir "weflow-uia-bridge.pid"

function Read-PidFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return 0
  }
  $raw = (Get-Content -LiteralPath $Path -Raw).Trim()
  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
    return $parsed
  }
  return 0
}

function Test-PidAlive {
  param([int]$PidValue)

  if ($PidValue -le 0) {
    return $false
  }
  return $null -ne (Get-Process -Id $PidValue -ErrorAction SilentlyContinue)
}

function Get-ProcessCommandLine {
  param([int]$PidValue)

  if ($PidValue -le 0) {
    return ""
  }
  try {
    return [string](Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue").CommandLine
  } catch {
    throw "Could not inspect PID $PidValue. Restart PowerShell as the same Windows user or as Administrator."
  }
}

function Stop-VerifiedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$CommandPattern
  )

  $pidValue = Read-PidFile -Path $PidFile
  if (-not (Test-PidAlive -PidValue $pidValue)) {
    Write-Host "${Label}: not running"
    return
  }

  $commandLine = Get-ProcessCommandLine -PidValue $pidValue
  if ($commandLine -notmatch $CommandPattern) {
    throw "$Label PID $pidValue did not match the expected Cyberboss command. It was left untouched."
  }

  Write-Host "Stopping $Label PID $pidValue ..."
  Stop-Process -Id $pidValue -Force
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    if (-not (Test-PidAlive -PidValue $pidValue)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "$Label PID $pidValue did not stop within 5 seconds."
}

function Test-Ready {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Test-WeFlowUiaReady {
  $enabled = (Get-ProjectEnvValue -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX").ToLowerInvariant() -eq "true"
  if (-not $enabled) {
    return $true
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8766/readyz" -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Test-TcpPort {
  param([Parameter(Mandatory = $true)][int]$PortNumber)

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect("127.0.0.1", $PortNumber, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500)) {
      return $false
    }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Ensure-WeFlowReady {
  $enabled = (Get-ProjectEnvValue -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX").ToLowerInvariant() -eq "true"
  if (-not $enabled -or (Test-TcpPort -PortNumber 5031)) {
    return
  }

  $configuredExe = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_EXE"
  $weFlowExe = if ($configuredExe) {
    $configuredExe
  } else {
    Join-Path $env:LOCALAPPDATA "Programs\WeFlow\WeFlow.exe"
  }
  if (-not (Test-Path -LiteralPath $weFlowExe)) {
    throw "WeFlow inbox is enabled, port 5031 is down, and WeFlow.exe was not found at: $weFlowExe"
  }

  Write-Host "WeFlow API is down; starting WeFlow ..."
  Start-Process -FilePath $weFlowExe -WorkingDirectory (Split-Path -Parent $weFlowExe) | Out-Null
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (Test-TcpPort -PortNumber 5031) {
      Write-Host "WeFlow API is ready on port 5031."
      return
    }
  }
  throw "WeFlow started but its local API did not listen on port 5031 within 20 seconds. Check the WeFlow window and login state."
}

function Stop-WeFlowProcesses {
  $configuredExe = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_EXE"
  $weFlowExe = if ($configuredExe) {
    $configuredExe
  } else {
    Join-Path $env:LOCALAPPDATA "Programs\WeFlow\WeFlow.exe"
  }
  $expectedPath = [IO.Path]::GetFullPath($weFlowExe)
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) `
      -and [string]::Equals([IO.Path]::GetFullPath([string]$_.ExecutablePath), $expectedPath, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($processes.Count -eq 0) {
    Write-Host "WeFlow: not running"
    return
  }

  $pids = @($processes | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Descending)
  Write-Host "Stopping WeFlow process tree PIDs $($pids -join ', ') ..."
  foreach ($pidValue in $pids) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    if (-not (Test-TcpPort -PortNumber 5031)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "WeFlow API port 5031 remained open after all verified WeFlow processes were stopped."
}

function Stop-CyberbossComponents {
  Stop-VerifiedProcess `
    -Label "Bridge" `
    -PidFile $BridgePidFile `
    -CommandPattern "(?:^|[\\/])bin[\\/]cyberboss\.js\s+start(?:\s|$)"
  Stop-VerifiedProcess `
    -Label "App Server" `
    -PidFile $AppServerPidFile `
    -CommandPattern "(?:^|\s)app-server(?:\s|$).*--listen\s+ws://127\.0\.0\.1:$Port(?:\s|$)"
  Stop-VerifiedProcess `
    -Label "WeFlow UIA Bridge" `
    -PidFile $WeFlowUiaBridgePidFile `
    -CommandPattern "weflow-uia-bridge\.py(?:\s|$)"
}

function Show-ServiceStatus {
  $bridgePid = Read-PidFile -Path $BridgePidFile
  $appServerPid = Read-PidFile -Path $AppServerPidFile
  $bridgeAlive = Test-PidAlive -PidValue $bridgePid
  $appServerAlive = Test-PidAlive -PidValue $appServerPid
  $ready = Test-Ready
  $weFlowEnabled = (Get-ProjectEnvValue -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX").ToLowerInvariant() -eq "true"
  $weFlowUiaBridgePid = Read-PidFile -Path $WeFlowUiaBridgePidFile
  $weFlowUiaBridgeAlive = Test-PidAlive -PidValue $weFlowUiaBridgePid
  $weFlowUiaReady = Test-WeFlowUiaReady

  Write-Host "Cyberboss status"
  Write-Host "  Bridge:     $(if ($bridgeAlive) { "running PID $bridgePid" } else { "stopped" })"
  Write-Host "  App Server: $(if ($appServerAlive) { "running PID $appServerPid" } else { "stopped" })"
  Write-Host "  Readyz:     $(if ($ready) { "OK" } else { "DOWN" })"
  if ($weFlowEnabled) {
    Write-Host "  WeFlow UIA: $(if ($weFlowUiaBridgeAlive -and $weFlowUiaReady) { "running PID $weFlowUiaBridgePid" } else { "DOWN" })"
  }
  return $bridgeAlive -and $appServerAlive -and $ready -and $weFlowUiaReady
}

function Start-CyberbossService {
  Ensure-WeFlowReady
  $bridgePid = Read-PidFile -Path $BridgePidFile
  if (Test-PidAlive -PidValue $bridgePid) {
    Write-Host "Cyberboss is already running. The singleton lock prevents a second instance."
    [void](Show-ServiceStatus)
    return
  }

  New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdoutLog = Join-Path $StateDir "cyberboss.service.$stamp.out.log"
  $stderrLog = Join-Path $StateDir "cyberboss.service.$stamp.err.log"
  $nodeCommand = (Get-Command "node.exe" -ErrorAction Stop).Source
  $launcherScript = Join-Path $PSScriptRoot "shared-launch.js"

  Write-Host "Starting Cyberboss in the background ..."
  $launcherPidText = & $nodeCommand $launcherScript --stdout $stdoutLog --stderr $stderrLog
  if ($LASTEXITCODE -ne 0 -or $launcherPidText -notmatch "^\d+$") {
    throw "Detached launcher failed: $launcherPidText"
  }
  $launcherPid = [int]$launcherPidText

  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    $newBridgePid = Read-PidFile -Path $BridgePidFile
    if ((Test-PidAlive -PidValue $newBridgePid) -and (Test-Ready) -and (Test-WeFlowUiaReady)) {
      Write-Host "Cyberboss started successfully."
      Write-Host "  Launcher PID: $launcherPid"
      Write-Host "  Bridge PID:   $newBridgePid"
      Write-Host "  Output log:   $stdoutLog"
      [void](Show-ServiceStatus)
      return
    }
    if (-not (Test-PidAlive -PidValue $launcherPid)) {
      break
    }
  }

  Write-Host "Cyberboss did not become ready."
  Write-Host "  Output log: $stdoutLog"
  Write-Host "  Error log:  $stderrLog"
  if (Test-Path -LiteralPath $stdoutLog) {
    Get-Content -LiteralPath $stdoutLog -Tail 30
  }
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 30
  }
  throw "Cyberboss startup health check failed."
}

switch ($Mode) {
  "Status" {
    $healthy = Show-ServiceStatus
    if (-not $healthy) {
      exit 1
    }
  }
  "Restart" {
    Stop-CyberbossComponents
    Start-Sleep -Seconds 1
    Start-CyberbossService
  }
  "FullRestart" {
    Stop-CyberbossComponents
    Stop-WeFlowProcesses
    $openPorts = @($Port, 8766, 5031) | Where-Object { Test-TcpPort -PortNumber $_ }
    if ($openPorts.Count -gt 0) {
      throw "Full restart stop verification failed; ports still open: $($openPorts -join ', ')"
    }
    Write-Host "All Cyberboss components are stopped; starting a clean service stack ..."
    Start-Sleep -Seconds 1
    Start-CyberbossService
  }
  default {
    Start-CyberbossService
  }
}
