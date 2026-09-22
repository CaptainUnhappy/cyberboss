[CmdletBinding()]
param(
  [ValidateSet("Start", "Stop", "Restart", "FullRestart", "Status")]
  [string]$Mode = "Start"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProjectEnvFile = Join-Path $ProjectRoot ".env"
$UserEnvFile = Join-Path (Join-Path $HOME ".cyberboss") ".env"

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
  # Keep project-local configuration authoritative, then fall back to the
  # per-user Cyberboss environment used by the watchdog/scheduled task.
  foreach ($envFile in @($ProjectEnvFile, $UserEnvFile)) {
    if (-not (Test-Path -LiteralPath $envFile)) {
      continue
    }
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$") {
        return $Matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
  return ""
}

function Test-ProjectEnvFlag {
  param([Parameter(Mandatory = $true)][string]$Name)

  return (Get-ProjectEnvValue -Name $Name) -match "^(?i:1|true|yes|on)$"
}

function Resolve-HttpServiceEndpoint {
  param(
    [string]$ConfiguredBaseUrl,
    [Parameter(Mandatory = $true)][string]$DefaultBaseUrl,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $candidate = if ([string]::IsNullOrWhiteSpace($ConfiguredBaseUrl)) {
    $DefaultBaseUrl
  } else {
    $ConfiguredBaseUrl.Trim()
  }
  $uri = $null
  if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) `
      -or $uri.Scheme -notin @("http", "https") `
      -or [string]::IsNullOrWhiteSpace($uri.Host) `
      -or -not [string]::IsNullOrWhiteSpace($uri.UserInfo)) {
    throw "$Label base URL must be an absolute http(s) URL without embedded credentials: $candidate"
  }

  $hostName = $uri.DnsSafeHost
  $address = $null
  $isLoopback = [string]::Equals($hostName, "localhost", [StringComparison]::OrdinalIgnoreCase)
  if (-not $isLoopback -and [Net.IPAddress]::TryParse($hostName, [ref]$address)) {
    $isLoopback = [Net.IPAddress]::IsLoopback($address)
  }

  return [pscustomobject][ordered]@{
    BaseUrl = $candidate.TrimEnd('/')
    Host = $hostName
    Port = [int]$uri.Port
    IsLoopback = [bool]$isLoopback
  }
}

$configuredStateDir = Get-ProjectEnvValue -Name "CYBERBOSS_STATE_DIR"
$StateDir = if ($configuredStateDir) { $configuredStateDir } else { Join-Path $HOME ".cyberboss" }
$configuredPort = Get-ProjectEnvValue -Name "CYBERBOSS_SHARED_PORT"
$Port = if ($configuredPort -match "^\d+$") { [int]$configuredPort } else { 8765 }
$configuredWeFlowBaseUrl = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_BASE_URL"
$WeFlowEndpoint = Resolve-HttpServiceEndpoint `
  -ConfiguredBaseUrl $configuredWeFlowBaseUrl `
  -DefaultBaseUrl "http://127.0.0.1:5031" `
  -Label "WeFlow"
$WeFlowBaseUrl = $WeFlowEndpoint.BaseUrl
$configuredWeFlowUiaBaseUrl = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_BRIDGE_BASE_URL"
$WeFlowUiaEndpoint = Resolve-HttpServiceEndpoint `
  -ConfiguredBaseUrl $configuredWeFlowUiaBaseUrl `
  -DefaultBaseUrl "http://127.0.0.1:8766" `
  -Label "WeFlow UIA"
$WeFlowUiaBaseUrl = $WeFlowUiaEndpoint.BaseUrl
$LogDir = Join-Path $StateDir "logs"
$BridgePidFile = Join-Path $LogDir "shared-wechat.pid"
$AppServerPidFile = Join-Path $LogDir "shared-app-server.pid"
$WeFlowUiaBridgePidFile = Join-Path $LogDir "weflow-uia-bridge.pid"
$PipelineActivityFile = Join-Path $StateDir "cyberboss-pipeline-activity.json"
$BridgeCommandPattern = "(?:^|[\\/])bin[\\/]cyberboss\.js\s+start(?:\s|$)"
$AppServerCommandPattern = "(?:^|\s)app-server(?:\s|$).*--listen\s+ws://127\.0\.0\.1:$Port(?:\s|$)"
$WeFlowUiaCommandPattern = 'weflow-uia-bridge\.py"?(?:\s|$)'
$SharedStartCommandPattern = 'shared-start\.js"?(?:\s|$)'
# The shared Codex app-server belongs to the codex runtime only; every other
# runtime skips it. Startup readiness must not require a component the selected
# runtime never starts, or the deadline trips and the rollback tears down a
# perfectly healthy stack.
$ServiceRuntime = Get-ProjectEnvValue -Name "CYBERBOSS_RUNTIME"
if ([string]::IsNullOrWhiteSpace($ServiceRuntime)) { $ServiceRuntime = "codex" }
$AppServerRequired = $ServiceRuntime.Trim().ToLowerInvariant() -eq "codex"

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

function Test-VerifiedPidAlive {
  param(
    [int]$PidValue,
    [Parameter(Mandatory = $true)][string]$CommandPattern
  )

  if (-not (Test-PidAlive -PidValue $PidValue)) {
    return $false
  }
  try {
    $commandLine = Get-ProcessCommandLine -PidValue $PidValue
    return -not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -match $CommandPattern
  } catch {
    return $false
  }
}

function Write-PidFileAtomic {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$PidValue
  )

  if ($PidValue -le 0) { throw "refusing to persist an invalid PID: $PidValue" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $temporary = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($temporary, "$PidValue`r`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Repair-PidFileFromListener {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$CommandPattern,
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][int]$PortNumber,
    # Set for components that may live in the isolated session, where the
    # command line is unreadable across Windows accounts.
    [switch]$AllowEndpointOwnership
  )

  $currentPid = Read-PidFile -Path $PidFile
  $endpointOwned = [bool]$AllowEndpointOwnership `
    -and (Test-PidOwnsTcpEndpoint -PidValue $currentPid -HostName $HostName -PortNumber $PortNumber)
  if ((Test-VerifiedPidAlive -PidValue $currentPid -CommandPattern $CommandPattern) -or $endpointOwned) {
    if (Test-TcpPort -HostName $HostName -PortNumber $PortNumber) {
      $currentListeners = @(Get-TcpListenerProcessIds -PortNumber $PortNumber)
      if ($currentListeners.Count -ne 1 -or [int]$currentListeners[0] -ne $currentPid) {
        throw "$Label PID $currentPid is verified, but endpoint ${HostName}:$PortNumber has a different or ambiguous owner; it was left untouched"
      }
    }
    return $currentPid
  }
  if (Test-PidAlive -PidValue $currentPid) {
    throw "$Label PID file points to live PID $currentPid with an unexpected command; it was left untouched"
  }
  if (-not (Test-TcpPort -HostName $HostName -PortNumber $PortNumber)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return 0
  }

  $listenerPids = @(Get-TcpListenerProcessIds -PortNumber $PortNumber)
  $verified = @($listenerPids | Where-Object {
    Test-VerifiedPidAlive -PidValue ([int]$_) -CommandPattern $CommandPattern
  })
  if ($AllowEndpointOwnership -and $listenerPids.Count -eq 1 -and (Test-PidAlive -PidValue ([int]$listenerPids[0]))) {
    Write-PidFileAtomic -Path $PidFile -PidValue ([int]$listenerPids[0])
    Write-Host "$Label PID file recovered from the sole endpoint owner PID $($listenerPids[0]) (identity by endpoint ownership)."
    return [int]$listenerPids[0]
  }
  if ($listenerPids.Count -ne 1 -or $verified.Count -ne 1) {
    throw "$Label endpoint ${HostName}:$PortNumber is open, but its sole owner could not be verified; it was left untouched"
  }
  Write-PidFileAtomic -Path $PidFile -PidValue ([int]$verified[0])
  Write-Host "$Label PID file recovered from verified listener PID $($verified[0])."
  return [int]$verified[0]
}

function Repair-BridgePidFileFromActivity {
  $currentPid = Read-PidFile -Path $BridgePidFile
  if (Test-VerifiedPidAlive -PidValue $currentPid -CommandPattern $BridgeCommandPattern) {
    return $currentPid
  }
  if (Test-PidAlive -PidValue $currentPid) {
    throw "Bridge PID file points to live PID $currentPid with an unexpected command; it was left untouched"
  }
  Remove-Item -LiteralPath $BridgePidFile -Force -ErrorAction SilentlyContinue

  if (Test-Path -LiteralPath $PipelineActivityFile) {
    try {
      $activity = Get-Content -LiteralPath $PipelineActivityFile -Raw | ConvertFrom-Json
      $activityPid = [int]$activity.pid
      $updatedAt = [DateTimeOffset]::Parse([string]$activity.updatedAt).ToUniversalTime()
      $ageSeconds = ([DateTimeOffset]::UtcNow - $updatedAt).TotalSeconds
      if ($ageSeconds -ge 0 -and $ageSeconds -le 120 `
          -and (Test-VerifiedPidAlive -PidValue $activityPid -CommandPattern $BridgeCommandPattern)) {
        Write-PidFileAtomic -Path $BridgePidFile -PidValue $activityPid
        Write-Host "Bridge PID file recovered from fresh pipeline activity PID $activityPid."
        return $activityPid
      }
    } catch {
      # A malformed/stale activity file is not enough evidence to claim a PID.
    }
  }

  $matchingPids = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) `
      -and [string]$_.CommandLine -match $BridgeCommandPattern
  } | ForEach-Object { [int]$_.ProcessId })
  if ($matchingPids.Count -gt 0) {
    throw "Bridge PID metadata is missing, but candidate process PIDs $($matchingPids -join ', ') exist without fresh project activity proof; no duplicate was started"
  }
  return 0
}

function Repair-ManagedPidFiles {
  $null = Repair-BridgePidFileFromActivity
  $null = Repair-PidFileFromListener `
    -Label "App Server" `
    -PidFile $AppServerPidFile `
    -CommandPattern $AppServerCommandPattern `
    -HostName "127.0.0.1" `
    -PortNumber $Port
  if ((Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX") -and $WeFlowUiaEndpoint.IsLoopback) {
    $null = Repair-PidFileFromListener `
      -Label "WeFlow UIA Bridge" `
      -PidFile $WeFlowUiaBridgePidFile `
      -CommandPattern $WeFlowUiaCommandPattern `
      -HostName $WeFlowUiaEndpoint.Host `
      -PortNumber $WeFlowUiaEndpoint.Port `
      -AllowEndpointOwnership
  }
}

function Get-ServiceControllerMutexName {
  $normalizedRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/').ToLowerInvariant()
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedRoot))
  } finally {
    $sha256.Dispose()
  }
  $suffix = ([BitConverter]::ToString($digest)).Replace("-", "").Substring(0, 24)
  return "Local\Cyberboss.ServiceController.$suffix"
}

function Invoke-WithServiceControllerMutex {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [int]$WaitMilliseconds = 5000
  )

  $mutex = New-Object System.Threading.Mutex($false, (Get-ServiceControllerMutexName))
  $acquired = $false
  try {
    try {
      $acquired = $mutex.WaitOne($WaitMilliseconds)
    } catch [Threading.AbandonedMutexException] {
      $acquired = $true
    }
    if (-not $acquired) {
      throw "another Cyberboss service operation is still running; retry after it completes"
    }
    return & $Action
  } finally {
    if ($acquired) {
      [void]$mutex.ReleaseMutex()
    }
    $mutex.Dispose()
  }
}

function Remove-PidFileIfMatches {
  param(
    [string]$Path,
    [int]$PidValue
  )

  if ($Path -and (Read-PidFile -Path $Path) -eq $PidValue) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-TaskkillProcessTree {
  param(
    [Parameter(Mandatory = $true)][int]$PidValue,
    [switch]$Force
  )

  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  if (-not (Test-Path -LiteralPath $taskkill)) {
    return $null
  }

  # Do not attach taskkill's native stderr to PowerShell's error stream. On
  # Windows it can report an already-exiting child as an error even though the
  # requested root process was terminated successfully. With
  # $ErrorActionPreference=Stop that diagnostic used to abort FullRestart
  # before the authoritative root-process check below could run.
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $taskkill
  $forceArgument = if ($Force) { " /F" } else { "" }
  $startInfo.Arguments = "/PID $PidValue /T$forceArgument"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw "taskkill did not start for PID $PidValue"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [pscustomobject][ordered]@{
      ExitCode = [int]$process.ExitCode
      StandardOutput = [string]$stdoutTask.GetAwaiter().GetResult()
      StandardError = [string]$stderrTask.GetAwaiter().GetResult()
    }
  } finally {
    $process.Dispose()
  }
}

function Stop-VerifiedPidValue {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][int]$PidValue,
    [string]$PidFile = "",
    [Parameter(Mandatory = $true)][string]$CommandPattern,
    [string]$HostName = "",
    [int]$PortNumber = 0
  )

  if (-not (Test-PidAlive -PidValue $pidValue)) {
    Remove-PidFileIfMatches -Path $PidFile -PidValue $PidValue
    Write-Host "${Label}: not running"
    return
  }

  $commandLine = Get-ProcessCommandLine -PidValue $pidValue
  if ($commandLine -notmatch $CommandPattern) {
    # Never kill a process that cannot be identified. A component owned by the
    # other Windows account has no readable command line; when the endpoint
    # proves this PID is its sole owner, that component is managed inside its
    # own session (see the bridge-restart recipe), so leave it alone instead of
    # aborting the whole service operation.
    if ([string]::IsNullOrWhiteSpace($commandLine) `
        -and $PortNumber -gt 0 `
        -and (Test-PidOwnsTcpEndpoint -PidValue $pidValue -HostName $HostName -PortNumber $PortNumber)) {
      Write-Host "$Label PID $pidValue is owned by another Windows account (command line unreadable) and solely owns ${HostName}:$PortNumber; it is managed in its own session and was left untouched."
      return
    }
    throw "$Label PID $pidValue did not match the expected Cyberboss command. It was left untouched."
  }

  Write-Host "Stopping $Label process tree rooted at PID $pidValue ..."
  $gracefulTaskkill = Invoke-TaskkillProcessTree -PidValue $pidValue
  if ($null -eq $gracefulTaskkill) {
    # taskkill is expected on Windows, but retain a narrow fallback for
    # stripped-down environments.
    Stop-Process -Id $pidValue -ErrorAction SilentlyContinue
  }
  for ($attempt = 0; $attempt -lt 8; $attempt += 1) {
    if (-not (Test-PidAlive -PidValue $pidValue)) {
      Remove-PidFileIfMatches -Path $PidFile -PidValue $PidValue
      return
    }
    Start-Sleep -Milliseconds 250
  }

  $forcedTaskkill = Invoke-TaskkillProcessTree -PidValue $pidValue -Force
  if ($null -eq $forcedTaskkill) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    if (-not (Test-PidAlive -PidValue $pidValue)) {
      Remove-PidFileIfMatches -Path $PidFile -PidValue $PidValue
      return
    }
    Start-Sleep -Milliseconds 250
  }

  $taskkillDiagnostics = @($gracefulTaskkill, $forcedTaskkill) |
    Where-Object { $null -ne $_ -and [int]$_.ExitCode -ne 0 } |
    ForEach-Object {
      $detail = ([string]$_.StandardError).Trim()
      if ([string]::IsNullOrWhiteSpace($detail)) {
        $detail = ([string]$_.StandardOutput).Trim()
      }
      $detail = $detail -replace "\s+", " "
      if ($detail.Length -gt 240) { $detail = $detail.Substring(0, 240) }
      $detailSuffix = if ($detail) { ": $detail" } else { "" }
      "exit=$($_.ExitCode)$detailSuffix"
    }
  $diagnosticSuffix = if ($taskkillDiagnostics.Count -gt 0) {
    " taskkill diagnostics: $($taskkillDiagnostics -join '; ')"
  } else {
    ""
  }
  throw "$Label PID $pidValue did not stop within 5 seconds.$diagnosticSuffix"
}

function Stop-VerifiedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$CommandPattern,
    [string]$HostName = "",
    [int]$PortNumber = 0
  )

  $pidValue = Read-PidFile -Path $PidFile
  Stop-VerifiedPidValue `
    -Label $Label `
    -PidValue $pidValue `
    -PidFile $PidFile `
    -CommandPattern $CommandPattern `
    -HostName $HostName `
    -PortNumber $PortNumber
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
  $enabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  if (-not $enabled) {
    return $true
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$WeFlowUiaBaseUrl/readyz" -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Test-WeFlowUiaHealthReady {
  $enabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  if (-not $enabled) {
    return $true
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$WeFlowUiaBaseUrl/healthz" -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Test-TcpPort {
  param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][int]$PortNumber
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect($HostName, $PortNumber, $null, $null)
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

function Get-WeFlowExecutablePath {
  $configuredExe = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_EXE"
  $weFlowExe = if ($configuredExe) {
    $configuredExe
  } else {
    Join-Path $env:LOCALAPPDATA "Programs\WeFlow\WeFlow.exe"
  }
  return [IO.Path]::GetFullPath($weFlowExe)
}

function Get-WeFlowProcesses {
  $expectedPath = Get-WeFlowExecutablePath
  return @(Get-CimInstance Win32_Process | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) `
      -and [string]::Equals([IO.Path]::GetFullPath([string]$_.ExecutablePath), $expectedPath, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-TcpListenerProcessIds {
  param([Parameter(Mandatory = $true)][int]$PortNumber)

  try {
    return @(Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction Stop |
      ForEach-Object { [int]$_.OwningProcess } |
      Where-Object { $_ -gt 0 } |
      Sort-Object -Unique)
  } catch {
    throw "could not verify the owner of local TCP port ${PortNumber}: $($_.Exception.Message)"
  }
}

function Test-PidOwnsTcpEndpoint {
  param(
    [Parameter(Mandatory = $true)][int]$PidValue,
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][int]$PortNumber
  )

  if ($PidValue -le 0) { return $false }
  if (-not (Test-TcpPort -HostName $HostName -PortNumber $PortNumber)) { return $false }
  $listeners = @(Get-TcpListenerProcessIds -PortNumber $PortNumber)
  return $listeners.Count -eq 1 -and [int]$listeners[0] -eq $PidValue
}

# The bridge that drives the isolated session belongs to another Windows
# account, and a non-elevated session-1 caller cannot read its command line at
# all (measured 2026-09-22: PID 35260 came back with an empty CommandLine while
# every session-1 PID was readable). Command-line matching can therefore never
# verify that bridge, which used to abort every repair at the PID-file check
# ("points to live PID 35260 with an unexpected command") even though the
# endpoint was healthy. Endpoint ownership is the property the command-line
# match was only ever a proxy for: the recorded PID is alive and is the *sole*
# listener on the bridge port.
function Test-UiaBridgePidVerified {
  param([Parameter(Mandatory = $true)][int]$PidValue)

  if (Test-VerifiedPidAlive -PidValue $PidValue -CommandPattern $WeFlowUiaCommandPattern) {
    return $true
  }
  if (-not $WeFlowUiaEndpoint.IsLoopback) { return $false }
  return Test-PidOwnsTcpEndpoint `
    -PidValue $PidValue `
    -HostName $WeFlowUiaEndpoint.Host `
    -PortNumber $WeFlowUiaEndpoint.Port
}

function Test-WeFlowOwnsApiPort {
  if (-not $WeFlowEndpoint.IsLoopback) {
    return $false
  }
  if (-not (Test-TcpPort -HostName $WeFlowEndpoint.Host -PortNumber $WeFlowEndpoint.Port)) {
    return $false
  }

  $listenerPids = @(Get-TcpListenerProcessIds -PortNumber $WeFlowEndpoint.Port)
  if ($listenerPids.Count -eq 0) {
    return $false
  }
  $expectedPath = Get-WeFlowExecutablePath
  foreach ($listenerPid in $listenerPids) {
    $listener = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
    if ($null -eq $listener `
        -or [string]::IsNullOrWhiteSpace([string]$listener.ExecutablePath) `
        -or -not [string]::Equals([IO.Path]::GetFullPath([string]$listener.ExecutablePath), $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
  }
  return $true
}

function Invoke-WeFlowJsonProbe {
  param([Parameter(Mandatory = $true)][string]$Uri)

  $token = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_TOKEN"
  $headers = @{ Accept = "application/json" }
  if (-not [string]::IsNullOrWhiteSpace($token)) {
    $headers.Authorization = "Bearer $token"
  }
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri $Uri `
      -Headers $headers `
      -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Test-WeFlowHealthReady {
  $enabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  if (-not $enabled) {
    return $true
  }
  return Invoke-WeFlowJsonProbe -Uri "$WeFlowBaseUrl/api/v1/health"
}

function Test-WeFlowFunctionalReady {
  $enabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  if (-not $enabled) {
    return $true
  }
  $token = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_TOKEN"
  $talker = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_INBOX_CHAT"
  if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($talker)) {
    return $false
  }
  if (-not (Invoke-WeFlowJsonProbe -Uri "$WeFlowBaseUrl/api/v1/health")) {
    return $false
  }
  $nowSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $startSeconds = [Math]::Max(0, $nowSeconds - 60)
  $escapedTalker = [Uri]::EscapeDataString($talker.Trim())
  $messagesUri = "$WeFlowBaseUrl/api/v1/messages?talker=$escapedTalker&limit=1&start=$startSeconds&end=$nowSeconds"
  return Invoke-WeFlowJsonProbe -Uri $messagesUri
}

function New-WeFlowStartupState {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("disabled", "ready", "degraded")][string]$Status,
    [Parameter(Mandatory = $true)][bool]$HealthReady,
    [Parameter(Mandatory = $true)][bool]$FunctionalReady,
    [string]$Reason = ""
  )

  return [pscustomobject][ordered]@{
    Status = $Status
    HealthReady = $HealthReady
    FunctionalReady = $FunctionalReady
    Degraded = $Status -eq "degraded"
    Reason = $Reason
  }
}

function Get-ServiceStartupDisposition {
  param(
    [Parameter(Mandatory = $true)][bool]$CoreReady,
    [Parameter(Mandatory = $true)][bool]$WeFlowFunctionalReady,
    [Parameter(Mandatory = $true)][bool]$WeFlowHealthReady,
    [bool]$UiaReady = $true
  )

  if (-not $CoreReady) { return "waiting" }
  if (-not $UiaReady) { return "uia_degraded" }
  if ($WeFlowFunctionalReady) { return "healthy" }
  if ($WeFlowHealthReady) { return "degraded" }
  return "waiting"
}

function Assert-CommandAvailable {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Command)) { throw "$Label command is empty" }
  if ([IO.Path]::IsPathRooted($Command)) {
    if (-not (Test-Path -LiteralPath $Command -PathType Leaf)) {
      throw "$Label executable was not found at: $Command"
    }
    return [IO.Path]::GetFullPath($Command)
  }
  $resolved = Get-Command $Command -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $resolved) { throw "$Label command is unavailable: $Command" }
  return [string]$resolved.Source
}

function Resolve-CodexCommand {
  $configured = Get-ProjectEnvValue -Name "CYBERBOSS_CODEX_COMMAND"
  if (-not [string]::IsNullOrWhiteSpace($configured)) {
    return Assert-CommandAvailable -Command $configured -Label "Codex app-server"
  }

  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_CLI_PATH) `
      -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH -PathType Leaf)) {
    return [IO.Path]::GetFullPath($env:CODEX_CLI_PATH)
  }

  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $desktopBinRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $desktopBinRoot -PathType Container) {
      $desktopCommands = @(Get-ChildItem -LiteralPath $desktopBinRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object {
          $candidate = Join-Path $_.FullName "codex.exe"
          if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            [IO.Path]::GetFullPath($candidate)
          }
        })
      if ($desktopCommands.Count -gt 0) {
        return [string]$desktopCommands[0]
      }
    }

    $installedCommand = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe"
    if (Test-Path -LiteralPath $installedCommand -PathType Leaf) {
      return [IO.Path]::GetFullPath($installedCommand)
    }
  }

  return Assert-CommandAvailable -Command "codex.exe" -Label "Codex app-server"
}

