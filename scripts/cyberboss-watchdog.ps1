[CmdletBinding()]
param(
  [ValidateSet("Once", "Status")]
  [string]$Mode = "Once"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProjectEnvFile = Join-Path $ProjectRoot ".env"
$ServiceScript = Join-Path $PSScriptRoot "cyberboss-service.ps1"

function Get-ProjectEnvValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue.Trim()
  }
  if (Test-Path -LiteralPath $ProjectEnvFile) {
    foreach ($line in Get-Content -LiteralPath $ProjectEnvFile) {
      if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$") {
        return $Matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
  $userEnvFile = Join-Path (Join-Path $HOME ".cyberboss") ".env"
  if (Test-Path -LiteralPath $userEnvFile) {
    foreach ($line in Get-Content -LiteralPath $userEnvFile) {
      if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$") {
        return $Matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
  return ""
}

$configuredStateDir = Get-ProjectEnvValue -Name "CYBERBOSS_STATE_DIR"
$StateDir = if ($configuredStateDir) { $configuredStateDir } else { Join-Path $HOME ".cyberboss" }
$LogDir = Join-Path $StateDir "logs"
$WatchdogLog = Join-Path $StateDir "cyberboss-watchdog.log"
$WatchdogStatus = Join-Path $StateDir "cyberboss-watchdog-status.json"
$WatchdogRecoveryState = Join-Path $StateDir "cyberboss-watchdog-recovery.json"
$BridgePidFile = Join-Path $LogDir "shared-wechat.pid"
$AppServerPidFile = Join-Path $LogDir "shared-app-server.pid"
$UiaPidFile = Join-Path $LogDir "weflow-uia-bridge.pid"
$SharedPortText = Get-ProjectEnvValue -Name "CYBERBOSS_SHARED_PORT"
$SharedPort = if ($SharedPortText -match "^\d+$") { [int]$SharedPortText } else { 8765 }
$WeFlowBaseUrl = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_BASE_URL"
if (-not $WeFlowBaseUrl) { $WeFlowBaseUrl = "http://127.0.0.1:5031" }
$UiaBaseUrl = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_BRIDGE_BASE_URL"
if (-not $UiaBaseUrl) { $UiaBaseUrl = "http://127.0.0.1:8766" }
$WeFlowToken = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_TOKEN"
$RequiredFailureConfirmations = 2
$RepairCooldownMinutes = 15
$MaxRepairsPerHour = 2
$MaxRepairsPerDay = 4

New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null

function Write-WatchdogLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  if ((Test-Path -LiteralPath $WatchdogLog) -and (Get-Item -LiteralPath $WatchdogLog).Length -gt 5MB) {
    Move-Item -LiteralPath $WatchdogLog -Destination "$WatchdogLog.1" -Force
  }
  Add-Content -LiteralPath $WatchdogLog -Value "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] $Message" -Encoding UTF8
}

function ConvertTo-UtcDateOrNull {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  try {
    return [DateTimeOffset]::Parse($Value).UtcDateTime
  } catch {
    return $null
  }
}

function Read-RecoveryState {
  $state = [ordered]@{
    consecutiveFailures = 0
    lastHealthyAt = ""
    lastRepairAttemptAt = ""
    lastSuccessfulRepairAt = ""
    repairAttempts = @()
  }
  if (-not (Test-Path -LiteralPath $WatchdogRecoveryState)) { return $state }
  try {
    $parsed = Get-Content -LiteralPath $WatchdogRecoveryState -Raw | ConvertFrom-Json
    $state.consecutiveFailures = [Math]::Max(0, [int]$parsed.consecutiveFailures)
    $state.lastHealthyAt = [string]$parsed.lastHealthyAt
    $state.lastRepairAttemptAt = [string]$parsed.lastRepairAttemptAt
    $state.lastSuccessfulRepairAt = [string]$parsed.lastSuccessfulRepairAt
    $state.repairAttempts = @($parsed.repairAttempts | ForEach-Object { [string]$_ } | Where-Object { ConvertTo-UtcDateOrNull $_ })
  } catch {
    Write-WatchdogLog "recovery state was invalid; reset counters"
  }
  return $state
}

function Save-RecoveryState {
  param([Parameter(Mandatory = $true)]$State)
  $temporary = "$WatchdogRecoveryState.tmp"
  $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $WatchdogRecoveryState -Force
}

function Get-RecoveryGate {
  param([Parameter(Mandatory = $true)]$State)

  $now = (Get-Date).ToUniversalTime()
  $attemptDates = @($State.repairAttempts | ForEach-Object { ConvertTo-UtcDateOrNull $_ } | Where-Object { $null -ne $_ } | Sort-Object)
  $hourly = @($attemptDates | Where-Object { $_ -gt $now.AddHours(-1) })
  $daily = @($attemptDates | Where-Object { $_ -gt $now.AddHours(-24) })
  $lastAttempt = ConvertTo-UtcDateOrNull ([string]$State.lastRepairAttemptAt)
  if ($daily.Count -ge $MaxRepairsPerDay) {
    return [ordered]@{
      allowed = $false
      reason = "daily_budget"
      retryAt = $daily[0].AddHours(24).ToString("o")
      repairsLastHour = $hourly.Count
      repairsLast24Hours = $daily.Count
    }
  }
  if ($hourly.Count -ge $MaxRepairsPerHour) {
    return [ordered]@{
      allowed = $false
      reason = "hourly_budget"
      retryAt = $hourly[0].AddHours(1).ToString("o")
      repairsLastHour = $hourly.Count
      repairsLast24Hours = $daily.Count
    }
  }
  if ($lastAttempt -and $now -lt $lastAttempt.AddMinutes($RepairCooldownMinutes)) {
    return [ordered]@{
      allowed = $false
      reason = "cooldown"
      retryAt = $lastAttempt.AddMinutes($RepairCooldownMinutes).ToString("o")
      repairsLastHour = $hourly.Count
      repairsLast24Hours = $daily.Count
    }
  }
  return [ordered]@{
    allowed = $true
    reason = "ready"
    retryAt = ""
    repairsLastHour = $hourly.Count
    repairsLast24Hours = $daily.Count
  }
}

function Read-PidFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $parsed = 0
  if ([int]::TryParse((Get-Content -LiteralPath $Path -Raw).Trim(), [ref]$parsed)) { return $parsed }
  return 0
}

function Test-PidAlive {
  param([int]$PidValue)
  return $PidValue -gt 0 -and $null -ne (Get-Process -Id $PidValue -ErrorAction SilentlyContinue)
}

function Invoke-JsonEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [ValidateSet("GET", "POST")][string]$Method = "GET",
    [string]$Token = "",
    [string]$Body = ""
  )

  $headers = @{}
  if ($Token) { $headers.Authorization = "Bearer $Token" }
  if ($Body) { $headers["Content-Type"] = "application/json; charset=utf-8" }
  try {
    $params = @{
      UseBasicParsing = $true
      Uri = $Uri
      Method = $Method
      Headers = $headers
      TimeoutSec = 3
    }
    if ($Body) { $params.Body = $Body }
    $response = Invoke-WebRequest @params
    $payload = if ($response.Content) { $response.Content | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{ Ok = $response.StatusCode -ge 200 -and $response.StatusCode -lt 300; Status = $response.StatusCode; Body = $payload }
  } catch {
    return [pscustomobject]@{ Ok = $false; Status = 0; Body = $null; Error = $_.Exception.Message }
  }
}

function Get-HealthSnapshot {
  $bridgePid = Read-PidFile -Path $BridgePidFile
  $appServerPid = Read-PidFile -Path $AppServerPidFile
  $uiaPid = Read-PidFile -Path $UiaPidFile
  $appReady = Invoke-JsonEndpoint -Uri "http://127.0.0.1:$SharedPort/readyz"
  $uiaProcess = Invoke-JsonEndpoint -Uri "$($UiaBaseUrl.TrimEnd('/'))/healthz"
  $uiaReady = Invoke-JsonEndpoint -Uri "$($UiaBaseUrl.TrimEnd('/'))/readyz"
  $sendSource = Invoke-JsonEndpoint -Uri "$($UiaBaseUrl.TrimEnd('/'))/api/send-source"
  $weFlow = Invoke-JsonEndpoint -Uri "$($WeFlowBaseUrl.TrimEnd('/'))/api/v1/health" -Token $WeFlowToken
  $weixinAlive = $null -ne (Get-Process -Name "Weixin" -ErrorAction SilentlyContinue | Select-Object -First 1)
  $sourceName = if ($sendSource.Ok) { [string]$sendSource.Body.send_source } else { "" }
  $healthy = (Test-PidAlive -PidValue $bridgePid) `
    -and (Test-PidAlive -PidValue $appServerPid) `
    -and (Test-PidAlive -PidValue $uiaPid) `
    -and $appReady.Ok `
    -and $uiaProcess.Ok `
    -and $uiaReady.Ok `
    -and $weFlow.Ok `
    -and $weixinAlive `
    -and $sourceName -eq "azzy"

  return [ordered]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    healthy = [bool]$healthy
    cyberboss = [ordered]@{ pid = $bridgePid; alive = [bool](Test-PidAlive -PidValue $bridgePid) }
    appServer = [ordered]@{ pid = $appServerPid; alive = [bool](Test-PidAlive -PidValue $appServerPid); ready = [bool]$appReady.Ok }
    weflow = [ordered]@{ ready = [bool]$weFlow.Ok }
    uiaBridge = [ordered]@{ pid = $uiaPid; alive = [bool](Test-PidAlive -PidValue $uiaPid); health = [bool]$uiaProcess.Ok; ready = [bool]$uiaReady.Ok }
    weixin = [ordered]@{ alive = [bool]$weixinAlive }
    sendSource = $sourceName
  }
}