function Assert-ServiceStartPrerequisites {
  $launcherScript = Join-Path $PSScriptRoot "shared-launch.js"
  $bridgeScript = Join-Path $ProjectRoot "bin\cyberboss.js"
  if (-not (Test-Path -LiteralPath $launcherScript -PathType Leaf)) {
    throw "Cyberboss launcher script is missing: $launcherScript"
  }
  if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) {
    throw "Cyberboss entrypoint is missing: $bridgeScript"
  }
  $null = Assert-CommandAvailable -Command "node.exe" -Label "Node.js"
  $null = Resolve-CodexCommand

  Repair-ManagedPidFiles

  $inboxEnabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  if (-not $inboxEnabled) { return }
  $token = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_TOKEN"
  $talker = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_INBOX_CHAT"
  if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($talker)) {
    throw "WeFlow inbox is enabled but CYBERBOSS_WEFLOW_TOKEN or CYBERBOSS_WEFLOW_INBOX_CHAT is missing"
  }

  if (-not $WeFlowEndpoint.IsLoopback) {
    if (-not (Test-WeFlowHealthReady)) {
      throw "external WeFlow endpoint $WeFlowBaseUrl health endpoint is unavailable; local services were left running"
    }
  } else {
    if ((Test-TcpPort -HostName $WeFlowEndpoint.Host -PortNumber $WeFlowEndpoint.Port) `
        -and -not (Test-WeFlowOwnsApiPort)) {
      throw "local WeFlow API port $($WeFlowEndpoint.Port) has an unverifiable owner; local services were left running"
    }
    $weFlowExe = Get-WeFlowExecutablePath
    if (-not (Test-Path -LiteralPath $weFlowExe -PathType Leaf)) {
      throw "WeFlow restart prerequisite is missing: $weFlowExe"
    }
    if (-not (Get-Process -Name "Weixin" -ErrorAction SilentlyContinue | Select-Object -First 1)) {
      $configuredWeixinExe = Get-ProjectEnvValue -Name "CYBERBOSS_WEIXIN_EXE"
      $weixinExe = if ($configuredWeixinExe) { $configuredWeixinExe } else { Join-Path $env:ProgramFiles "Tencent\Weixin\Weixin.exe" }
      if (-not (Test-Path -LiteralPath $weixinExe -PathType Leaf)) {
        throw "desktop WeChat is stopped and its executable is missing: $weixinExe"
      }
    }
  }

  if (-not $WeFlowUiaEndpoint.IsLoopback) {
    if (-not (Test-WeFlowUiaReady)) {
      throw "external WeFlow UIA endpoint $WeFlowUiaBaseUrl is unhealthy; local services were left running"
    }
  } else {
    $uiaScript = Join-Path $PSScriptRoot "weflow-uia-bridge.py"
    if (-not (Test-Path -LiteralPath $uiaScript -PathType Leaf)) {
      throw "WeFlow UIA bridge script is missing: $uiaScript"
    }
    $pythonCommand = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_UIA_PYTHON"
    if (-not $pythonCommand) { $pythonCommand = "python" }
    $null = Assert-CommandAvailable -Command $pythonCommand -Label "WeFlow UIA Python"
  }
}

function Ensure-WeixinStarted {
  $enabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  if (-not $enabled -or -not $WeFlowEndpoint.IsLoopback) {
    return
  }

  if (Get-Process -Name "Weixin" -ErrorAction SilentlyContinue | Select-Object -First 1) {
    return
  }

  $configuredExe = Get-ProjectEnvValue -Name "CYBERBOSS_WEIXIN_EXE"
  $weixinExe = if ($configuredExe) { $configuredExe } else { Join-Path $env:ProgramFiles "Tencent\Weixin\Weixin.exe" }
  if (-not (Test-Path -LiteralPath $weixinExe)) {
    throw "Weixin.exe is missing at $weixinExe"
  }

  Write-Host "Desktop WeChat is down; starting it ..."
  Start-Process -FilePath $weixinExe -WorkingDirectory (Split-Path -Parent $weixinExe) | Out-Null
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (Get-Process -Name "Weixin" -ErrorAction SilentlyContinue | Select-Object -First 1) {
      Write-Host "Desktop WeChat process is running."
      return
    }
  }
  throw "desktop WeChat did not start within 15 seconds"
}

function Ensure-WeFlowReady {
  $enabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  if (-not $enabled) {
    return New-WeFlowStartupState `
      -Status "disabled" `
      -HealthReady $true `
      -FunctionalReady $true
  }
  if (Test-WeFlowFunctionalReady) {
    return New-WeFlowStartupState `
      -Status "ready" `
      -HealthReady $true `
      -FunctionalReady $true
  }

  $healthReady = Test-WeFlowHealthReady
  if (-not $WeFlowEndpoint.IsLoopback) {
    if ($healthReady) {
      Write-Host "External WeFlow health is reachable but its message query is degraded; continuing with local core startup."
      return New-WeFlowStartupState `
        -Status "degraded" `
        -HealthReady $true `
        -FunctionalReady $false `
        -Reason "weflow_message_query_unavailable"
    }
    throw "external WeFlow endpoint $WeFlowBaseUrl health endpoint is unavailable; this controller will probe it but will not start or stop a remote service"
  }

  if ($healthReady) {
    if (-not (Test-WeFlowOwnsApiPort)) {
      throw "local WeFlow API health is reachable, but port $($WeFlowEndpoint.Port) has an unverifiable owner; it was left untouched"
    }
    Write-Host "WeFlow health is reachable but its message query is degraded; preserving the verified process and continuing with core startup."
    return New-WeFlowStartupState `
      -Status "degraded" `
      -HealthReady $true `
      -FunctionalReady $false `
      -Reason "weflow_message_query_unavailable"
  }

  $weFlowExe = Get-WeFlowExecutablePath
  if (-not (Test-Path -LiteralPath $weFlowExe)) {
    throw "WeFlow inbox is enabled, API port $($WeFlowEndpoint.Port) is down, and WeFlow.exe was not found at: $weFlowExe"
  }

  if (Test-TcpPort -HostName $WeFlowEndpoint.Host -PortNumber $WeFlowEndpoint.Port) {
    if (-not (Test-WeFlowOwnsApiPort)) {
      throw "local WeFlow API port $($WeFlowEndpoint.Port) is occupied by a non-WeFlow or unverifiable process; it was left untouched"
    }
    Write-Host "WeFlow API port is open but its health endpoint is unavailable; recycling the verified WeFlow process ..."
    Stop-WeFlowProcesses
  }

  Write-Host "WeFlow API is unavailable; starting WeFlow ..."
  Start-Process -FilePath $weFlowExe -WorkingDirectory (Split-Path -Parent $weFlowExe) | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    if (Test-WeFlowFunctionalReady) {
      if (-not (Test-WeFlowOwnsApiPort)) {
        throw "WeFlow readiness responded on local port $($WeFlowEndpoint.Port), but the listener owner could not be verified"
      }
      Write-Host "WeFlow health and message query are ready."
      return New-WeFlowStartupState `
        -Status "ready" `
        -HealthReady $true `
        -FunctionalReady $true
    }
    if (Test-WeFlowHealthReady) {
      if (-not (Test-WeFlowOwnsApiPort)) {
        throw "WeFlow health responded on local port $($WeFlowEndpoint.Port), but the listener owner could not be verified"
      }
      Write-Host "WeFlow health is ready but its message query is degraded; continuing with core startup."
      return New-WeFlowStartupState `
        -Status "degraded" `
        -HealthReady $true `
        -FunctionalReady $false `
        -Reason "weflow_message_query_unavailable"
    }
  } while ((Get-Date) -lt $deadline)
  throw "WeFlow started but its health endpoint did not become ready within 30 seconds. Check the WeFlow window and login state."
}