function Save-Status {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [string]$Action = "none",
    [string]$Detail = "",
    $RecoveryState = $null
  )

  $guard = $null
  if ($RecoveryState) {
    $gate = Get-RecoveryGate -State $RecoveryState
    $guard = [ordered]@{
      consecutiveFailures = [int]$RecoveryState.consecutiveFailures
      requiredConfirmations = $RequiredFailureConfirmations
      cooldownMinutes = $RepairCooldownMinutes
      maxRepairsPerHour = $MaxRepairsPerHour
      maxRepairsPerDay = $MaxRepairsPerDay
      repairsLastHour = $gate.repairsLastHour
      repairsLast24Hours = $gate.repairsLast24Hours
      nextRepairAllowedAt = $gate.retryAt
    }
  }
  $payload = [ordered]@{
    checkedAt = $Snapshot.checkedAt
    healthy = $Snapshot.healthy
    action = $Action
    detail = $Detail
    guard = $guard
    components = $Snapshot
  }
  $temporary = "$WatchdogStatus.tmp"
  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $WatchdogStatus -Force
}

function Ensure-WeixinStarted {
  if (Get-Process -Name "Weixin" -ErrorAction SilentlyContinue | Select-Object -First 1) { return }
  $configuredExe = Get-ProjectEnvValue -Name "CYBERBOSS_WEIXIN_EXE"
  $weixinExe = if ($configuredExe) { $configuredExe } else { Join-Path $env:ProgramFiles "Tencent\Weixin\Weixin.exe" }
  if (-not (Test-Path -LiteralPath $weixinExe)) {
    throw "Weixin.exe is missing at $weixinExe"
  }
  Write-WatchdogLog "desktop WeChat was down; starting it"
  Start-Process -FilePath $weixinExe -WorkingDirectory (Split-Path -Parent $weixinExe) | Out-Null
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (Get-Process -Name "Weixin" -ErrorAction SilentlyContinue | Select-Object -First 1) { return }
  }
  throw "desktop WeChat did not start within 15 seconds"
}

function Ensure-AzzySource {
  $body = @{ command = "/azzy"; contact = "yourself"; notify = $false } | ConvertTo-Json -Compress
  $result = Invoke-JsonEndpoint -Uri "$($UiaBaseUrl.TrimEnd('/'))/api/command" -Method POST -Body $body
  if (-not $result.Ok -or [string]$result.Body.send_source -ne "azzy") {
    throw "UIA bridge did not persist the azzy send source"
  }
}