function Stop-WeFlowProcesses {
  if (-not $WeFlowEndpoint.IsLoopback) {
    Write-Host "WeFlow endpoint is external; no local WeFlow process was stopped."
    return
  }

  $portOpen = Test-TcpPort -HostName $WeFlowEndpoint.Host -PortNumber $WeFlowEndpoint.Port
  if ($portOpen -and -not (Test-WeFlowOwnsApiPort)) {
    throw "local WeFlow API port $($WeFlowEndpoint.Port) is occupied by a non-WeFlow or unverifiable process; it was left untouched"
  }

  $processes = @(Get-WeFlowProcesses)
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
    if (-not (Test-TcpPort -HostName $WeFlowEndpoint.Host -PortNumber $WeFlowEndpoint.Port)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "WeFlow API port $($WeFlowEndpoint.Port) remained open after all verified WeFlow processes were stopped."
}

function Invoke-WeFlowAnchorTornCommitRepair {
  <#
    Run the narrowly-scoped native-anchor repair only after FullRestart has
    stopped the verified local WeFlow process and confirmed that its API port
    is closed.  The Node helper is deliberately analysis-first: ordinary or
    ambiguous layouts return `not_repairable` and are left untouched; only the
    exact two-file-majority/one-registry-stale torn commit is changed.  The
    helper creates and verifies its immutable backup before writing the
    registry replica and rolls that write back on any verification failure.
  #>
  param([Parameter(Mandatory = $true)][string]$NodeCommand)

  if (-not (Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX") -or -not $WeFlowEndpoint.IsLoopback) {
    return [pscustomobject][ordered]@{ status = "skipped"; repaired = $false }
  }

  $helper = Join-Path $PSScriptRoot "weflow-anchor-torn-commit-repair.js"
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "WeFlow anchor repair helper is missing: $helper"
  }

  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $requestFile = Join-Path $StateDir "weflow-anchor-repair.$PID.request.json"
  $stdoutFile = Join-Path $StateDir "weflow-anchor-repair.$PID.out.log"
  $stderrFile = Join-Path $StateDir "weflow-anchor-repair.$PID.err.log"
  try {
    [IO.File]::WriteAllText($requestFile, "{}`r`n", [Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    # Windows PowerShell 5.1 joins ArgumentList elements into a native command
    # line; quote path arguments explicitly so project/state directories with
    # spaces survive that join intact.
    $quotedHelper = '"' + $helper + '"'
    $quotedRequestFile = '"' + $requestFile + '"'
    $process = Start-Process `
      -FilePath $NodeCommand `
      -ArgumentList @($quotedHelper, "--action", "repair", "--request-file", $quotedRequestFile) `
      -WorkingDirectory $ProjectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutFile `
      -RedirectStandardError $stderrFile `
      -Wait `
      -PassThru
    $stdoutRaw = if (Test-Path -LiteralPath $stdoutFile) { Get-Content -LiteralPath $stdoutFile -Raw } else { $null }
    $stderrRaw = if (Test-Path -LiteralPath $stderrFile) { Get-Content -LiteralPath $stderrFile -Raw } else { $null }
    $stdout = if ($null -ne $stdoutRaw) { ([string]$stdoutRaw).Trim() } else { "" }
    $stderr = if ($null -ne $stderrRaw) { ([string]$stderrRaw).Trim() } else { "" }
    if ($process.ExitCode -ne 0) {
      throw "WeFlow anchor repair helper exited $($process.ExitCode): $stderr$stdout"
    }
    if ([string]::IsNullOrWhiteSpace($stdout)) {
      throw "WeFlow anchor repair helper returned no JSON result"
    }
    $result = $stdout | ConvertFrom-Json
    if ([string]$result.action -eq "error") {
      throw "WeFlow anchor repair helper error: $([string]$result.error)"
    }
    $status = [string]$result.status
    if ($status -notin @("not_repairable", "repaired_verified")) {
      throw "WeFlow anchor repair did not complete safely: status=$status error=$([string]$result.error) rollbackVerified=$([bool]$result.rollbackVerified)"
    }
    return $result
  } finally {
    Remove-Item -LiteralPath $requestFile, $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
  }
}

function Stop-CyberbossComponents {
  $components = @(
    @{
      Label = "Bridge"
      PidFile = $BridgePidFile
      CommandPattern = $BridgeCommandPattern
    },
    @{
      Label = "App Server"
      PidFile = $AppServerPidFile
      CommandPattern = $AppServerCommandPattern
    }
  )
  if ($WeFlowUiaEndpoint.IsLoopback) {
    $components += @{
      Label = "WeFlow UIA Bridge"
      PidFile = $WeFlowUiaBridgePidFile
      CommandPattern = $WeFlowUiaCommandPattern
      HostName = $WeFlowUiaEndpoint.Host
      PortNumber = $WeFlowUiaEndpoint.Port
    }
  }
  $stopErrors = @()
  foreach ($component in $components) {
    try {
      Stop-VerifiedProcess @component
    } catch {
      $stopErrors += "$($component.Label): $($_.Exception.Message)"
    }
  }
  if ($stopErrors.Count -gt 0) {
    throw "one or more Cyberboss components did not stop cleanly: $($stopErrors -join '; ')"
  }
}

function Get-VerifiedManagedPid {
  param(
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$CommandPattern
  )

  $candidate = Read-PidFile -Path $PidFile
  if (Test-VerifiedPidAlive -PidValue $candidate -CommandPattern $CommandPattern) {
    return $candidate
  }
  return 0
}

function Format-ServiceStartupProbe {
  param($Probe)

  if ($null -eq $Probe) {
    return ""
  }
  $parts = @(
    "bridgePid=$($Probe.bridgePid)",
    "bridgeIdentity=$($Probe.bridgeIdentity)",
    "appPid=$($Probe.appServerPid)",
    "appIdentity=$($Probe.appServerIdentity)",
    "appReady=$($Probe.appServerReady)",
    "uiaPid=$($Probe.uiaPid)",
    "uiaIdentity=$($Probe.uiaIdentity)",
    "uiaHealth=$($Probe.uiaHealth)",
    "uiaReady=$($Probe.uiaReady)",
    "weflowFunctional=$($Probe.weFlowFunctional)",
    "weflowHealth=$($Probe.weFlowHealth)",
    "launcherAlive=$($Probe.launcherAlive)"
  )
  return $parts -join "; "
}

function Stop-NewCyberbossComponents {
  param(
    [Parameter(Mandatory = $true)]$Baseline,
    [int]$LauncherPid = 0
  )

  $components = @(
    @{ Label = "Bridge"; PidFile = $BridgePidFile; CommandPattern = $BridgeCommandPattern; BaselinePid = [int]$Baseline.Bridge },
    @{ Label = "App Server"; PidFile = $AppServerPidFile; CommandPattern = $AppServerCommandPattern; BaselinePid = [int]$Baseline.AppServer }
  )
  if ($WeFlowUiaEndpoint.IsLoopback) {
    $components += @{ Label = "WeFlow UIA Bridge"; PidFile = $WeFlowUiaBridgePidFile; CommandPattern = $WeFlowUiaCommandPattern; BaselinePid = [int]$Baseline.Uia; HostName = $WeFlowUiaEndpoint.Host; PortNumber = $WeFlowUiaEndpoint.Port }
  }

  $rollbackErrors = @()
  foreach ($component in $components) {
    $currentPid = Read-PidFile -Path $component.PidFile
    if ($currentPid -le 0 -or $currentPid -eq [int]$component.BaselinePid) { continue }
    try {
      Stop-VerifiedProcess `
        -Label "$($component.Label) (partial-start rollback)" `
        -PidFile $component.PidFile `
        -CommandPattern $component.CommandPattern
    } catch {
      $rollbackErrors += "$($component.Label): $($_.Exception.Message)"
    }
  }
  if (Test-PidAlive -PidValue $LauncherPid) {
    try {
      Stop-VerifiedPidValue `
        -Label "Detached launcher (partial-start rollback)" `
        -PidValue $LauncherPid `
        -CommandPattern $SharedStartCommandPattern
    } catch {
      $rollbackErrors += "Launcher: $($_.Exception.Message)"
    }
  }
  if ($rollbackErrors.Count -gt 0) {
    throw "partial startup rollback was incomplete: $($rollbackErrors -join '; ')"
  }
}

function Show-ServiceStatus {
  $bridgePid = Read-PidFile -Path $BridgePidFile
  $appServerPid = Read-PidFile -Path $AppServerPidFile
  $bridgeProcessAlive = Test-PidAlive -PidValue $bridgePid
  $appServerProcessAlive = Test-PidAlive -PidValue $appServerPid
  $bridgeAlive = Test-VerifiedPidAlive -PidValue $bridgePid -CommandPattern $BridgeCommandPattern
  $appServerAlive = Test-VerifiedPidAlive -PidValue $appServerPid -CommandPattern $AppServerCommandPattern
  $ready = Test-Ready
  $weFlowEnabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  $weFlowUiaBridgePid = Read-PidFile -Path $WeFlowUiaBridgePidFile
  $weFlowUiaBridgeAlive = Test-UiaBridgePidVerified -PidValue $weFlowUiaBridgePid
  $weFlowUiaReady = Test-WeFlowUiaReady
  $weFlowFunctionalReady = Test-WeFlowFunctionalReady
  $weFlowHealthReady = $weFlowFunctionalReady -or (Test-WeFlowHealthReady)

  Write-Host "Cyberboss status"
  Write-Host "  Bridge:     $(if ($bridgeAlive) { "running PID $bridgePid" } elseif ($bridgeProcessAlive) { "DOWN (PID $bridgePid identity mismatch)" } else { "stopped" })"
  Write-Host "  App Server: $(if ($appServerAlive) { "running PID $appServerPid" } elseif ($appServerProcessAlive) { "DOWN (PID $appServerPid identity mismatch)" } else { "stopped" })"
  Write-Host "  Readyz:     $(if ($ready) { "OK" } else { "DOWN" })"
  if ($weFlowEnabled) {
    $weFlowApiStatus = if ($weFlowFunctionalReady) {
      "OK"
    } elseif ($weFlowHealthReady) {
      "DEGRADED (health OK, message query DOWN)"
    } else {
      "DOWN"
    }
    $weFlowApiLocation = if (-not $WeFlowEndpoint.IsLoopback) { " (external)" } else { "" }
    Write-Host "  WeFlow API: $weFlowApiStatus$weFlowApiLocation"
    if ($WeFlowUiaEndpoint.IsLoopback) {
      Write-Host "  WeFlow UIA: $(if ($weFlowUiaBridgeAlive -and $weFlowUiaReady) { "running PID $weFlowUiaBridgePid" } else { "DOWN" })"
    } else {
      Write-Host "  WeFlow UIA: $(if ($weFlowUiaReady) { "OK (external)" } else { "DOWN (external)" })"
    }
  }
  $uiaHealthy = -not $weFlowEnabled `
    -or ($weFlowUiaReady -and (-not $WeFlowUiaEndpoint.IsLoopback -or $weFlowUiaBridgeAlive))
  return $bridgeAlive -and $appServerAlive -and $ready -and $weFlowFunctionalReady -and $uiaHealthy
}

function Start-CyberbossService {
  Repair-ManagedPidFiles
  $bridgePid = Read-PidFile -Path $BridgePidFile
  if (Test-PidAlive -PidValue $bridgePid) {
    if (-not (Test-VerifiedPidAlive -PidValue $bridgePid -CommandPattern $BridgeCommandPattern)) {
      throw "Cyberboss PID file points to live PID $bridgePid with an unexpected command; it was left untouched"
    }
    if (Show-ServiceStatus) {
      Write-Host "Cyberboss is already running and healthy. The singleton lock prevents a second instance."
      return [pscustomobject][ordered]@{
        Healthy = $true
        Degraded = $false
        Reason = ""
      }
    }
    throw "Cyberboss bridge PID $bridgePid is running but the overall service status is DOWN; use guarded Restart/FullRestart recovery"
  }

  Assert-ServiceStartPrerequisites
  Ensure-WeixinStarted
  $weFlowStartState = Ensure-WeFlowReady

  New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdoutLog = Join-Path $StateDir "cyberboss.service.$stamp.out.log"
  $stderrLog = Join-Path $StateDir "cyberboss.service.$stamp.err.log"
  $nodeCommand = Assert-CommandAvailable -Command "node.exe" -Label "Node.js"
  $codexCommand = Resolve-CodexCommand
  $launcherScript = Join-Path $PSScriptRoot "shared-launch.js"

  # Preserve healthy children that predated this launch attempt. Only unhealthy
  # verified or newly-created components are eligible for cleanup.
  $baselineAppServer = Get-VerifiedManagedPid -PidFile $AppServerPidFile -CommandPattern $AppServerCommandPattern
  if ($baselineAppServer -gt 0 -and -not (Test-Ready)) {
    Stop-VerifiedProcess -Label "unhealthy pre-existing App Server" -PidFile $AppServerPidFile -CommandPattern $AppServerCommandPattern
    $baselineAppServer = 0
  }
  $inboxEnabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
  $baselineUia = if ($WeFlowUiaEndpoint.IsLoopback) {
    $candidateUia = Read-PidFile -Path $WeFlowUiaBridgePidFile
    if (Test-UiaBridgePidVerified -PidValue $candidateUia) { $candidateUia } else { 0 }
  } else {
    0
  }
  if ($inboxEnabled -and $baselineUia -gt 0 -and -not (Test-WeFlowUiaReady)) {
    Stop-VerifiedProcess `
      -Label "unhealthy pre-existing WeFlow UIA Bridge" `
      -PidFile $WeFlowUiaBridgePidFile `
      -CommandPattern $WeFlowUiaCommandPattern `
      -HostName $WeFlowUiaEndpoint.Host `
      -PortNumber $WeFlowUiaEndpoint.Port
    $baselineUia = 0
  }
  $baseline = [pscustomobject]@{ Bridge = 0; AppServer = $baselineAppServer; Uia = $baselineUia }
  $launcherPid = 0
  $lastStartupProbe = $null

  try {
  Write-Host "Starting Cyberboss in the background ..."
  $hadPreviousCodexCommand = Test-Path Env:CYBERBOSS_CODEX_COMMAND
  $previousCodexCommand = $env:CYBERBOSS_CODEX_COMMAND
  $env:CYBERBOSS_CODEX_COMMAND = $codexCommand
  try {
    $launcherPidText = & $nodeCommand $launcherScript --stdout $stdoutLog --stderr $stderrLog
  } finally {
    if ($hadPreviousCodexCommand) {
      $env:CYBERBOSS_CODEX_COMMAND = $previousCodexCommand
    } else {
      Remove-Item Env:CYBERBOSS_CODEX_COMMAND -ErrorAction SilentlyContinue
    }
  }
  if ($LASTEXITCODE -ne 0 -or $launcherPidText -notmatch "^\d+$") {
    throw "Detached launcher failed: $launcherPidText"
  }
  $launcherPid = [int]$launcherPidText

  $startupDeadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 500
    $newBridgePid = Read-PidFile -Path $BridgePidFile
    $newAppServerPid = Read-PidFile -Path $AppServerPidFile
    $inboxEnabled = Test-ProjectEnvFlag -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX"
    $newUiaPid = Read-PidFile -Path $WeFlowUiaBridgePidFile
    $bridgeIdentityReady = Test-VerifiedPidAlive -PidValue $newBridgePid -CommandPattern $BridgeCommandPattern
    $appServerIdentityReady = -not $AppServerRequired `
      -or (Test-VerifiedPidAlive -PidValue $newAppServerPid -CommandPattern $AppServerCommandPattern)
    $uiaIdentityReady = -not $inboxEnabled `
      -or -not $WeFlowUiaEndpoint.IsLoopback `
      -or (Test-UiaBridgePidVerified -PidValue $newUiaPid)
    $uiaHealthReady = -not $inboxEnabled `
      -or -not $WeFlowUiaEndpoint.IsLoopback `
      -or (Test-WeFlowUiaHealthReady)
    $uiaReady = $uiaIdentityReady -and (Test-WeFlowUiaReady)
    $appServerReady = -not $AppServerRequired -or (Test-Ready)
    $coreReady = $bridgeIdentityReady `
      -and $appServerIdentityReady `
      -and $uiaHealthReady `
      -and $appServerReady
    $weFlowFunctionalReady = $false
    $weFlowHealthReady = $false
    if ($coreReady) {
      $weFlowFunctionalReady = Test-WeFlowFunctionalReady
      $weFlowHealthReady = $weFlowFunctionalReady -or (Test-WeFlowHealthReady)
    }
    $launcherAlive = Test-PidAlive -PidValue $launcherPid
    $lastStartupProbe = [pscustomobject][ordered]@{
      bridgePid = $newBridgePid
      bridgeIdentity = [bool]$bridgeIdentityReady
      appServerPid = $newAppServerPid
      appServerIdentity = [bool]$appServerIdentityReady
      appServerReady = [bool]$appServerReady
      uiaPid = $newUiaPid
      uiaIdentity = [bool]$uiaIdentityReady
      uiaHealth = [bool]$uiaHealthReady
      uiaReady = [bool]$uiaReady
      weFlowFunctional = [bool]$weFlowFunctionalReady
      weFlowHealth = [bool]$weFlowHealthReady
      launcherAlive = [bool]$launcherAlive
    }
    $startupDisposition = Get-ServiceStartupDisposition `
      -CoreReady $coreReady `
      -WeFlowFunctionalReady $weFlowFunctionalReady `
      -WeFlowHealthReady $weFlowHealthReady `
      -UiaReady $uiaReady
    if ($startupDisposition -eq "healthy") {
      Write-Host "Cyberboss started successfully."
      Write-Host "  Launcher PID: $launcherPid"
      Write-Host "  Bridge PID:   $newBridgePid"
      Write-Host "  Output log:   $stdoutLog"
      [void](Show-ServiceStatus)
      return [pscustomobject][ordered]@{
        Healthy = $true
        Degraded = $false
        Reason = ""
      }
    }
    if ($startupDisposition -eq "uia_degraded") {
      Write-Host "Cyberboss core services started, but WeFlow UIA readyz is still waiting for the logged-in main chat window."
      Write-Host "  Reason:       weflow_uia_not_ready"
      Write-Host "  Launcher PID: $launcherPid"
      Write-Host "  Bridge PID:   $newBridgePid"
      Write-Host "  Output log:   $stdoutLog"
      [void](Show-ServiceStatus)
      return [pscustomobject][ordered]@{
        Healthy = $false
        Degraded = $true
        Reason = "weflow_uia_not_ready"
      }
    }
    if ($startupDisposition -eq "degraded") {
      $degradedReason = if (-not [string]::IsNullOrWhiteSpace([string]$weFlowStartState.Reason)) {
        [string]$weFlowStartState.Reason
      } else {
        "weflow_message_query_unavailable"
      }
      Write-Host "Cyberboss core services started, but overall service health is DEGRADED."
      Write-Host "  Reason:       $degradedReason"
      Write-Host "  Launcher PID: $launcherPid"
      Write-Host "  Bridge PID:   $newBridgePid"
      Write-Host "  Output log:   $stdoutLog"
      [void](Show-ServiceStatus)
      return [pscustomobject][ordered]@{
        Healthy = $false
        Degraded = $true
        Reason = $degradedReason
      }
    }
    if (-not (Test-PidAlive -PidValue $launcherPid)) {
      break
    }
  } while ((Get-Date) -lt $startupDeadline)

  Write-Host "Cyberboss did not become ready."
  $startupProbeText = Format-ServiceStartupProbe -Probe $lastStartupProbe
  if (-not [string]::IsNullOrWhiteSpace($startupProbeText)) {
    Write-Host "  Last readiness probe: $startupProbeText"
  }
  Write-Host "  Output log: $stdoutLog"
  Write-Host "  Error log:  $stderrLog"
  if (Test-Path -LiteralPath $stdoutLog) {
    Get-Content -LiteralPath $stdoutLog -Tail 30
  }
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 30
  }
  throw "Cyberboss startup health check failed."
  } catch {
    $startFailure = $_.Exception
    try {
      Stop-NewCyberbossComponents -Baseline $baseline -LauncherPid $launcherPid
      Write-Host "Partial startup was rolled back without stopping pre-existing healthy components."
    } catch {
      throw "$($startFailure.Message) Partial startup rollback reported: $($_.Exception.Message)"
    }
    throw $startFailure
  }
}