$mutex = New-Object Threading.Mutex($false, "Local\CyberbossHeartbeatWatchdog")
$hasMutex = $false
try {
  $hasMutex = $mutex.WaitOne(0)
  if (-not $hasMutex) {
    Write-WatchdogLog "another heartbeat check is active; this run exited"
    exit 0
  }

  $recovery = Read-RecoveryState
  $snapshot = Get-HealthSnapshot
  if ($Mode -eq "Status") {
    Save-Status -Snapshot $snapshot -RecoveryState $recovery
    $snapshot | ConvertTo-Json -Depth 8
    exit $(if ($snapshot.healthy) { 0 } else { 1 })
  }

  if ($snapshot.healthy) {
    $recovery.consecutiveFailures = 0
    $recovery.lastHealthyAt = $snapshot.checkedAt
    Save-RecoveryState -State $recovery
    Save-Status -Snapshot $snapshot -RecoveryState $recovery
    Write-WatchdogLog "heartbeat healthy"
    exit 0
  }

  $failed = @()
  if (-not $snapshot.cyberboss.alive) { $failed += "cyberboss" }
  if (-not $snapshot.appServer.ready) { $failed += "app-server" }
  if (-not $snapshot.weflow.ready) { $failed += "weflow" }
  if (-not $snapshot.uiaBridge.ready) { $failed += "uia" }
  if (-not $snapshot.weixin.alive) { $failed += "weixin" }
  if ($snapshot.sendSource -ne "azzy") { $failed += "send-source" }
  $recovery.consecutiveFailures = [Math]::Min(100, [int]$recovery.consecutiveFailures + 1)
  Save-RecoveryState -State $recovery
  if ($recovery.consecutiveFailures -lt $RequiredFailureConfirmations) {
    $detail = "components=$($failed -join ','); confirmation=$($recovery.consecutiveFailures)/$RequiredFailureConfirmations"
    Save-Status -Snapshot $snapshot -Action "observing" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "heartbeat unhealthy $detail; waiting for confirmation"
    exit 0
  }

  $gate = Get-RecoveryGate -State $recovery
  if (-not $gate.allowed) {
    $action = if ($gate.reason -eq "cooldown") { "cooldown" } else { "circuit_open" }
    $detail = "components=$($failed -join ','); reason=$($gate.reason); retryAt=$($gate.retryAt)"
    Save-Status -Snapshot $snapshot -Action $action -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "repair suppressed $detail"
    exit 2
  }

  $attemptAt = (Get-Date).ToUniversalTime().ToString("o")
  $recentAttempts = @($recovery.repairAttempts | Where-Object {
    $parsed = ConvertTo-UtcDateOrNull $_
    $parsed -and $parsed -gt (Get-Date).ToUniversalTime().AddHours(-24)
  })
  $recovery.repairAttempts = @($recentAttempts + $attemptAt)
  $recovery.lastRepairAttemptAt = $attemptAt
  Save-RecoveryState -State $recovery
  Write-WatchdogLog "heartbeat unhealthy components=$($failed -join ','); repair allowed by guard"

  Ensure-WeixinStarted
  $repairStdout = Join-Path $StateDir "cyberboss-watchdog-repair.out.log"
  $repairStderr = Join-Path $StateDir "cyberboss-watchdog-repair.err.log"
  Remove-Item -LiteralPath $repairStdout, $repairStderr -Force -ErrorAction SilentlyContinue
  $repairProcess = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ServiceScript, "-Mode", "FullRestart") `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $repairStdout `
    -RedirectStandardError $repairStderr
  if (-not $repairProcess.WaitForExit(120000)) {
    Stop-Process -Id $repairProcess.Id -Force -ErrorAction SilentlyContinue
    throw "full restart controller exceeded 120 seconds"
  }
  $repairProcess.WaitForExit()
  $repairProcess.Refresh()
  $repairExitCode = if ($null -eq $repairProcess.ExitCode) { 0 } else { [int]$repairProcess.ExitCode }
  foreach ($line in @(Get-Content -LiteralPath $repairStdout -ErrorAction SilentlyContinue)) {
    Write-WatchdogLog "repair: $line"
  }
  foreach ($line in @(Get-Content -LiteralPath $repairStderr -ErrorAction SilentlyContinue)) {
    Write-WatchdogLog "repair error: $line"
  }
  if ($repairExitCode -ne 0) {
    throw "full restart returned exit code $repairExitCode"
  }
  Ensure-AzzySource
  Start-Sleep -Seconds 3
  $repaired = Get-HealthSnapshot
  if (-not $repaired.healthy) {
    Save-Status -Snapshot $repaired -Action "repair_failed" -Detail ($failed -join ",") -RecoveryState $recovery
    Write-WatchdogLog "repair verification unhealthy"
    exit 1
  }
  $recovery.consecutiveFailures = 0
  $recovery.lastHealthyAt = $repaired.checkedAt
  $recovery.lastSuccessfulRepairAt = $repaired.checkedAt
  Save-RecoveryState -State $recovery
  Save-Status -Snapshot $repaired -Action "repaired" -Detail ($failed -join ",") -RecoveryState $recovery
  Write-WatchdogLog "repair verified healthy"
  exit 0
} catch {
  $detail = $_.Exception.Message
  $fallback = if ($snapshot) { $snapshot } else { [ordered]@{ checkedAt = (Get-Date).ToUniversalTime().ToString("o"); healthy = $false } }
  Save-Status -Snapshot $fallback -Action "error" -Detail $detail -RecoveryState $recovery
  Write-WatchdogLog "heartbeat error: $detail"
  exit 1
} finally {
  if ($hasMutex) { [void]$mutex.ReleaseMutex() }
  $mutex.Dispose()
}