function Assert-ServiceStartOutcome {
  param([Parameter(Mandatory = $true)]$Outcome)

  if ([bool]$Outcome.Degraded) {
    $reason = [string]$Outcome.Reason
    if ($reason -eq "weflow_uia_not_ready") {
      Write-Host "Cyberboss core services are running while WeFlow UIA readyz waits for the logged-in main chat window."
      return
    }
    if ([string]::IsNullOrWhiteSpace($reason)) {
      $reason = "unspecified_degraded_dependency"
    }
    throw "Cyberboss core services are running in DEGRADED mode; overall service health remains DOWN; reason=$reason"
  }
  if (-not [bool]$Outcome.Healthy) {
    throw "Cyberboss startup returned without a healthy or degraded outcome"
  }
}

if ($env:CYBERBOSS_SERVICE_LIBRARY_ONLY -eq "1") {
  return
}

function Invoke-ServiceControllerMode {
  param([Parameter(Mandatory = $true)][string]$RequestedMode)

  switch ($RequestedMode) {
    "Status" {
      $healthy = Show-ServiceStatus
      if (-not $healthy) {
        exit 1
      }
    }
    "Stop" {
      Repair-ManagedPidFiles
      Stop-CyberbossComponents
    }
    "Restart" {
      # Validate binaries, configuration, external dependencies, port ownership,
      # and recoverable PID metadata before disrupting a running stack.
      Assert-ServiceStartPrerequisites
      Stop-CyberbossComponents
      Start-Sleep -Seconds 1
      $startResult = Start-CyberbossService
      Assert-ServiceStartOutcome -Outcome $startResult
    }
    "FullRestart" {
      Assert-ServiceStartPrerequisites
      Stop-CyberbossComponents
      Stop-WeFlowProcesses

      $openEndpoints = @()
      if (Test-TcpPort -HostName "127.0.0.1" -PortNumber $Port) {
        $openEndpoints += "App Server=127.0.0.1:$Port"
      }
      if ($WeFlowUiaEndpoint.IsLoopback `
          -and (Test-TcpPort -HostName $WeFlowUiaEndpoint.Host -PortNumber $WeFlowUiaEndpoint.Port)) {
        $openEndpoints += "WeFlow UIA=$($WeFlowUiaEndpoint.Host):$($WeFlowUiaEndpoint.Port)"
      }
      if ($WeFlowEndpoint.IsLoopback `
          -and (Test-TcpPort -HostName $WeFlowEndpoint.Host -PortNumber $WeFlowEndpoint.Port)) {
        $openEndpoints += "WeFlow=$($WeFlowEndpoint.Host):$($WeFlowEndpoint.Port)"
      }
      if ($openEndpoints.Count -gt 0) {
        throw "Full restart stop verification failed; endpoints still open: $($openEndpoints -join ', ')"
      }
      $anchorRepair = Invoke-WeFlowAnchorTornCommitRepair `
        -NodeCommand (Assert-CommandAvailable -Command "node.exe" -Label "Node.js")
      if ([string]$anchorRepair.status -eq "repaired_verified") {
        Write-Host "WeFlow native anchor torn-commit repair verified before startup."
        Write-Host "  Backup: $([string]$anchorRepair.backupDirectory)"
      } elseif ([string]$anchorRepair.status -eq "not_repairable") {
        Write-Host "WeFlow native anchor repair: no exact torn-commit pattern was found; no state was changed."
      }
      Write-Host "All locally managed Cyberboss components are stopped; starting a clean service stack ..."
      Start-Sleep -Seconds 1
      $startResult = Start-CyberbossService
      Assert-ServiceStartOutcome -Outcome $startResult
    }
    default {
      $startResult = Start-CyberbossService
      Assert-ServiceStartOutcome -Outcome $startResult
    }
  }
}

if ($Mode -eq "Status") {
  Invoke-ServiceControllerMode -RequestedMode $Mode
} else {
  Invoke-WithServiceControllerMutex -Action {
    Invoke-ServiceControllerMode -RequestedMode $Mode
  }
}
exit 0
