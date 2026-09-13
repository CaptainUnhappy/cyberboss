[CmdletBinding()]
param(
  [ValidateSet("Once", "Status")]
  [string]$Mode = "Once",
  [string]$DemandKey = "",
  [string]$ModelDemandKey = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProjectEnvFile = Join-Path $ProjectRoot ".env"
$ServiceScript = Join-Path $PSScriptRoot "cyberboss-service.ps1"
$CanaryScript = Join-Path $PSScriptRoot "cyberboss-watchdog-canary.js"
$ModelCanaryScript = Join-Path $PSScriptRoot "cyberboss-watchdog-model-canary.js"
$RestartNotificationScript = Join-Path $PSScriptRoot "cyberboss-watchdog-restart-notification.js"

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
$WatchdogRecoveryBackup = "$WatchdogRecoveryState.bak"
$WatchdogRecoveryJournal = Join-Path $StateDir "cyberboss-watchdog-repair-attempts.jsonl"
$WatchdogCanaryState = Join-Path $StateDir "cyberboss-watchdog-canary.json"
$WatchdogModelCanaryState = Join-Path $StateDir "cyberboss-watchdog-model-canary.json"
$RestartNotificationState = Join-Path $StateDir "cyberboss-watchdog-restart-notifications.json"
$WeFlowInboxCursor = Join-Path $StateDir "weflow-inbox-cursor.json"
$WeFlowCanaryInboxCursor = Join-Path $StateDir "weflow-canary-inbox-cursor.json"
$PendingInboundQueue = Join-Path $StateDir "pending-inbound.json"
$DeferredSystemReplies = Join-Path $StateDir "deferred-system-replies.json"
$ReplyObligations = Join-Path $StateDir "reply-obligations.json"
$WeFlowMessageLedger = Join-Path $StateDir "weflow-message-ledger.json"
$PipelineActivityFile = Join-Path $StateDir "cyberboss-pipeline-activity.json"
# Which runtime the bridge is configured to drive. The shared Codex app-server is
# only part of the stack for the codex runtime, so several health checks below are
# runtime-dependent.
$WatchdogRuntime = (Get-ProjectEnvValue -Name "CYBERBOSS_RUNTIME")
if ([string]::IsNullOrWhiteSpace($WatchdogRuntime)) { $WatchdogRuntime = "codex" }
$WatchdogRuntime = $WatchdogRuntime.Trim().ToLowerInvariant()
$RestartNotificationState = Join-Path $StateDir "cyberboss-watchdog-restart-notifications.json"
$BridgePidFile = Join-Path $LogDir "shared-wechat.pid"
$AppServerPidFile = Join-Path $LogDir "shared-app-server.pid"
$UiaPidFile = Join-Path $LogDir "weflow-uia-bridge.pid"
$SharedPortText = Get-ProjectEnvValue -Name "CYBERBOSS_SHARED_PORT"
$SharedPort = if ($SharedPortText -match "^\d+$") { [int]$SharedPortText } else { 8765 }
$BridgeCommandPattern = "(?:^|[\\/])bin[\\/]cyberboss\.js\s+start(?:\s|$)"
$AppServerCommandPattern = "(?:^|\s)app-server(?:\s|$).*--listen\s+ws://127\.0\.0\.1:$SharedPort(?:\s|$)"
$UiaCommandPattern = "weflow-uia-bridge\.py(?:\s|$)"
$WeFlowBaseUrl = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_BASE_URL"
if (-not $WeFlowBaseUrl) { $WeFlowBaseUrl = "http://127.0.0.1:5031" }
$UiaBaseUrl = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_BRIDGE_BASE_URL"
if (-not $UiaBaseUrl) { $UiaBaseUrl = "http://127.0.0.1:8766" }
$WeFlowToken = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_TOKEN"
$InboxPendingStaleSecondsText = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_INBOX_PENDING_STALE_SECONDS"
$InboxPendingStaleSeconds = if ($InboxPendingStaleSecondsText -match "^\d+$" -and [int]$InboxPendingStaleSecondsText -ge 30) {
  [int]$InboxPendingStaleSecondsText
} else {
  300
}
$OutgoingPollStaleSecondsText = Get-ProjectEnvValue -Name "CYBERBOSS_WATCHDOG_OUTGOING_POLL_STALE_SECONDS"
$OutgoingPollStaleSeconds = if ($OutgoingPollStaleSecondsText -match "^\d+$" -and [int]$OutgoingPollStaleSecondsText -ge 10) {
  [int]$OutgoingPollStaleSecondsText
} else {
  30
}
$WeFlowInboxChat = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_INBOX_CHAT"
$WeFlowInboxDisplayName = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_INBOX_DISPLAY_NAME"
if (-not $WeFlowInboxDisplayName) { $WeFlowInboxDisplayName = "yourself" }
$WeFlowCanaryChat = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_CANARY_CHAT"
$WeFlowCanaryDisplayName = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME"
$WeFlowCanaryConfigured = -not [string]::IsNullOrWhiteSpace($WeFlowCanaryChat) `
  -and -not [string]::IsNullOrWhiteSpace($WeFlowCanaryDisplayName)
$WeFlowCanaryTargetConflict = $WeFlowCanaryConfigured `
  -and -not [string]::IsNullOrWhiteSpace($WeFlowInboxChat) `
  -and $WeFlowCanaryChat.Trim() -ieq $WeFlowInboxChat.Trim()
$ModelCanaryEnabledText = Get-ProjectEnvValue -Name "CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY"
$ModelCanaryEnabled = $ModelCanaryEnabledText -match "^(?i:1|true|yes|on)$"
$CanaryCursorStartupGraceSecondsText = Get-ProjectEnvValue -Name "CYBERBOSS_WATCHDOG_CANARY_CURSOR_STARTUP_GRACE_SECONDS"
$CanaryCursorStartupGraceSeconds = if ($CanaryCursorStartupGraceSecondsText -match "^\d+$" `
  -and [int]$CanaryCursorStartupGraceSecondsText -ge 60) {
  [int]$CanaryCursorStartupGraceSecondsText
} else {
  120
}
$DurablePendingStaleSecondsText = Get-ProjectEnvValue -Name "CYBERBOSS_WATCHDOG_DURABLE_PENDING_STALE_SECONDS"
$DurablePendingStaleSeconds = if ($DurablePendingStaleSecondsText -match "^\d+$" -and [int]$DurablePendingStaleSecondsText -ge 30) {
  [int]$DurablePendingStaleSecondsText
} else {
  300
}
$MainDeliveryWindowSecondsText = Get-ProjectEnvValue -Name "CYBERBOSS_WATCHDOG_MAIN_DELIVERY_WINDOW_SECONDS"
$MainDeliveryWindowSeconds = if ($MainDeliveryWindowSecondsText -match "^\d+$" `
  -and [int]$MainDeliveryWindowSecondsText -ge 60) {
  [int]$MainDeliveryWindowSecondsText
} else {
  600
}
$RequiredFailureConfirmations = 2
$RepairCooldownMinutes = 15
$MaxRepairsPerHour = 2
$MaxRepairsPerDay = 4
$FailureConfirmationWindowMinutesText = Get-ProjectEnvValue -Name "CYBERBOSS_WATCHDOG_CONFIRMATION_WINDOW_MINUTES"
$FailureConfirmationWindowMinutes = if ($FailureConfirmationWindowMinutesText -match "^\d+$" -and [int]$FailureConfirmationWindowMinutesText -ge 15) {
  [int]$FailureConfirmationWindowMinutesText
} else {
  # The installed heartbeat runs every three hours. Four hours keeps two
  # adjacent observations eligible while preventing an old, unrelated fault
  # from donating its confirmation count to a new incident.
  240
}
$SameFaultRetryHoursText = Get-ProjectEnvValue -Name "CYBERBOSS_WATCHDOG_SAME_FAULT_RETRY_HOURS"
$SameFaultRetryHours = if ($SameFaultRetryHoursText -match "^\d+$" -and [int]$SameFaultRetryHoursText -ge 1) {
  [int]$SameFaultRetryHoursText
} else {
  6
}
$CanaryUserQuietSeconds = 300
$CanaryDeferredActions = @(
  "already_running",
  "budget_wait",
  "demand_already_handled",
  "demand_blocked",
  "deferred_busy",
  "not_due",
  "obligation_wait",
  "target_changed_pending",
  "target_verification_budget_wait",
  "urgent_budget_wait",
  "waiting_retry"
)
$CanaryUnknownHealthActions = @("target_changed_pending", "target_verification_budget_wait")
$ModelCanaryDeferredActions = @(
  "already_running",
  "budget_wait",
  "demand_already_handled",
  "deferred_busy",
  "not_due",
  "obligation_wait",
  "target_changed_pending"
)
$CanaryDesktopQuietSecondsText = Get-ProjectEnvValue -Name "CYBERBOSS_WATCHDOG_DESKTOP_IDLE_SECONDS"
$CanaryDesktopQuietSeconds = if ($CanaryDesktopQuietSecondsText -match "^\d+$") {
  [Math]::Max(300, [int]$CanaryDesktopQuietSecondsText)
} else {
  300
}
$ExplicitDemandKey = if ([string]::IsNullOrWhiteSpace($DemandKey)) { "" } else { $DemandKey.Trim() }
$ExplicitModelDemandKey = if ([string]::IsNullOrWhiteSpace($ModelDemandKey)) { "" } else { $ModelDemandKey.Trim() }
if ($ExplicitDemandKey.Length -gt 512) {
  throw "watchdog demand key must not exceed 512 characters"
}
if ($ExplicitModelDemandKey.Length -gt 512) {
  throw "watchdog model demand key must not exceed 512 characters"
}
if ($Mode -eq "Status" -and ($ExplicitDemandKey -or $ExplicitModelDemandKey)) {
  throw "watchdog demand keys are only valid in Once mode"
}

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

function New-RecoveryState {
  return [ordered]@{
    recoveryStateValid = $true
    recoveryStateSource = "default"
    recoveryStateError = ""
    consecutiveFailures = 0
    failureFingerprint = ""
    failureCount = 0
    failureFirstSeenAt = ""
    failureLastSeenAt = ""
    lastHealthyAt = ""
    lastRepairAttemptAt = ""
    lastSuccessfulRepairAt = ""
    repairAttempts = @()
    lastRepairFailureFingerprint = ""
    lastRepairMode = ""
    lastRepairOutcome = "never"
    ineffectiveRepairCount = 0
    currentRepairIdentity = ""
    lastCanaryAttemptAt = ""
    lastCanarySuccessAt = ""
    lastCanaryFailureAt = ""
    lastCanaryRunId = ""
    lastCanaryStatus = "never"
    lastCanaryError = ""
    canaryConsecutiveFailures = 0
    pendingRepairVerification = $false
    pendingRepairVerificationAt = ""
    pendingRepairVerificationIdentity = ""
    lastVerificationCheckAt = ""
  }
}

function Import-RecoveryPayload {
  param(
    [Parameter(Mandatory = $true)]$Parsed,
    [Parameter(Mandatory = $true)]$State
  )

  if ($null -eq $Parsed -or $null -eq $Parsed.PSObject.Properties["repairAttempts"]) {
    throw "recovery state schema was invalid"
  }
  if ($null -ne $Parsed.PSObject.Properties["recoveryStateValid"]) {
    $State.recoveryStateValid = [bool]$Parsed.recoveryStateValid
  }
  if ($null -ne $Parsed.PSObject.Properties["recoveryStateError"]) {
    $State.recoveryStateError = [string]$Parsed.recoveryStateError
  }
  $State.consecutiveFailures = [Math]::Max(0, [int]$Parsed.consecutiveFailures)
  $State.failureFingerprint = [string]$Parsed.failureFingerprint
  $State.failureCount = [Math]::Max(0, [int]$Parsed.failureCount)
  $State.failureFirstSeenAt = [string]$Parsed.failureFirstSeenAt
  $State.failureLastSeenAt = [string]$Parsed.failureLastSeenAt
  $State.lastHealthyAt = [string]$Parsed.lastHealthyAt
  $State.lastRepairAttemptAt = [string]$Parsed.lastRepairAttemptAt
  $State.lastSuccessfulRepairAt = [string]$Parsed.lastSuccessfulRepairAt
  $State.repairAttempts = @($Parsed.repairAttempts | ForEach-Object { [string]$_ } | Where-Object { ConvertTo-UtcDateOrNull $_ })
  $State.lastRepairFailureFingerprint = [string]$Parsed.lastRepairFailureFingerprint
  $State.lastRepairMode = [string]$Parsed.lastRepairMode
  $State.lastRepairOutcome = if ([string]::IsNullOrWhiteSpace([string]$Parsed.lastRepairOutcome)) { "never" } else { [string]$Parsed.lastRepairOutcome }
  $State.ineffectiveRepairCount = [Math]::Max(0, [int]$Parsed.ineffectiveRepairCount)
  $State.currentRepairIdentity = [string]$Parsed.currentRepairIdentity
  $State.lastCanaryAttemptAt = [string]$Parsed.lastCanaryAttemptAt
  $State.lastCanarySuccessAt = [string]$Parsed.lastCanarySuccessAt
  $State.lastCanaryFailureAt = [string]$Parsed.lastCanaryFailureAt
  $State.lastCanaryRunId = [string]$Parsed.lastCanaryRunId
  $State.lastCanaryStatus = if ([string]::IsNullOrWhiteSpace([string]$Parsed.lastCanaryStatus)) { "never" } else { [string]$Parsed.lastCanaryStatus }
  $State.lastCanaryError = [string]$Parsed.lastCanaryError
  $State.canaryConsecutiveFailures = [Math]::Max(0, [int]$Parsed.canaryConsecutiveFailures)
  $State.pendingRepairVerification = [bool]$Parsed.pendingRepairVerification
  $State.pendingRepairVerificationAt = [string]$Parsed.pendingRepairVerificationAt
  $State.pendingRepairVerificationIdentity = [string]$Parsed.pendingRepairVerificationIdentity
  $State.lastVerificationCheckAt = [string]$Parsed.lastVerificationCheckAt
  return $State
}

function Get-JournalRepairEntries {
  $entries = @()
  if (-not (Test-Path -LiteralPath $WatchdogRecoveryJournal)) { return $entries }
  foreach ($line in @(Get-Content -LiteralPath $WatchdogRecoveryJournal -ErrorAction SilentlyContinue)) {
    if ([string]::IsNullOrWhiteSpace([string]$line)) { continue }
    try {
      $entry = $line | ConvertFrom-Json
      $attemptAt = [string]$entry.at
      if (ConvertTo-UtcDateOrNull $attemptAt) {
        $entries += [pscustomobject]@{
          at = $attemptAt
          fingerprint = [string]$entry.fingerprint
          mode = [string]$entry.mode
          identity = [string]$entry.identity
        }
      }
    } catch {
      # A torn final JSONL record must not hide the earlier durable budget.
    }
  }
  return @($entries | Sort-Object { ConvertTo-UtcDateOrNull ([string]$_.at) })
}

function Get-JournalRepairAttempts {
  return @(Get-JournalRepairEntries | ForEach-Object { [string]$_.at } | Select-Object -Unique)
}

function Merge-RecoveryJournal {
  param([Parameter(Mandatory = $true)]$State)

  $journalEntries = @(Get-JournalRepairEntries)
  if ($journalEntries.Count -eq 0) { return $State }
  $mergedAttempts = @($State.repairAttempts + @($journalEntries | ForEach-Object { [string]$_.at }) |
    Where-Object { ConvertTo-UtcDateOrNull ([string]$_) } |
    Sort-Object -Unique)
  $State.repairAttempts = $mergedAttempts
  $latestEntry = @($journalEntries | Select-Object -Last 1)[0]
  $persistedLast = ConvertTo-UtcDateOrNull ([string]$State.lastRepairAttemptAt)
  $journalLast = ConvertTo-UtcDateOrNull ([string]$latestEntry.at)
  if ($null -eq $persistedLast -or $journalLast -gt $persistedLast) {
    $State.lastRepairAttemptAt = [string]$latestEntry.at
    $State.lastRepairFailureFingerprint = [string]$latestEntry.fingerprint
    $State.lastRepairMode = [string]$latestEntry.mode
    $State.lastRepairOutcome = "started"
    $State.currentRepairIdentity = if ([string]$latestEntry.identity) { [string]$latestEntry.identity } else { [string]$latestEntry.at }
    if ([string]$State.recoveryStateSource -notmatch "journal") {
      $State.recoveryStateSource = if ([string]$State.recoveryStateSource -in @("", "default", "fresh")) { "journal" } else { "$($State.recoveryStateSource)+journal" }
    }
  }
  return $State
}

function Read-RecoveryState {
  $state = New-RecoveryState
  $candidates = @($WatchdogRecoveryState, $WatchdogRecoveryBackup)
  $persistedStateSeen = $false
  $errors = @()
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $persistedStateSeen = $true
    try {
      $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
      $parsed = [System.IO.File]::ReadAllText($candidate, $strictUtf8) | ConvertFrom-Json
      $state = Import-RecoveryPayload -Parsed $parsed -State (New-RecoveryState)
      $state.recoveryStateSource = if ($candidate -ceq $WatchdogRecoveryState) { "primary" } else { "backup" }
      if ($candidate -ceq $WatchdogRecoveryBackup) {
        $state.recoveryStateError = "primary_invalid_recovered_from_backup"
        Write-WatchdogLog "recovery state primary was invalid; recovered guard counters from backup"
      }
      # The append-only journal is written before an operation begins. Merge it
      # even when the JSON is valid so a crash between journal append and JSON
      # replacement cannot mint another repair attempt.
      return (Merge-RecoveryJournal -State $state)
    } catch {
      $errors += "$(Split-Path -Leaf $candidate): $($_.Exception.Message)"
    }
  }
  if (-not $persistedStateSeen) {
    # The append-only journal is authoritative for budget accounting even when
    # both JSON snapshots were deleted between scheduler runs.
    return (Merge-RecoveryJournal -State $state)
  }

  $journalEntries = @(Get-JournalRepairEntries)
  if ($journalEntries.Count -gt 0) {
    $state = Merge-RecoveryJournal -State $state
    $state.recoveryStateError = "json_state_invalid_recovered_budget_from_journal"
    Write-WatchdogLog "recovery state JSON was invalid; reconstructed repair budget from append-only journal"
    return $state
  }

  # Failing closed is intentional: corrupting the state file must never mint a
  # fresh set of restart attempts.
  $state.recoveryStateValid = $false
  $state.recoveryStateSource = "invalid"
  $state.recoveryStateError = ($errors -join "; ")
  Write-WatchdogLog "recovery state and backup were invalid; repair circuit failed closed"
  return $state
}

function Add-RecoveryRepairAttemptJournal {
  param(
    [Parameter(Mandatory = $true)][string]$AttemptAt,
    [Parameter(Mandatory = $true)][string]$Fingerprint,
    [Parameter(Mandatory = $true)][string]$RepairMode,
    [Parameter(Mandatory = $true)][string]$RepairIdentity
  )

  $entry = [ordered]@{
    at = $AttemptAt
    fingerprint = $Fingerprint
    mode = $RepairMode
    identity = $RepairIdentity
  }
  Add-Content -LiteralPath $WatchdogRecoveryJournal -Value ($entry | ConvertTo-Json -Compress) -Encoding UTF8
}

function Save-RecoveryState {
  param([Parameter(Mandatory = $true)]$State)
  $temporary = "$WatchdogRecoveryState.tmp"
  $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
  # Validate the temporary before replacing the primary. The backup remains a
  # known-good copy even if the host is terminated during the final rename.
  $null = Get-Content -LiteralPath $temporary -Raw | ConvertFrom-Json
  if (Test-Path -LiteralPath $WatchdogRecoveryState) {
    try {
      $null = Get-Content -LiteralPath $WatchdogRecoveryState -Raw | ConvertFrom-Json
      Copy-Item -LiteralPath $WatchdogRecoveryState -Destination $WatchdogRecoveryBackup -Force
    } catch {
      # Preserve an existing known-good backup rather than copying corruption.
    }
  }
  Move-Item -LiteralPath $temporary -Destination $WatchdogRecoveryState -Force
  Copy-Item -LiteralPath $WatchdogRecoveryState -Destination $WatchdogRecoveryBackup -Force
}

function Get-RecoveryGate {
  param([Parameter(Mandatory = $true)]$State)

  $now = (Get-Date).ToUniversalTime()
  $attemptDates = @($State.repairAttempts | ForEach-Object { ConvertTo-UtcDateOrNull $_ } | Where-Object { $null -ne $_ } | Sort-Object)
  $hourly = @($attemptDates | Where-Object { $_ -gt $now.AddHours(-1) })
  $daily = @($attemptDates | Where-Object { $_ -gt $now.AddHours(-24) })
  $lastAttempt = ConvertTo-UtcDateOrNull ([string]$State.lastRepairAttemptAt)
  $hasRecoveryValidity = if ($State -is [System.Collections.IDictionary]) {
    $State.Contains("recoveryStateValid")
  } else {
    $null -ne $State.PSObject.Properties["recoveryStateValid"]
  }
  $recoveryValidity = if ($hasRecoveryValidity) {
    if ($State -is [System.Collections.IDictionary]) { [bool]$State["recoveryStateValid"] } else { [bool]$State.recoveryStateValid }
  } else {
    $true
  }
  if (-not $recoveryValidity) {
    return [ordered]@{
      allowed = $false
      reason = "recovery_state_invalid"
      constraints = @("recovery_state_invalid")
      retryAt = ""
      repairsLastHour = $hourly.Count
      repairsLast24Hours = $daily.Count
    }
  }

  $constraints = @()
  if ($daily.Count -ge $MaxRepairsPerDay) {
    $constraints += [pscustomobject]@{ reason = "daily_budget"; retryAt = $daily[0].AddHours(24) }
  }
  if ($hourly.Count -ge $MaxRepairsPerHour) {
    $constraints += [pscustomobject]@{ reason = "hourly_budget"; retryAt = $hourly[0].AddHours(1) }
  }
  if ($lastAttempt -and $now -lt $lastAttempt.AddMinutes($RepairCooldownMinutes)) {
    $constraints += [pscustomobject]@{ reason = "cooldown"; retryAt = $lastAttempt.AddMinutes($RepairCooldownMinutes) }
  }
  if ($constraints.Count -gt 0) {
    # Multiple guards can be active simultaneously. Reporting the latest
    # deadline prevents a caller from retrying at a time when another guard is
    # still open.
    $limiting = @($constraints | Sort-Object -Property retryAt | Select-Object -Last 1)[0]
    return [ordered]@{
      allowed = $false
      reason = [string]$limiting.reason
      constraints = @($constraints | ForEach-Object { [string]$_.reason })
      retryAt = $limiting.retryAt.ToString("o")
      repairsLastHour = $hourly.Count
      repairsLast24Hours = $daily.Count
    }
  }
  return [ordered]@{
    allowed = $true
    reason = "ready"
    constraints = @()
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

function Get-ProcessCommandLine {
  param([int]$PidValue)
  if ($PidValue -le 0) { return "" }
  try {
    return [string](Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue" -ErrorAction Stop).CommandLine
  } catch {
    return ""
  }
}

function Test-VerifiedPidAlive {
  param(
    [int]$PidValue,
    [Parameter(Mandatory = $true)][string]$CommandPattern
  )
  if (-not (Test-PidAlive -PidValue $PidValue)) { return $false }
  $commandLine = Get-ProcessCommandLine -PidValue $PidValue
  return -not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -match $CommandPattern
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
    return [pscustomobject]@{ Ok = $response.StatusCode -ge 200 -and $response.StatusCode -lt 300; Status = [int]$response.StatusCode; Body = $payload; Error = "" }
  } catch {
    $statusCode = 0
    $errorBody = $null
    try {
      if ($null -ne $_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $rawError = $reader.ReadToEnd()
          $reader.Dispose()
          if (-not [string]::IsNullOrWhiteSpace($rawError)) {
            try { $errorBody = $rawError | ConvertFrom-Json } catch { $errorBody = $rawError }
          }
        }
      }
    } catch {
      # Preserve pass-through diagnostics must never mask the original request.
    }
    return [pscustomobject]@{ Ok = $false; Status = $statusCode; Body = $errorBody; Error = $_.Exception.Message }
  }
}

function Get-WeFlowFunctionalHealth {
  $result = [ordered]@{
    ready = $false
    healthReady = $false
    messagesReady = $false
    healthStatus = 0
    messagesStatus = 0
    reason = ""
    error = ""
  }
  $health = Invoke-JsonEndpoint -Uri "$($WeFlowBaseUrl.TrimEnd('/'))/api/v1/health" -Token $WeFlowToken
  $result.healthReady = [bool]$health.Ok
  $result.healthStatus = [int]$health.Status
  if (-not $health.Ok) {
    $result.reason = if ($health.Status) { "health_http_$($health.Status)" } else { "health_unreachable" }
    $result.error = [string]$health.Error
    return $result
  }

  $inboxEnabled = (Get-ProjectEnvValue -Name "CYBERBOSS_ENABLE_WEFLOW_INBOX") -match "^(?i:1|true|yes|on)$"
  if (-not $inboxEnabled) {
    $result.messagesReady = $true
    $result.ready = $true
    return $result
  }
  if ([string]::IsNullOrWhiteSpace($WeFlowToken) -or [string]::IsNullOrWhiteSpace($WeFlowInboxChat)) {
    $result.reason = "message_probe_configuration_missing"
    return $result
  }

  $nowSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $startSeconds = [Math]::Max(0, $nowSeconds - 60)
  $talker = [Uri]::EscapeDataString($WeFlowInboxChat.Trim())
  $messagesUri = "$($WeFlowBaseUrl.TrimEnd('/'))/api/v1/messages?talker=$talker&limit=1&start=$startSeconds&end=$nowSeconds"
  $messages = Invoke-JsonEndpoint -Uri $messagesUri -Token $WeFlowToken
  $result.messagesReady = [bool]$messages.Ok
  $result.messagesStatus = [int]$messages.Status
  if (-not $messages.Ok) {
    $result.reason = if ($messages.Status) { "messages_http_$($messages.Status)" } else { "messages_unreachable" }
    $result.error = [string]$messages.Error
    return $result
  }
  $result.ready = $true
  return $result
}

function Get-InboxQueueHealth {
  param(
    [string]$Path = $WeFlowInboxCursor,
    [int]$StaleAfterSeconds = $InboxPendingStaleSeconds,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
    [switch]$Lightweight,
    [string]$ExpectedTalker = ""
  )

  $threshold = [Math]::Max(1, $StaleAfterSeconds)
  $result = [ordered]@{
    healthy = $true
    pendingCount = 0
    oldestAge = $null
    oldestAgeSeconds = $null
    oldestKey = ""
    staleAfterSeconds = $threshold
    cursorPresent = $false
    reason = ""
    outgoingPoll = [ordered]@{
      ready = $false
      healthy = $true
      lagSeconds = $null
      cursorAgeSeconds = $null
      staleAfterSeconds = $OutgoingPollStaleSeconds
      polledThrough = 0
      backfillActive = $false
      stallAttempt = 0
      retryNotBefore = ""
      reason = "not_initialized"
    }
  }
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    return $result
  }

  $result.cursorPresent = $true
  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $cursorText = [System.IO.File]::ReadAllText($Path, $strictUtf8)
    $cursor = $cursorText | ConvertFrom-Json
    if ($null -eq $cursor) { throw "cursor JSON was empty" }
  } catch {
    $result.healthy = $false
    $result.reason = "cursor_invalid"
    return $result
  }

  $cursorAgeSeconds = [Math]::Max(0, [Math]::Floor(($Now.UtcDateTime - (Get-Item -LiteralPath $Path).LastWriteTimeUtc).TotalSeconds))
  $result.outgoingPoll.cursorAgeSeconds = [long]$cursorAgeSeconds

  if ($Lightweight) {
    $talker = ([string]$cursor.talker).Trim()
    $expected = ([string]$ExpectedTalker).Trim()
    $hasSeenIdentities = $null -ne $cursor.PSObject.Properties["seenIdentities"] `
      -and $cursor.seenIdentities -is [System.Array]
    if ([string]::IsNullOrWhiteSpace($talker) -or -not $hasSeenIdentities) {
      $result.healthy = $false
      $result.reason = "cursor_invalid"
      $result.outgoingPoll.healthy = $false
      $result.outgoingPoll.reason = "cursor_invalid"
      return $result
    }
    if ($expected -and $talker -cne $expected) {
      $result.healthy = $false
      $result.reason = "cursor_target_mismatch"
      $result.outgoingPoll.healthy = $false
      $result.outgoingPoll.reason = "cursor_target_mismatch"
      return $result
    }

    $lastPolled = [DateTimeOffset]::MinValue
    $hasLastPolled = [DateTimeOffset]::TryParse([string]$cursor.lastPolledAt, [ref]$lastPolled)
    $pollLagSeconds = if ($hasLastPolled) {
      [Math]::Max(0, [Math]::Floor(($Now.ToUniversalTime() - $lastPolled.ToUniversalTime()).TotalSeconds))
    } else {
      $cursorAgeSeconds
    }
    $result.outgoingPoll.ready = $true
    $result.outgoingPoll.lagSeconds = [long]$pollLagSeconds
    $result.outgoingPoll.polledThrough = if ($hasLastPolled) { $lastPolled.ToUnixTimeSeconds() } else { 0 }
    $result.outgoingPoll.healthy = $pollLagSeconds -le $OutgoingPollStaleSeconds `
      -and $cursorAgeSeconds -le $OutgoingPollStaleSeconds
    $result.outgoingPoll.reason = if ($result.outgoingPoll.healthy) { "" } else { "outgoing_poll_stale" }
    if (-not $result.outgoingPoll.healthy) {
      $result.healthy = $false
      $result.reason = $result.outgoingPoll.reason
    }
    return $result
  }

  $poll = $cursor.outgoingPollCursor
  $polledThrough = 0L
  if ($null -ne $poll -and [long]::TryParse([string]$poll.polledThrough, [ref]$polledThrough) -and $polledThrough -gt 0) {
    $lagSeconds = [Math]::Max(0, [Math]::Floor(($Now.ToUniversalTime() - [DateTimeOffset]::FromUnixTimeSeconds($polledThrough)).TotalSeconds))
    $result.outgoingPoll.ready = $true
    $result.outgoingPoll.lagSeconds = [long]$lagSeconds
    $result.outgoingPoll.polledThrough = $polledThrough
    $result.outgoingPoll.backfillActive = [bool]$poll.backfillActive
    $result.outgoingPoll.stallAttempt = [Math]::Max(0, [int]$poll.stallAttempt)
    $result.outgoingPoll.retryNotBefore = [string]$poll.retryNotBefore
    $result.outgoingPoll.healthy = if ($result.outgoingPoll.backfillActive) {
      $cursorAgeSeconds -le $OutgoingPollStaleSeconds -and $result.outgoingPoll.stallAttempt -lt 3
    } else {
      $lagSeconds -le $OutgoingPollStaleSeconds -and $cursorAgeSeconds -le $OutgoingPollStaleSeconds
    }
    $result.outgoingPoll.reason = if ($result.outgoingPoll.healthy) {
      ""
    } elseif ($result.outgoingPoll.backfillActive -and $result.outgoingPoll.stallAttempt -ge 3) {
      "outgoing_poll_stalled"
    } else {
      "outgoing_poll_stale"
    }
    if (-not $result.outgoingPoll.healthy) {
      $result.healthy = $false
      $result.reason = $result.outgoingPoll.reason
    }
  } else {
    $result.outgoingPoll.reason = if ($cursorAgeSeconds -le $OutgoingPollStaleSeconds) { "initializing" } else { "outgoing_poll_missing" }
    if ($cursorAgeSeconds -gt $OutgoingPollStaleSeconds) {
      $result.outgoingPoll.healthy = $false
      $result.healthy = $false
      $result.reason = "outgoing_poll_missing"
    }
  }

  $pending = @($cursor.pendingEvents | Where-Object { $null -ne $_ })
  $result.pendingCount = $pending.Count
  if ($pending.Count -eq 0) { return $result }

  $oldestAt = $null
  $oldestKey = ""
  foreach ($item in $pending) {
    $eventAt = $null
    $rawTimestamp = if ($null -ne $item.push) {
      if ($null -ne $item.push.timestamp) { $item.push.timestamp } else { $item.push.createTime }
    } else {
      $null
    }
    $epoch = 0L
    if ($null -ne $rawTimestamp -and [long]::TryParse([string]$rawTimestamp, [ref]$epoch) -and $epoch -gt 0) {
      try {
        $eventAt = if ($epoch -gt 999999999999) {
          [DateTimeOffset]::FromUnixTimeMilliseconds($epoch)
        } else {
          [DateTimeOffset]::FromUnixTimeSeconds($epoch)
        }
      } catch {
        $eventAt = $null
      }
    }
    if ($null -eq $eventAt) {
      foreach ($candidate in @($item.createdAt, $item.push.receivedAt)) {
        if ([string]::IsNullOrWhiteSpace([string]$candidate)) { continue }
        $parsed = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse([string]$candidate, [ref]$parsed)) {
          $eventAt = $parsed
          break
        }
      }
    }
    if ($null -ne $eventAt -and ($null -eq $oldestAt -or $eventAt -lt $oldestAt)) {
      $oldestAt = $eventAt
      $oldestKey = [string]$item.key
    }
  }

  if ($null -eq $oldestAt) {
    $result.oldestKey = [string]$pending[0].key
    $result.healthy = $false
    $result.reason = "pending_timestamp_missing"
    return $result
  }

  $ageSeconds = [Math]::Max(0, [Math]::Floor(($Now.ToUniversalTime() - $oldestAt.ToUniversalTime()).TotalSeconds))
  $result.oldestAge = [long]$ageSeconds
  $result.oldestAgeSeconds = [long]$ageSeconds
  $result.oldestKey = $oldestKey
  if ($ageSeconds -gt $threshold) {
    $result.healthy = $false
    $result.reason = "stale_pending_event"
  }
  return $result
}

function Set-InboxCursorMissingPolicy {
  param(
    [Parameter(Mandatory = $true)]$Health,
    [bool]$Required = $true,
    [bool]$ServiceAlive = $false,
    [double]$ServiceUptimeSeconds = -1,
    [int]$StartupGraceSeconds = $OutgoingPollStaleSeconds,
    [string]$QueueName = "main"
  )

  $Health.configured = [bool]$Required
  $Health.queueName = $QueueName
  if (-not $Required) {
    $Health.healthy = $true
    $Health.reason = "disabled"
    $Health.outgoingPoll.healthy = $true
    $Health.outgoingPoll.ready = $false
    $Health.outgoingPoll.reason = "disabled"
    return $Health
  }
  if ($Health.cursorPresent) { return $Health }

  $grace = [Math]::Max(1, $StartupGraceSeconds)
  if (-not $ServiceAlive) {
    $Health.reason = "waiting_for_service"
    $Health.outgoingPoll.reason = "waiting_for_service"
    return $Health
  }
  if ($ServiceUptimeSeconds -lt 0 -or $ServiceUptimeSeconds -le $grace) {
    $Health.reason = "initializing"
    $Health.outgoingPoll.reason = "initializing"
    return $Health
  }

  $Health.healthy = $false
  $Health.reason = "cursor_missing"
  $Health.outgoingPoll.healthy = $false
  $Health.outgoingPoll.reason = "cursor_missing"
  return $Health
}

function Get-CombinedInboxQueueHealth {
  param(
    [string]$MainPath = $WeFlowInboxCursor,
    [string]$CanaryPath = $WeFlowCanaryInboxCursor,
    [bool]$CanaryConfigured = $WeFlowCanaryConfigured,
    [string]$ExpectedCanaryTalker = $WeFlowCanaryChat,
    [bool]$ServiceAlive = $false,
    [double]$ServiceUptimeSeconds = -1,
    [int]$StaleAfterSeconds = $InboxPendingStaleSeconds,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )

  $main = Get-InboxQueueHealth -Path $MainPath -StaleAfterSeconds $StaleAfterSeconds -Now $Now
  $main = Set-InboxCursorMissingPolicy `
    -Health $main `
    -Required $true `
    -ServiceAlive $ServiceAlive `
    -ServiceUptimeSeconds $ServiceUptimeSeconds `
    -StartupGraceSeconds $OutgoingPollStaleSeconds `
    -QueueName "main"

  $canary = Get-InboxQueueHealth `
    -Path $CanaryPath `
    -StaleAfterSeconds $StaleAfterSeconds `
    -Now $Now `
    -Lightweight `
    -ExpectedTalker $ExpectedCanaryTalker
  $canary = Set-InboxCursorMissingPolicy `
    -Health $canary `
    -Required $CanaryConfigured `
    -ServiceAlive $ServiceAlive `
    -ServiceUptimeSeconds $ServiceUptimeSeconds `
    -StartupGraceSeconds $CanaryCursorStartupGraceSeconds `
    -QueueName "canary"

  $mainView = [pscustomobject]$main
  $canaryView = [pscustomobject]$canary
  $requiredQueues = @($mainView)
  if ($CanaryConfigured) { $requiredQueues += $canaryView }
  $pendingCount = [int](($requiredQueues | Measure-Object -Property pendingCount -Sum).Sum)
  $oldest = @($requiredQueues | Where-Object { $null -ne $_.oldestAgeSeconds } | Sort-Object -Property @{ Expression = { [long]$_.oldestAgeSeconds }; Descending = $true }) | Select-Object -First 1
  $lagValues = @($requiredQueues | ForEach-Object { $_.outgoingPoll.lagSeconds } | Where-Object { $null -ne $_ })
  $cursorAgeValues = @($requiredQueues | ForEach-Object { $_.outgoingPoll.cursorAgeSeconds } | Where-Object { $null -ne $_ })
  $pollReady = @($requiredQueues | Where-Object { -not [bool]$_.outgoingPoll.ready }).Count -eq 0
  $pollHealthy = @($requiredQueues | Where-Object { -not [bool]$_.outgoingPoll.healthy }).Count -eq 0
  $healthy = @($requiredQueues | Where-Object { -not [bool]$_.healthy }).Count -eq 0

  $reason = ""
  foreach ($queue in $requiredQueues) {
    if (-not [bool]$queue.healthy) {
      $reason = "$($queue.queueName)_$($queue.reason)"
      break
    }
  }
  if (-not $reason) {
    foreach ($queue in $requiredQueues) {
      if (-not [bool]$queue.outgoingPoll.ready) {
        $reason = "$($queue.queueName)_$($queue.outgoingPoll.reason)"
        break
      }
    }
  }

  $result = [ordered]@{
    healthy = [bool]$healthy
    pendingCount = $pendingCount
    oldestAge = if ($oldest) { [long]$oldest.oldestAgeSeconds } else { $null }
    oldestAgeSeconds = if ($oldest) { [long]$oldest.oldestAgeSeconds } else { $null }
    oldestKey = if ($oldest) { [string]$oldest.oldestKey } else { "" }
    oldestQueue = if ($oldest) { [string]$oldest.queueName } else { "" }
    staleAfterSeconds = [Math]::Max(1, $StaleAfterSeconds)
    cursorPresent = [bool](@($requiredQueues | Where-Object { -not [bool]$_.cursorPresent }).Count -eq 0)
    reason = $reason
    outgoingPoll = [ordered]@{
      ready = [bool]$pollReady
      healthy = [bool]$pollHealthy
      lagSeconds = if ($lagValues.Count) { [long](($lagValues | Measure-Object -Maximum).Maximum) } else { $null }
      cursorAgeSeconds = if ($cursorAgeValues.Count) { [long](($cursorAgeValues | Measure-Object -Maximum).Maximum) } else { $null }
      staleAfterSeconds = $OutgoingPollStaleSeconds
      backfillActive = [bool](@($requiredQueues | Where-Object { [bool]$_.outgoingPoll.backfillActive }).Count -gt 0)
      stallAttempt = [int](($requiredQueues | ForEach-Object { [int]$_.outgoingPoll.stallAttempt } | Measure-Object -Maximum).Maximum)
      reason = $reason
    }
    main = $mainView
    canary = $canaryView
  }
  return $result
}

function Get-PendingInboundQueueHealth {
  param(
    [string]$Path = $PendingInboundQueue,
    [int]$StaleAfterSeconds = $DurablePendingStaleSeconds,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )

  $result = [ordered]@{
    healthy = $true
    pendingCount = 0
    oldestAgeSeconds = $null
    oldestKey = ""
    staleAfterSeconds = [Math]::Max(1, $StaleAfterSeconds)
    queuePresent = $false
    reason = ""
  }
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $result }
  $result.queuePresent = $true
  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $parsed = [System.IO.File]::ReadAllText($Path, $strictUtf8) | ConvertFrom-Json
    if ($null -eq $parsed) { throw "pending inbound JSON was empty" }
  } catch {
    $result.healthy = $false
    $result.reason = "queue_invalid"
    return $result
  }

  $messages = @()
  foreach ($scope in @($parsed.scopes) + @($parsed.sharedScopes)) {
    if ($null -eq $scope) { continue }
    $messages += @($scope.messages | Where-Object { $null -ne $_ })
  }
  $result.pendingCount = $messages.Count
  if ($messages.Count -eq 0) { return $result }

  $oldest = $null
  $oldestKey = ""
  foreach ($message in $messages) {
    $parsedAt = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$message.receivedAt, [ref]$parsedAt)) {
      if ($null -eq $oldest -or $parsedAt -lt $oldest) {
        $oldest = $parsedAt
        $oldestKey = [string]$message.pendingId
      }
    }
  }
  if ($null -eq $oldest) {
    $result.healthy = $false
    $result.reason = "pending_timestamp_missing"
    $result.oldestKey = [string]$messages[0].pendingId
    return $result
  }
  $ageSeconds = [Math]::Max(0, [Math]::Floor(($Now.ToUniversalTime() - $oldest.ToUniversalTime()).TotalSeconds))
  $result.oldestAgeSeconds = [long]$ageSeconds
  $result.oldestKey = $oldestKey
  if ($ageSeconds -gt $result.staleAfterSeconds) {
    $result.healthy = $false
    $result.reason = "stale_pending_inbound"
  }
  return $result
}

function Get-DeferredReplyQueueHealth {
  param(
    [string]$Path = $DeferredSystemReplies,
    [int]$StaleAfterSeconds = $DurablePendingStaleSeconds,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )

  $result = [ordered]@{
    healthy = $true
    repairable = $false
    attentionRequired = $false
    pendingCount = 0
    oldestAgeSeconds = $null
    oldestKey = ""
    staleAfterSeconds = [Math]::Max(1, $StaleAfterSeconds)
    queuePresent = $false
    reason = ""
  }
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $result }
  $result.queuePresent = $true
  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $parsed = [System.IO.File]::ReadAllText($Path, $strictUtf8) | ConvertFrom-Json
    if ($null -eq $parsed) { throw "deferred reply JSON was empty" }
  } catch {
    $result.healthy = $false
    $result.attentionRequired = $true
    $result.reason = "queue_invalid"
    return $result
  }

  $replies = @($parsed.replies | Where-Object { $null -ne $_ })
  $result.pendingCount = $replies.Count
  if ($replies.Count -eq 0) { return $result }
  $oldest = $null
  $oldestKey = ""
  foreach ($reply in $replies) {
    $parsedAt = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$reply.createdAt, [ref]$parsedAt)) {
      if ($null -eq $oldest -or $parsedAt -lt $oldest) {
        $oldest = $parsedAt
        $oldestKey = [string]$reply.id
      }
    }
  }
  if ($null -eq $oldest) {
    $result.healthy = $false
    $result.attentionRequired = $true
    $result.reason = "pending_timestamp_missing"
    $result.oldestKey = [string]$replies[0].id
    return $result
  }
  $ageSeconds = [Math]::Max(0, [Math]::Floor(($Now.ToUniversalTime() - $oldest.ToUniversalTime()).TotalSeconds))
  $result.oldestAgeSeconds = [long]$ageSeconds
  $result.oldestKey = $oldestKey
  if ($ageSeconds -gt $result.staleAfterSeconds) {
    # A deferred system reply is intentionally attached to the sender's next
    # inbound batch. Its age is useful operator context, but restarting cannot
    # advance it and therefore must never turn it into a restartable fault.
    $result.attentionRequired = $true
    $result.reason = "waiting_for_inbound"
  }
  return $result
}

function Get-ReplyObligationHealth {
  param(
    [string]$Path = $ReplyObligations,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )

  $result = [ordered]@{
    healthy = $true
    ready = $false
    repairable = $false
    storePresent = $false
    storeVersion = 0
    integrityStatus = ""
    openCount = 0
    pendingCount = 0
    overdueCount = 0
    verifiedCount = 0
    suppressedCount = 0
    deferredCount = 0
    terminalFailureCount = 0
    attentionRequiredCount = 0
    oldestOpenCreatedAt = ""
    oldestOpenAgeSeconds = $null
    oldestKey = ""
    nextDeadlineAt = ""
    latestFailureAt = ""
    latestFailureKey = ""
    latestFailureOutcome = ""
    latestFailureError = ""
    reason = ""
  }
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    $result.reason = "store_missing"
    return $result
  }
  $result.storePresent = $true

  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $parsed = [System.IO.File]::ReadAllText($Path, $strictUtf8) | ConvertFrom-Json
    if ($null -eq $parsed) { throw "reply obligation JSON was empty" }
    if ([string]$parsed.version -cne "1") { throw "reply obligation version was unsupported" }
    $result.storeVersion = 1
    if ($null -eq $parsed.PSObject.Properties["writerInstanceId"] `
      -or [string]::IsNullOrWhiteSpace([string]$parsed.writerInstanceId)) {
      throw "reply obligation writer identity was missing"
    }
    if ($null -eq (ConvertTo-UtcDateOrNull ([string]$parsed.updatedAt))) {
      throw "reply obligation updatedAt was invalid"
    }
    if ($null -eq $parsed.PSObject.Properties["integrity"] -or $null -eq $parsed.integrity) {
      throw "reply obligation integrity was missing"
    }
    $integrityStatus = ([string]$parsed.integrity.status).Trim().ToLowerInvariant()
    if ($integrityStatus -notin @("healthy", "recovered_corrupt")) {
      throw "reply obligation integrity status was invalid"
    }
    $result.integrityStatus = $integrityStatus
    if ($null -eq $parsed.PSObject.Properties["policy"] -or $null -eq $parsed.policy) {
      throw "reply obligation policy was missing"
    }
    foreach ($policyField in @("noReplyTimeoutMs", "retentionMs", "maxEntries")) {
      $policyValue = 0L
      if (-not [long]::TryParse([string]$parsed.policy.$policyField, [ref]$policyValue) `
        -or $policyValue -le 0) {
        throw "reply obligation policy $policyField was invalid"
      }
    }
    if ($null -eq $parsed.PSObject.Properties["summary"] -or $null -eq $parsed.summary) {
      throw "reply obligation summary was missing"
    }
    if ($null -eq $parsed.PSObject.Properties["obligations"] `
      -or $null -eq $parsed.obligations `
      -or $parsed.obligations -isnot [System.Array]) {
      throw "reply obligation entries were missing"
    }

    $openStatuses = @("handoff_pending", "awaiting_final", "final_delivery_pending")
    $failureOutcomes = @(
      "handoff_uncertain",
      "runtime_failed",
      "delivery_failed",
      "delivery_uncertain",
      "turn_completed_without_final",
      "no_reply_timeout"
    )
    $terminalStatusByOutcome = @{
      verified = "verified"
      deferred_durable = "deferred"
      explicit_silent = "suppressed"
      handoff_uncertain = "failed"
      runtime_failed = "failed"
      delivery_failed = "failed"
      delivery_uncertain = "failed"
      turn_completed_without_final = "failed"
      no_reply_timeout = "timed_out"
    }
    $openEntries = @()
    $failureEntries = @()
    foreach ($entry in @($parsed.obligations)) {
      if ($null -eq $entry) { throw "reply obligation entry was null" }
      $id = ([string]$entry.id).Trim()
      $provider = ([string]$entry.sourceProvider).Trim()
      $senderId = ([string]$entry.senderId).Trim()
      $status = ([string]$entry.status).Trim().ToLowerInvariant()
      $outcome = ([string]$entry.terminalOutcome).Trim().ToLowerInvariant()
      if ($id -notmatch "^reply-obligation:[a-f0-9]{64}$" `
        -or $provider -cne "weflow-uia" `
        -or [string]::IsNullOrWhiteSpace($senderId)) {
        throw "reply obligation identity schema was invalid"
      }
      if ($null -eq $entry.PSObject.Properties["sourceMessageIds"] `
        -or $null -eq $entry.sourceMessageIds `
        -or $entry.sourceMessageIds -isnot [System.Array] `
        -or @($entry.sourceMessageIds).Count -eq 0 `
        -or @($entry.sourceMessageIds | Where-Object { [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        throw "reply obligation source message ids were invalid"
      }
      if ($entry.terminal -isnot [bool]) { throw "reply obligation terminal flag was invalid" }
      foreach ($timeField in @("createdAt", "updatedAt", "handoffStartedAt", "noReplyDeadlineAt")) {
        if ($null -eq (ConvertTo-UtcDateOrNull ([string]$entry.$timeField))) {
          throw "reply obligation $timeField was invalid"
        }
      }
      $timeoutMs = 0L
      if (-not [long]::TryParse([string]$entry.noReplyTimeoutMs, [ref]$timeoutMs) -or $timeoutMs -le 0) {
        throw "reply obligation timeout was invalid"
      }

      if (-not [bool]$entry.terminal) {
        if ($status -notin $openStatuses -or -not [string]::IsNullOrWhiteSpace($outcome)) {
          throw "open reply obligation state was invalid"
        }
        $createdAt = [DateTimeOffset]::Parse([string]$entry.createdAt).ToUniversalTime()
        $deadlineAt = [DateTimeOffset]::Parse([string]$entry.noReplyDeadlineAt).ToUniversalTime()
        $openEntries += [pscustomobject]@{
          id = $id
          createdAt = $createdAt
          deadlineAt = $deadlineAt
        }
        continue
      }

      if (-not $terminalStatusByOutcome.ContainsKey($outcome) `
        -or $status -cne [string]$terminalStatusByOutcome[$outcome] `
        -or $null -eq (ConvertTo-UtcDateOrNull ([string]$entry.terminalAt))) {
        throw "terminal reply obligation state was invalid"
      }
      $terminalAt = [DateTimeOffset]::Parse([string]$entry.terminalAt).ToUniversalTime()
      switch ($outcome) {
        "verified" { $result.verifiedCount += 1 }
        "explicit_silent" { $result.suppressedCount += 1 }
        "deferred_durable" { $result.deferredCount += 1 }
        default {
          if ($outcome -notin $failureOutcomes) { throw "reply obligation terminal outcome was invalid" }
          $failureEntries += [pscustomobject]@{
            id = $id
            at = $terminalAt
            outcome = $outcome
            error = ([string]$entry.lastError).Trim()
          }
        }
      }
    }

    $result.ready = $true
    $result.openCount = $openEntries.Count
    $result.pendingCount = $openEntries.Count
    $result.terminalFailureCount = $failureEntries.Count
    $result.attentionRequiredCount = $result.deferredCount + $result.terminalFailureCount
    if ($openEntries.Count -gt 0) {
      $oldestOpen = @($openEntries | Sort-Object -Property createdAt, id | Select-Object -First 1)[0]
      $nextDeadline = @($openEntries | Sort-Object -Property deadlineAt, id | Select-Object -First 1)[0]
      $result.oldestOpenCreatedAt = $oldestOpen.createdAt.ToString("o")
      $result.oldestOpenAgeSeconds = [long][Math]::Max(
        0,
        [Math]::Floor(($Now.ToUniversalTime() - $oldestOpen.createdAt).TotalSeconds)
      )
      $result.oldestKey = [string]$oldestOpen.id
      $result.nextDeadlineAt = $nextDeadline.deadlineAt.ToString("o")
      $result.overdueCount = @($openEntries | Where-Object {
        $_.deadlineAt -le $Now.ToUniversalTime()
      }).Count
    }
    if ($failureEntries.Count -gt 0) {
      $latestFailure = @($failureEntries | Sort-Object -Property at, id | Select-Object -Last 1)[0]
      $result.latestFailureAt = $latestFailure.at.ToString("o")
      $result.latestFailureKey = [string]$latestFailure.id
      $result.latestFailureOutcome = [string]$latestFailure.outcome
      $result.latestFailureError = [string]$latestFailure.error
    }

    if ($integrityStatus -eq "recovered_corrupt") {
      $result.healthy = $false
      $result.reason = "store_recovered_corrupt"
    } elseif ($result.overdueCount -gt 0) {
      $result.healthy = $false
      $result.reason = "reply_obligation_overdue"
    } elseif ($result.terminalFailureCount -gt 0) {
      # Completed historical failures remain visible for operator follow-up,
      # but they are not a present service outage and a restart cannot change
      # their terminal outcome.
      $result.reason = "terminal_reply_failure_attention"
    }
    return $result
  } catch {
    $result.healthy = $false
    $result.ready = $false
    $result.repairable = $false
    $result.reason = "store_invalid"
    return $result
  }
}

function Get-WeFlowLedgerEntryEventTime {
  param([Parameter(Mandatory = $true)]$Entry)

  $status = ([string]$Entry.status).Trim().ToLowerInvariant()
  $fieldNames = switch ($status) {
    "failed" { @("failedAt", "updatedAt", "createdAt") }
    "failed_uncertain" { @("failedAt", "updatedAt", "createdAt") }
    "verified" { @("verifiedAt", "observedAt", "updatedAt", "createdAt") }
    "sending" { @("sendingAt", "updatedAt", "createdAt") }
    default { @("updatedAt", "createdAt") }
  }
  foreach ($fieldName in $fieldNames) {
    $property = $Entry.PSObject.Properties[$fieldName]
    if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
      continue
    }
    $parsedAt = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$property.Value, [ref]$parsedAt)) {
      return $parsedAt.ToUniversalTime()
    }
  }
  return $null
}

function Get-MainDeliveryHealth {
  param(
    [string]$Path = $WeFlowMessageLedger,
    [string]$Talker = $WeFlowInboxChat,
    [int]$WindowSeconds = $MainDeliveryWindowSeconds,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )

  $normalizedTalker = if ($null -eq $Talker) { "" } else { ([string]$Talker).Trim() }
  $window = [Math]::Max(60, [int]$WindowSeconds)
  $result = [ordered]@{
    healthy = $true
    ready = $false
    repairable = $true
    ledgerPresent = $false
    ledgerVersion = 0
    talker = $normalizedTalker
    windowSeconds = $window
    recentEntryCount = 0
    invalidEntryCount = 0
    terminalFailureCount = 0
    latestStatus = ""
    latestEventAt = ""
    failedAt = ""
    entryId = ""
    messageKind = ""
    failureCode = ""
    failureHash = ""
    reason = ""
  }

  if ([string]::IsNullOrWhiteSpace($normalizedTalker)) {
    $result.reason = "talker_not_configured"
    return $result
  }
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    $result.reason = "ledger_missing"
    return $result
  }
  $result.ledgerPresent = $true
  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $parsed = [System.IO.File]::ReadAllText($Path, $strictUtf8) | ConvertFrom-Json
    if ($null -eq $parsed) { throw "message ledger JSON was empty" }
    $version = 0
    if (-not [int]::TryParse([string]$parsed.version, [ref]$version)) {
      throw "message ledger version was invalid"
    }
    $result.ledgerVersion = $version
    if ($version -ne 3) {
      $result.reason = "ledger_version_unsupported"
      return $result
    }
    if ($null -eq $parsed.PSObject.Properties["entries"] -or $null -eq $parsed.entries) {
      throw "message ledger entries were missing"
    }
  } catch {
    $result.healthy = $false
    $result.repairable = $false
    $result.reason = "ledger_invalid"
    return $result
  }

  $cutoff = $Now.ToUniversalTime().AddSeconds(-$window)
  $events = @()
  $invalidEntryCount = 0
  $sequence = 0
  foreach ($entry in @($parsed.entries)) {
    $sequence += 1
    if ($null -eq $entry) { continue }
    $entryTalker = ([string]$entry.talker).Trim()
    if ($entryTalker -cne $normalizedTalker) { continue }
    $direction = ([string]$entry.expectedDirection).Trim().ToLowerInvariant()
    if ($direction -and $direction -ne "outgoing") { continue }
    if (-not $direction -and ([string]$entry.messageKind).Trim().ToLowerInvariant().StartsWith("native_")) {
      continue
    }
    $status = ([string]$entry.status).Trim().ToLowerInvariant()
    if ($status -notin @("planned", "sending", "verified", "failed", "failed_uncertain")) {
      $invalidEntryCount += 1
      continue
    }
    $eventAt = Get-WeFlowLedgerEntryEventTime -Entry $entry
    if ($null -eq $eventAt) {
      $invalidEntryCount += 1
      continue
    }
    if ($eventAt -lt $cutoff) { continue }
    $events += [pscustomobject]@{
      at = $eventAt
      sequence = $sequence
      status = $status
      entry = $entry
    }
  }
  # Version 3 writers validate every persisted row. Ignore a malformed legacy
  # residue instead of letting an entry with no trustworthy timestamp poison
  # health forever; the strict file-level UTF-8/JSON/schema checks above still
  # fail closed when the active ledger itself is unreadable.
  $result.invalidEntryCount = $invalidEntryCount

  $events = @($events | Sort-Object -Property `
    @{ Expression = { $_.at }; Ascending = $true }, `
    @{ Expression = { $_.sequence }; Ascending = $true })
  $result.ready = $true
  $result.recentEntryCount = $events.Count
  if ($events.Count -eq 0) { return $result }

  $latest = $events[-1]
  $result.latestStatus = [string]$latest.status
  $result.latestEventAt = $latest.at.ToString("o")
  # Progress updates are explicitly lossy in the stream layer; a missed progress
  # marker must not block the reply pipeline. Acknowledgements and final/plain
  # replies remain delivery-significant.
  $failures = @($events | Where-Object {
    $_.status -eq "failed" `
      -and $_.entry.uncertain -ne $true `
      -and ([string]$_.entry.messageKind).Trim().ToLowerInvariant() -notin @(
        "progress",
        "watchdog_restart_notification"
      )
  })
  if ($failures.Count -eq 0) { return $result }

  # A later delivery only resolves the same logical payload. An unrelated ack,
  # progress marker, restart notice, or later reply must never hide a lost final.
  $unresolvedByLogicalKey = @{}
  foreach ($failure in $failures) {
    $failureEntry = $failure.entry
    $logicalKey = "{0}|{1}|{2}" -f `
      ([string]$failureEntry.contentKind).Trim().ToLowerInvariant(), `
      ([string]$failureEntry.contentHash).Trim().ToLowerInvariant(), `
      ([string]$failureEntry.messageKind).Trim().ToLowerInvariant()
    if ($logicalKey -eq "||") { $logicalKey = "id:$([string]$failureEntry.id)" }
    $replacement = @($events | Where-Object {
      if ($_.status -notin @("verified", "sending")) { return $false }
      $candidateEntry = $_.entry
      $candidateKey = "{0}|{1}|{2}" -f `
        ([string]$candidateEntry.contentKind).Trim().ToLowerInvariant(), `
        ([string]$candidateEntry.contentHash).Trim().ToLowerInvariant(), `
        ([string]$candidateEntry.messageKind).Trim().ToLowerInvariant()
      return $candidateKey -eq $logicalKey -and (
        $_.at -gt $failure.at -or (
          $_.at -eq $failure.at -and $_.sequence -gt $failure.sequence
        )
      )
    } | Select-Object -Last 1)
    if ($replacement.Count -eq 0) {
      $existing = $unresolvedByLogicalKey[$logicalKey]
      if ($null -eq $existing `
        -or $failure.at -gt $existing.at `
        -or ($failure.at -eq $existing.at -and $failure.sequence -gt $existing.sequence)) {
        $unresolvedByLogicalKey[$logicalKey] = $failure
      }
    }
  }
  $result.terminalFailureCount = $unresolvedByLogicalKey.Count
  if ($unresolvedByLogicalKey.Count -eq 0) { return $result }

  $latestFailure = @($unresolvedByLogicalKey.Values | Sort-Object -Property `
    @{ Expression = { $_.at }; Ascending = $true }, `
    @{ Expression = { $_.sequence }; Ascending = $true })[-1]
  $failedEntry = $latestFailure.entry
  $result.healthy = $false
  $result.repairable = $false
  $result.reason = "terminal_outbound_failed"
  $result.failedAt = $latestFailure.at.ToString("o")
  $result.entryId = ([string]$failedEntry.id).Trim()
  $result.messageKind = ([string]$failedEntry.messageKind).Trim()
  $result.failureCode = ([string]$failedEntry.failureCode).Trim()
  $result.failureHash = ([string]$failedEntry.failureHash).Trim()
  return $result
}

function Read-CanaryStatus {
  $result = [ordered]@{
    healthy = $null
    status = "never"
    action = "not_checked"
    runId = ""
    triggerLocalId = ""
    replyLocalId = ""
    quietWindowMs = 0
    cursorCommittedAt = ""
    lastAttemptAt = ""
    lastSuccessAt = ""
    lastFailureAt = ""
    nextDueAt = ""
    consecutiveFailures = 0
    error = ""
    detail = ""
    attempted = $false
    repairable = $false
  }
  if (-not (Test-Path -LiteralPath $WatchdogCanaryState)) { return $result }
  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $parsed = [System.IO.File]::ReadAllText($WatchdogCanaryState, $strictUtf8) | ConvertFrom-Json
    $completedStatus = if ([string]::IsNullOrWhiteSpace([string]$parsed.lastStatus)) {
      "never"
    } else {
      [string]$parsed.lastStatus
    }
    $result.action = if ([string]::IsNullOrWhiteSpace([string]$parsed.lastAction)) { "not_checked" } else { [string]$parsed.lastAction }
    $completedHealthy = if ($completedStatus -eq "healthy") { $true } elseif ($completedStatus -eq "failed") { $false } else { $null }
    # Deferred scheduler decisions are observations, not new completed probe
    # outcomes. Preserve the previous completed truth value, except after an
    # exact-target change where the old target's truth value is invalid.
    $result.healthy = if ($result.action -in $CanaryUnknownHealthActions) { $null } else { $completedHealthy }
    $result.status = if ($result.action -in $CanaryDeferredActions) { "deferred" } else { $completedStatus }
    $result.runId = [string]$parsed.lastRunId
    $hasPersistedRepairability = $null -ne $parsed.PSObject.Properties["lastRepairable"]
    $result.repairable = if ($hasPersistedRepairability) {
      [bool]$parsed.lastRepairable
    } else {
      $result.action -eq "failed"
    }
    $result.detail = [string]$parsed.lastDetail
    $result.triggerLocalId = [string]$parsed.lastTriggerLocalId
    $result.replyLocalId = [string]$parsed.lastReplyLocalId
    $result.quietWindowMs = [Math]::Max(0, [int]$parsed.lastQuietWindowMs)
    $result.cursorCommittedAt = [string]$parsed.lastCursorCommittedAt
    $result.lastAttemptAt = [string]$parsed.lastAttemptAt
    $result.lastSuccessAt = [string]$parsed.lastSuccessAt
    $result.lastFailureAt = [string]$parsed.lastFailureAt
    $result.nextDueAt = [string]$parsed.nextDueAt
    $result.consecutiveFailures = [Math]::Max(0, [int]$parsed.consecutiveFailures)
    $result.error = [string]$parsed.lastError
  } catch {
    $result.healthy = $false
    $result.status = "invalid"
    $result.error = $_.Exception.Message
  }
  return $result
}

function Read-WatchdogStrictJson {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    return [System.IO.File]::ReadAllText($Path, $strictUtf8) | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-ModelRoutineConsecutiveFailures {
  param($Schedule)

  if ($null -eq $Schedule -or $null -eq $Schedule.PSObject.Properties["obligations"]) { return 0 }
  $handled = @($Schedule.obligations | Where-Object {
    $null -ne $_ -and ([string]$_.state).Trim().ToLowerInvariant() -eq "handled"
  })
  $count = 0
  for ($index = $handled.Count - 1; $index -ge 0; $index -= 1) {
    $entry = $handled[$index]
    if (([string]$entry.reason).Trim().ToLowerInvariant() -ne "routine") { break }
    if ($entry.healthy -eq $false) {
      $count += 1
      continue
    }
    break
  }
  return $count
}

function Get-WatchdogSha256Hex {
  param([Parameter(Mandatory = $true)][string]$Value)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    return -join ($sha256.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha256.Dispose()
  }
}

function Test-WatchdogPositiveSafeInteger {
  param($Value)

  $text = ([string]$Value).Trim()
  if ($text -notmatch "^[1-9]\d*$") { return $false }
  try {
    $number = [System.Numerics.BigInteger]::Parse($text)
    return $number -le [System.Numerics.BigInteger]::Parse("9007199254740991")
  } catch {
    return $false
  }
}

function Test-WatchdogPositiveInteger {
  param($Value)

  $text = ([string]$Value).Trim()
  if ($text -notmatch "^[1-9]\d*$") { return $false }
  try {
    return [System.Numerics.BigInteger]::Parse($text) -gt [System.Numerics.BigInteger]::Zero
  } catch {
    return $false
  }
}

function Test-ModelCanaryCursorProof {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][string]$TriggerLocalId,
    [Parameter(Mandatory = $true)][string]$ReplyLocalId,
    [DateTimeOffset]$ClaimedCommittedAt = [DateTimeOffset]::MinValue
  )

  $failure = { param([string]$Detail) return [ordered]@{ verified = $false; detail = $Detail; cursorCommittedAt = "" } }
  $cursor = Read-WatchdogStrictJson -Path $WeFlowCanaryInboxCursor
  if ($null -eq $cursor) {
    return & $failure "dedicated model canary cursor is missing or invalid"
  }
  $updatedAt = [DateTimeOffset]::MinValue
  $lastPolledAt = [DateTimeOffset]::MinValue
  if ([int]$cursor.version -ne 1 `
    -or ([string]$cursor.talker).Trim() -cne ([string]$Manifest.talker).Trim() `
    -or $cursor.seenIdentities -isnot [System.Array] `
    -or -not [DateTimeOffset]::TryParse([string]$cursor.updatedAt, [ref]$updatedAt) `
    -or -not [DateTimeOffset]::TryParse([string]$cursor.lastPolledAt, [ref]$lastPolledAt)) {
    return & $failure "dedicated model canary cursor v1 schema or talker binding is invalid"
  }
  $seen = @($cursor.seenIdentities)
  if (@($seen | Where-Object { $_ -isnot [string] }).Count -gt 0) {
    return & $failure "dedicated model canary cursor seen identities are invalid"
  }
  $lastLocalId = ([string]$cursor.lastLocalId).Trim()
  if ($lastLocalId -and -not (Test-WatchdogPositiveInteger -Value $lastLocalId)) {
    return & $failure "dedicated model canary cursor lastLocalId is invalid"
  }
  $lastNumber = if ($lastLocalId) { [System.Numerics.BigInteger]::Parse($lastLocalId) } else { $null }
  $isCommitted = {
    param([string]$LocalId)
    if ($seen -ccontains "local:$LocalId") { return $true }
    if ($null -eq $lastNumber) { return $false }
    return $lastNumber -ge [System.Numerics.BigInteger]::Parse($LocalId)
  }
  if (-not (& $isCommitted $TriggerLocalId) -or -not (& $isCommitted $ReplyLocalId)) {
    return & $failure "dedicated model canary cursor has not committed both trigger and reply localIds"
  }
  try {
    $cursorCommittedAt = [DateTimeOffset](Get-Item -LiteralPath $WeFlowCanaryInboxCursor).LastWriteTimeUtc
  } catch {
    return & $failure "dedicated model canary cursor timestamp is unavailable"
  }
  if ($ClaimedCommittedAt -ne [DateTimeOffset]::MinValue `
    -and $cursorCommittedAt -lt $ClaimedCommittedAt.AddSeconds(-2)) {
    return & $failure "dedicated model canary cursor predates the claimed durable commit"
  }
  return [ordered]@{
    verified = $true
    detail = "dedicated model canary cursor v1 committed both ordered localIds"
    cursorCommittedAt = $cursorCommittedAt.ToUniversalTime().ToString("o")
  }
}

function Test-ModelCanaryReceiptProof {
  param([Parameter(Mandatory = $true)]$Result)

  $failure = { param([string]$Detail) return [ordered]@{ verified = $false; detail = $Detail; cursorCommittedAt = "" } }
  $runId = ([string]$Result.runId).Trim().ToLowerInvariant()
  $triggerLocalId = ([string]$Result.triggerLocalId).Trim()
  $replyLocalId = ([string]$Result.replyLocalId).Trim()
  if ([string]$Result.action -ne "verified" -or $Result.healthy -ne $true) {
    return & $failure "runner did not return healthy=true/action=verified"
  }
  if ($runId -notmatch "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$") {
    return & $failure "runner runId is invalid"
  }
  if (-not (Test-WatchdogPositiveInteger -Value $triggerLocalId) `
    -or -not (Test-WatchdogPositiveInteger -Value $replyLocalId)) {
    return & $failure "runner trigger/reply localIds are missing"
  }
  $triggerNumber = [System.Numerics.BigInteger]::Parse($triggerLocalId)
  $replyNumber = [System.Numerics.BigInteger]::Parse($replyLocalId)
  if ($replyNumber -le $triggerNumber) {
    return & $failure "model E2E reply localId does not follow its trigger localId"
  }
  if ([string]::IsNullOrWhiteSpace([string]$Result.threadId) `
    -or [string]::IsNullOrWhiteSpace([string]$Result.turnId) `
    -or $Result.targetVerified -ne $true) {
    return & $failure "runner target, thread, or turn proof is incomplete"
  }
  $cursorCommittedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Result.cursorCommittedAt, [ref]$cursorCommittedAt)) {
    return & $failure "runner cursor commit proof is missing"
  }

  $runDir = Join-Path (Join-Path $StateDir "model-e2e-probes") $runId
  $manifest = Read-WatchdogStrictJson -Path (Join-Path $runDir "manifest.json")
  $summary = Read-WatchdogStrictJson -Path (Join-Path $runDir "summary.json")
  if ($null -eq $manifest -or $null -eq $summary) {
    return & $failure "model E2E manifest or summary receipt is missing"
  }
  $nonce = ([string]$manifest.nonce).Trim().ToLowerInvariant()
  $obligationFingerprint = ([string]$manifest.obligationFingerprint).Trim().ToLowerInvariant()
  $currentTalker = ([string]$WeFlowCanaryChat).Trim()
  $currentContact = ([string]$WeFlowCanaryDisplayName).Trim()
  if ([string]::IsNullOrWhiteSpace($currentTalker) -or [string]::IsNullOrWhiteSpace($currentContact)) {
    return & $failure "current model E2E target configuration is incomplete"
  }
  $expectedTargetFingerprint = Get-WatchdogSha256Hex -Value "$currentContact`n$currentTalker"
  $manifestTalker = ([string]$manifest.talker).Trim()
  $manifestContact = ([string]$manifest.contact).Trim()
  $manifestTargetFingerprint = ([string]$manifest.targetFingerprint).Trim()
  if ([int]$manifest.version -ne 1 `
    -or [string]$manifest.mode -ne "model_e2e" `
    -or ([string]$manifest.runId).Trim().ToLowerInvariant() -cne $runId `
    -or $nonce -notmatch "^[0-9a-f]{24}$" `
    -or $obligationFingerprint -notmatch "^[0-9a-f]{64}$") {
    return & $failure "model E2E manifest schema or run binding is invalid"
  }
  if ($manifestTalker -cne $currentTalker `
    -or $manifestContact -cne $currentContact `
    -or $manifestTargetFingerprint -cne $expectedTargetFingerprint) {
    return & $failure "model E2E manifest current target binding is invalid"
  }
  foreach ($terminalName in @(
      "handoff-failed",
      "approval-denied",
      "tool-attempted",
      "turn-release-failed",
      "reply-delivery-failed",
      "turn-completed-without-final",
      "turn-failed"
    )) {
    $terminalPath = Join-Path $runDir "$terminalName.json"
    if (-not (Test-Path -LiteralPath $terminalPath -PathType Leaf)) { continue }
    $terminalReceipt = Read-WatchdogStrictJson -Path $terminalPath
    if ($null -eq $terminalReceipt `
      -or [int]$terminalReceipt.version -ne 1 `
      -or [string]$terminalReceipt.mode -ne "model_e2e" `
      -or ([string]$terminalReceipt.runId).Trim().ToLowerInvariant() -cne $runId `
      -or ([string]$terminalReceipt.nonce).Trim().ToLowerInvariant() -cne $nonce `
      -or ([string]$terminalReceipt.obligationFingerprint).Trim().ToLowerInvariant() -cne $obligationFingerprint) {
      return & $failure "$terminalName terminal receipt exists but failed manifest binding validation"
    }
    return & $failure "$terminalName terminal failure receipt is present"
  }
  # Use regex Unicode escapes so Windows PowerShell 5.1 does not depend on the
  # source file's BOM when matching the reserved Chinese marker text.
  $triggerMarkerPattern = '^\[Cyberboss\u5fc3\u8df3\u6a21\u578b\u63a2\u9488 trigger=' `
    + [regex]::Escape($runId) + ' nonce=' + [regex]::Escape($nonce) + '\]$'
  $replyMarkerPattern = '^\[Cyberboss\u5fc3\u8df3\u6a21\u578b\u6b63\u5e38 trigger=' `
    + [regex]::Escape($runId) + '\]$'
  if (([string]$manifest.triggerText).Trim() -cnotmatch $triggerMarkerPattern `
    -or ([string]$manifest.replyText).Trim() -cnotmatch $replyMarkerPattern) {
    return & $failure "model E2E manifest trigger/reply marker binding is invalid"
  }
  if (([string]$manifest.replyMessageKind).Trim() -cne "model_canary_reply:$runId" `
    -or ([string]$manifest.replyIdempotencyKey).Trim() -cne "model-canary-reply:$runId") {
    return & $failure "model E2E manifest delivery identity binding is invalid"
  }
  $desktopInputLease = Read-WatchdogStrictJson -Path (Join-Path $runDir "desktop-input-lease.json")
  $leaseIssuedAt = [DateTimeOffset]::MinValue
  $leaseRecordedAt = [DateTimeOffset]::MinValue
  $leaseExpiresAt = [DateTimeOffset]::MinValue
  $leaseTickText = if ($null -eq $desktopInputLease) { "" } else { ([string]$desktopInputLease.triggerLastInputTick).Trim() }
  $leaseTickValid = $false
  if ($leaseTickText -match "^\d+$") {
    try {
      $leaseTick = [System.Numerics.BigInteger]::Parse($leaseTickText)
      $leaseTickValid = $leaseTick -ge [System.Numerics.BigInteger]::Zero `
        -and $leaseTick -le [System.Numerics.BigInteger]::Parse("4294967295")
    } catch {
      $leaseTickValid = $false
    }
  }
  if ($null -eq $desktopInputLease `
    -or [int]$desktopInputLease.version -ne 1 `
    -or [string]$desktopInputLease.mode -ne "model_e2e" `
    -or ([string]$desktopInputLease.runId).Trim().ToLowerInvariant() -cne $runId `
    -or ([string]$desktopInputLease.nonce).Trim().ToLowerInvariant() -cne $nonce `
    -or ([string]$desktopInputLease.obligationFingerprint).Trim().ToLowerInvariant() -cne $obligationFingerprint `
    -or ([string]$desktopInputLease.targetFingerprint).Trim() -cne $expectedTargetFingerprint `
    -or ([string]$desktopInputLease.talker).Trim() -cne $currentTalker `
    -or ([string]$desktopInputLease.contact).Trim() -cne $currentContact `
    -or ([string]$desktopInputLease.replyIdempotencyKey).Trim() -cne ([string]$manifest.replyIdempotencyKey).Trim() `
    -or ([string]$desktopInputLease.manifestFingerprint).Trim().ToLowerInvariant() -notmatch "^[0-9a-f]{64}$" `
    -or ([string]$desktopInputLease.leaseToken).Trim().ToLowerInvariant() -notmatch "^[0-9a-f]{64}$" `
    -or -not $leaseTickValid `
    -or -not [DateTimeOffset]::TryParse([string]$desktopInputLease.issuedAt, [ref]$leaseIssuedAt) `
    -or -not [DateTimeOffset]::TryParse([string]$desktopInputLease.recordedAt, [ref]$leaseRecordedAt) `
    -or -not [DateTimeOffset]::TryParse([string]$desktopInputLease.expiresAt, [ref]$leaseExpiresAt) `
    -or $leaseIssuedAt -gt $leaseRecordedAt.AddSeconds(10) `
    -or $leaseExpiresAt -le $leaseRecordedAt `
    -or ([string]$desktopInputLease.expiresAt).Trim() -cne ([string]$manifest.expiresAt).Trim() `
    -or ([string]$Result.desktopInputLeaseManifestFingerprint).Trim().ToLowerInvariant() -cne ([string]$desktopInputLease.manifestFingerprint).Trim().ToLowerInvariant()) {
    return & $failure "model E2E desktop input lease receipt failed manifest, target, token, tick, or TTL binding validation"
  }
  if ([string]$summary.action -ne "verified" `
    -or $summary.healthy -ne $true `
    -or ([string]$summary.runId).Trim().ToLowerInvariant() -cne $runId `
    -or ([string]$summary.triggerLocalId).Trim() -cne $triggerLocalId `
    -or ([string]$summary.replyLocalId).Trim() -cne $replyLocalId `
    -or ([string]$summary.threadId).Trim() -cne ([string]$Result.threadId).Trim() `
    -or ([string]$summary.turnId).Trim() -cne ([string]$Result.turnId).Trim() `
    -or $summary.targetVerified -ne $true `
    -or ([string]$summary.targetTalker).Trim() -cne $currentTalker `
    -or ([string]$summary.targetContact).Trim() -cne $currentContact `
    -or ([string]$summary.targetFingerprint).Trim() -cne $expectedTargetFingerprint `
    -or ([string]$Result.targetTalker).Trim() -cne $currentTalker `
    -or ([string]$Result.targetContact).Trim() -cne $currentContact `
    -or ([string]$Result.targetFingerprint).Trim() -cne $expectedTargetFingerprint) {
    return & $failure "model E2E summary does not match runner proof"
  }

  $receipts = [ordered]@{}
  foreach ($name in @(
      "ingested",
      "handoff",
      "model-completed",
      "reply-dispatched",
      "reply-observed",
      "turn-released"
    )) {
    $receipt = Read-WatchdogStrictJson -Path (Join-Path $runDir "$name.json")
    if ($null -eq $receipt `
      -or [int]$receipt.version -ne 1 `
      -or [string]$receipt.mode -ne "model_e2e" `
      -or ([string]$receipt.runId).Trim().ToLowerInvariant() -cne $runId `
      -or ([string]$receipt.nonce).Trim().ToLowerInvariant() -cne $nonce `
      -or ([string]$receipt.obligationFingerprint).Trim().ToLowerInvariant() -cne $obligationFingerprint) {
      return & $failure "$name receipt failed manifest binding validation"
    }
    $receipts[$name] = $receipt
  }
  if ([string]$receipts["ingested"].status -ne "ingested" `
    -or [string]$receipts["handoff"].status -ne "accepted" `
    -or [string]$receipts["model-completed"].status -ne "completed" `
    -or $receipts["model-completed"].assistantFinalPresent -ne $true `
    -or [string]$receipts["reply-observed"].status -ne "observed" `
    -or [string]$receipts["turn-released"].status -ne "released") {
    return & $failure "model E2E receipt statuses are incomplete"
  }
  if ([string]$receipts["reply-dispatched"].status -notin @("verified", "dispatched", "reconciled_from_echo")) {
    return & $failure "model E2E reply dispatch receipt is incomplete"
  }
  $modelCompleted = $receipts["model-completed"]
  $assistantFinalSha256 = ([string]$modelCompleted.assistantFinalSha256).Trim()
  if ($assistantFinalSha256 -notmatch "^[0-9a-f]{64}$" `
    -or -not (Test-WatchdogPositiveSafeInteger -Value $modelCompleted.assistantFinalLength) `
    -or -not (Test-WatchdogPositiveSafeInteger -Value $modelCompleted.assistantFinalBytes)) {
    return & $failure "model completion SHA-256, code-point length, or UTF-8 byte proof is invalid"
  }
  $assistantFinalLength = [System.Numerics.BigInteger]::Parse(([string]$modelCompleted.assistantFinalLength).Trim())
  $assistantFinalBytes = [System.Numerics.BigInteger]::Parse(([string]$modelCompleted.assistantFinalBytes).Trim())
  if ($assistantFinalBytes -lt $assistantFinalLength) {
    return & $failure "model completion UTF-8 bytes are shorter than its code-point length"
  }
  if (([string]$receipts["ingested"].triggerLocalId).Trim() -cne $triggerLocalId `
    -or ([string]$receipts["reply-dispatched"].replyLocalId).Trim() -cne $replyLocalId `
    -or ([string]$receipts["reply-observed"].replyLocalId).Trim() -cne $replyLocalId `
    -or ([string]$receipts["handoff"].threadId).Trim() -cne ([string]$Result.threadId).Trim() `
    -or ([string]$receipts["handoff"].turnId).Trim() -cne ([string]$Result.turnId).Trim()) {
    return & $failure "model E2E localId or runtime binding is inconsistent"
  }
  $resultThreadId = ([string]$Result.threadId).Trim()
  $resultTurnId = ([string]$Result.turnId).Trim()
  foreach ($receiptName in @("model-completed", "reply-dispatched", "turn-released")) {
    $receiptThreadId = ([string]$receipts[$receiptName].threadId).Trim()
    $receiptTurnId = ([string]$receipts[$receiptName].turnId).Trim()
    if (-not $receiptThreadId `
      -or -not $receiptTurnId `
      -or $receiptThreadId -cne $resultThreadId `
      -or $receiptTurnId -cne $resultTurnId) {
      return & $failure "$receiptName runtime thread/turn binding is inconsistent"
    }
  }
  $observedThreadId = ([string]$receipts["reply-observed"].threadId).Trim()
  $observedTurnId = ([string]$receipts["reply-observed"].turnId).Trim()
  if (($observedThreadId -or $observedTurnId) `
    -and (-not $observedThreadId `
      -or -not $observedTurnId `
      -or $observedThreadId -cne $resultThreadId `
      -or $observedTurnId -cne $resultTurnId)) {
    return & $failure "reply-observed runtime thread/turn binding is inconsistent"
  }
  if (([string]$receipts["reply-dispatched"].messageKind).Trim() -cne ([string]$manifest.replyMessageKind).Trim() `
    -or ([string]$receipts["reply-dispatched"].idempotencyKey).Trim() -cne ([string]$manifest.replyIdempotencyKey).Trim() `
    -or ([string]$receipts["reply-observed"].messageKind).Trim() -cne ([string]$manifest.replyMessageKind).Trim() `
    -or ([string]$receipts["reply-observed"].idempotencyKey).Trim() -cne ([string]$manifest.replyIdempotencyKey).Trim()) {
    return & $failure "model E2E reply identity receipts are inconsistent"
  }
  if (([string]$receipts["ingested"].talker).Trim() -cne $currentTalker `
    -or ([string]$receipts["ingested"].direction).Trim().ToLowerInvariant() -cne "outgoing" `
    -or ([string]$receipts["reply-dispatched"].talker).Trim() -cne $currentTalker `
    -or ([string]$receipts["reply-dispatched"].contact).Trim() -cne $currentContact `
    -or ([string]$receipts["reply-observed"].talker).Trim() -cne $currentTalker `
    -or ([string]$receipts["reply-observed"].direction).Trim().ToLowerInvariant() -cne "outgoing") {
    return & $failure "model E2E receipt target or outgoing direction is inconsistent"
  }
  $cursorProof = Test-ModelCanaryCursorProof `
    -Manifest $manifest `
    -TriggerLocalId $triggerLocalId `
    -ReplyLocalId $replyLocalId `
    -ClaimedCommittedAt $cursorCommittedAt
  if (-not $cursorProof.verified) {
    return & $failure ([string]$cursorProof.detail)
  }
  return [ordered]@{
    verified = $true
    detail = "current target, ordered localIds, model digest, desktop input lease, six lifecycle receipts, and dedicated cursor commit were verified"
    cursorCommittedAt = [string]$cursorProof.cursorCommittedAt
  }
}

function Read-ModelCanaryStatus {
  $result = [ordered]@{
    enabled = [bool]$ModelCanaryEnabled
    healthy = $null
    status = if ($ModelCanaryEnabled) { "never" } else { "disabled" }
    action = if ($ModelCanaryEnabled) { "not_checked" } else { "not_run" }
    attempted = $false
    repairable = $false
    confirmedFailure = $false
    routineFailureActive = $false
    routineConsecutiveFailures = 0
    runId = ""
    triggerLocalId = ""
    replyLocalId = ""
    threadId = ""
    turnId = ""
    cursorCommittedAt = ""
    receiptsVerified = $false
    lastAttemptAt = ""
    lastSuccessAt = ""
    lastFailureAt = ""
    nextDueAt = ""
    consecutiveFailures = 0
    code = ""
    lastReason = ""
    error = ""
    detail = if ($ModelCanaryEnabled) { "" } else { "model E2E canary is disabled by configuration" }
  }
  if (-not $ModelCanaryEnabled) { return $result }
  if (-not (Test-Path -LiteralPath $WatchdogModelCanaryState)) { return $result }
  try {
    $parsed = Read-WatchdogStrictJson -Path $WatchdogModelCanaryState
    if ($null -eq $parsed -or [int]$parsed.version -ne 1 -or [string]$parsed.mode -ne "model_e2e") {
      throw "model E2E schedule schema is invalid"
    }
    $result.runId = ([string]$parsed.lastRunId).Trim().ToLowerInvariant()
    $result.lastAttemptAt = [string]$parsed.lastAttemptAt
    $result.lastSuccessAt = [string]$parsed.lastSuccessAt
    $result.lastFailureAt = [string]$parsed.lastFailureAt
    $result.nextDueAt = [string]$parsed.nextDueAt
    $result.consecutiveFailures = [Math]::Max(0, [int]$parsed.consecutiveFailures)
    $result.routineConsecutiveFailures = [Math]::Max(0, [int](Get-ModelRoutineConsecutiveFailures -Schedule $parsed))
    $result.confirmedFailure = $result.routineConsecutiveFailures -ge $RequiredFailureConfirmations
    $result.lastReason = ([string]$parsed.lastReason).Trim().ToLowerInvariant()
    $result.action = if ([string]::IsNullOrWhiteSpace([string]$parsed.lastAction)) { "not_checked" } else { [string]$parsed.lastAction }
    $result.detail = [string]$parsed.lastDetail
    $result.error = [string]$parsed.lastError
    $completedStatus = ([string]$parsed.lastStatus).Trim().ToLowerInvariant()
    $result.healthy = if ($completedStatus -eq "healthy") { $true } elseif ($completedStatus -eq "failed") { $false } else { $null }
    $result.routineFailureActive = $result.healthy -eq $false -and $result.lastReason -eq "routine"
    $result.status = if ($result.action -in $ModelCanaryDeferredActions) { "deferred" } elseif ($result.healthy -eq $true) { "healthy" } elseif ($result.healthy -eq $false) { "failed" } else { "never" }
    $history = @($parsed.history | Where-Object { $null -ne $_ })
    $last = @($history | Where-Object { ([string]$_.runId).Trim().ToLowerInvariant() -ceq $result.runId } | Select-Object -Last 1)
    if ($last.Count -gt 0) {
      $result.triggerLocalId = [string]$last[0].triggerLocalId
      $result.replyLocalId = [string]$last[0].replyLocalId
      $result.code = [string]$last[0].code
    }
    if ($result.healthy -eq $true -and $result.runId) {
      $summary = Read-WatchdogStrictJson -Path (Join-Path (Join-Path (Join-Path $StateDir "model-e2e-probes") $result.runId) "summary.json")
      if ($null -ne $summary) {
        $proof = Test-ModelCanaryReceiptProof -Result $summary
        $result.receiptsVerified = [bool]$proof.verified
        $result.threadId = [string]$summary.threadId
        $result.turnId = [string]$summary.turnId
        $result.cursorCommittedAt = [string]$proof.cursorCommittedAt
      }
      if (-not $result.receiptsVerified) {
        $result.healthy = $false
        $result.status = "invalid"
        $result.action = "proof_invalid"
        $result.error = "the last healthy model E2E run is missing its complete bound receipt set"
        $result.detail = "persisted model E2E success proof is incomplete"
        $result.routineFailureActive = $result.lastReason -eq "routine"
      }
    }
  } catch {
    $result.healthy = $false
    $result.status = "invalid"
    $result.action = "schedule_invalid"
    $result.error = $_.Exception.Message
  }
  return $result
}

function Get-PipelineActivityHealth {
  param(
    [int]$ExpectedPid = 0,
    [string]$Path = $PipelineActivityFile,
    [int]$StaleAfterSeconds = 30,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )

  $result = [ordered]@{
    ready = $false
    healthy = $true
    idle = $false
    busy = $false
    pid = 0
    ageSeconds = $null
    activeTurnCount = 0
    turnGateCount = 0
    activeDeliveryCount = 0
    pendingInboundCount = 0
    lastUserInboundAt = ""
    userIdleSeconds = $null
    updatedAt = ""
    reason = "startup_pending"
  }
  if (-not (Test-Path -LiteralPath $Path)) {
    if ($ExpectedPid -gt 0) {
      $process = Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue
      if ($process -and (($Now.UtcDateTime - $process.StartTime.ToUniversalTime()).TotalSeconds -gt $StaleAfterSeconds)) {
        $result.healthy = $false
        $result.reason = "activity_snapshot_missing"
      }
    }
    return $result
  }
  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $parsed = [System.IO.File]::ReadAllText($Path, $strictUtf8) | ConvertFrom-Json
    $updatedAt = [DateTimeOffset]::MinValue
    if ([int]$parsed.version -ne 1 -or -not [DateTimeOffset]::TryParse([string]$parsed.updatedAt, [ref]$updatedAt)) {
      throw "activity snapshot schema is invalid"
    }
    $result.pid = [Math]::Max(0, [int]$parsed.pid)
    $result.updatedAt = $updatedAt.ToUniversalTime().ToString("o")
    $result.ageSeconds = [long][Math]::Max(0, [Math]::Floor(($Now.ToUniversalTime() - $updatedAt.ToUniversalTime()).TotalSeconds))
    $result.activeTurnCount = [Math]::Max(0, [int]$parsed.activeTurnCount)
    $result.turnGateCount = [Math]::Max(0, [int]$parsed.turnGateCount)
    $result.activeDeliveryCount = [Math]::Max(0, [int]$parsed.activeDeliveryCount)
    $result.pendingInboundCount = [Math]::Max(0, [int]$parsed.pendingInboundCount)
    $lastUserInboundAt = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$parsed.lastUserInboundAt, [ref]$lastUserInboundAt)) {
      $result.lastUserInboundAt = $lastUserInboundAt.ToUniversalTime().ToString("o")
      $result.userIdleSeconds = [long][Math]::Max(0, [Math]::Floor(($Now.ToUniversalTime() - $lastUserInboundAt.ToUniversalTime()).TotalSeconds))
    }
    $result.ready = $ExpectedPid -gt 0 -and $result.pid -eq $ExpectedPid
    $result.busy = ($result.activeTurnCount + $result.turnGateCount + $result.activeDeliveryCount + $result.pendingInboundCount) -gt 0
    $result.idle = $result.ready -and -not $result.busy
    $result.healthy = $result.ready -and $result.ageSeconds -le [Math]::Max(10, $StaleAfterSeconds)
    $result.reason = if (-not $result.ready) {
      "activity_pid_mismatch"
    } elseif (-not $result.healthy) {
      "activity_snapshot_stale"
    } elseif ($result.busy) {
      "busy"
    } else {
      ""
    }
  } catch {
    $result.healthy = $false
    $result.reason = "activity_snapshot_invalid"
  }
  return $result
}

function Get-DesktopInputIdleState {
  param([int]$QuietSeconds = $CanaryDesktopQuietSeconds)

  $threshold = [Math]::Max(300, $QuietSeconds)
  $result = [ordered]@{
    ready = $false
    idle = $false
    desktopIdleSeconds = $null
    thresholdSeconds = $threshold
    reason = "desktop_input_unavailable"
  }
  try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
      $result.reason = "desktop_input_unsupported"
      return $result
    }
    if (-not ("CyberbossWatchdogNativeMethods" -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CyberbossWatchdogNativeMethods
{
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll", SetLastError = false)]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    public static extern ulong GetTickCount64();
}
'@
    }
    $info = New-Object "CyberbossWatchdogNativeMethods+LASTINPUTINFO"
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][CyberbossWatchdogNativeMethods+LASTINPUTINFO])
    if (-not [CyberbossWatchdogNativeMethods]::GetLastInputInfo([ref]$info)) {
      return $result
    }

    # LASTINPUTINFO uses the low 32 bits of the system tick counter and wraps
    # about every 49.7 days. Compare it with the low 32 bits of GetTickCount64.
    $currentTick = [uint64]([CyberbossWatchdogNativeMethods]::GetTickCount64() -band 0xffffffffL)
    $lastTick = [uint64]$info.dwTime
    $elapsedMs = if ($currentTick -ge $lastTick) {
      $currentTick - $lastTick
    } else {
      (0x100000000L + $currentTick) - $lastTick
    }
    $result.desktopIdleSeconds = [long][Math]::Max(0, [Math]::Floor($elapsedMs / 1000))
    $result.ready = $true
    $result.idle = $result.desktopIdleSeconds -ge $threshold
    $result.reason = if ($result.idle) { "" } else { "desktop_recent_input" }
  } catch {
    $result.reason = "desktop_input_unavailable"
  }
  return $result
}

function Get-CanaryTargetConfigurationFailure {
  if (-not $WeFlowCanaryTargetConflict) { return $null }
  return [ordered]@{
    healthy = $false
    status = "config_error"
    action = "failed"
    attempted = $true
    repairable = $false
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    code = "CANARY_TARGET_CONFLICT"
    error = "the canary talker must differ from the primary WeFlow inbox talker"
    detail = "canary target isolation validation failed before runner execution"
  }
}

function Test-CanaryPrerequisites {
  param([Parameter(Mandatory = $true)]$Snapshot)
  return $Snapshot.cyberboss.alive `
    -and $Snapshot.appServer.ready `
    -and $Snapshot.weflow.ready `
    -and $Snapshot.uiaBridge.ready `
    -and $Snapshot.weixin.alive `
    -and $Snapshot.sendSource -eq "azzy" `
    -and $Snapshot.activity.ready `
    -and $Snapshot.activity.healthy
}

function Invoke-CanaryCheck {
  param(
    [switch]$Force,
    [string]$Reason = "routine",
    [string]$DemandKey = ""
  )

  $configurationFailure = Get-CanaryTargetConfigurationFailure
  if ($null -ne $configurationFailure) { return $configurationFailure }
  if (-not (Test-Path -LiteralPath $CanaryScript)) {
    return [ordered]@{ healthy = $false; status = "error"; action = "error"; attempted = $true; repairable = $false; error = "canary runner is missing" }
  }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $node) {
    return [ordered]@{ healthy = $false; status = "error"; action = "error"; attempted = $true; repairable = $false; error = "node executable is missing" }
  }
  $arguments = @($CanaryScript, "--state-dir", $StateDir, "--reason", $Reason)
  if ($Force) {
    $arguments += "--force"
    if ($DemandKey) { $arguments += @("--demand-key", $DemandKey) }
  }
  try {
    $output = @(& $node.Source @arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $jsonText = ($output | ForEach-Object { [string]$_ }) -join "`n"
    $parsed = $jsonText.Trim() | ConvertFrom-Json
    $action = [string]$parsed.action
    $healthy = if ($null -eq $parsed.PSObject.Properties["healthy"] `
      -or $null -eq $parsed.healthy) {
      $null
    } else {
      [bool]$parsed.healthy
    }
    if ($action -in $CanaryUnknownHealthActions) {
      # A target change invalidates every result belonging to the old talker,
      # even if an older runner accidentally echoed that prior boolean.
      $healthy = $null
    }
    $hasExplicitRepairability = $null -ne $parsed.PSObject.Properties["repairable"]
    $hasExplicitAttempted = $null -ne $parsed.PSObject.Properties["attempted"]
    return [ordered]@{
      healthy = $healthy
      status = if ($action -in $CanaryDeferredActions -or $null -eq $healthy) {
        "deferred"
      } elseif ($healthy -eq $true) {
        "healthy"
      } else {
        "failed"
      }
      action = $action
      attempted = if ($hasExplicitAttempted) {
        [bool]$parsed.attempted
      } elseif ($action -in $CanaryDeferredActions) {
        $false
      } else {
        $action -in @("verified", "failed", "error")
      }
      repairable = if ($hasExplicitRepairability) { [bool]$parsed.repairable } else { $action -eq "failed" }
      exitCode = $exitCode
      runId = if ($parsed.runId) { [string]$parsed.runId } else { [string]$parsed.lastRunId }
      triggerLocalId = [string]$parsed.triggerLocalId
      replyLocalId = [string]$parsed.replyLocalId
      quietWindowMs = [Math]::Max(0, [int]$parsed.quietWindowMs)
      cursorCommittedAt = [string]$parsed.cursorCommittedAt
      checkedAt = [string]$parsed.checkedAt
      lastSuccessAt = [string]$parsed.lastSuccessAt
      nextDueAt = [string]$parsed.nextDueAt
      consecutiveFailures = [Math]::Max(0, [int]$parsed.consecutiveFailures)
      code = [string]$parsed.code
      error = [string]$parsed.error
      detail = [string]$parsed.detail
    }
  } catch {
    return [ordered]@{
      healthy = $false
      status = "error"
      action = "error"
      attempted = $true
      repairable = $false
      exitCode = 1
      error = $_.Exception.Message
      detail = "canary runner output was unavailable"
    }
  }
}

function Invoke-ModelCanaryCheck {
  param([string]$DemandKey = "")

  if (-not $ModelCanaryEnabled) { return Read-ModelCanaryStatus }
  if (-not (Test-Path -LiteralPath $ModelCanaryScript)) {
    return [ordered]@{
      enabled = $true; healthy = $false; status = "error"; action = "error"
      attempted = $false; repairable = $false; confirmedFailure = $false
      routineConsecutiveFailures = 0; receiptsVerified = $false
      code = "MODEL_CANARY_RUNNER_MISSING"; error = "model E2E runner is missing"
      detail = "model E2E runner was unavailable before dispatch"
    }
  }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $node) {
    return [ordered]@{
      enabled = $true; healthy = $false; status = "error"; action = "error"
      attempted = $false; repairable = $false; confirmedFailure = $false
      routineConsecutiveFailures = 0; receiptsVerified = $false
      code = "MODEL_CANARY_NODE_MISSING"; error = "node executable is missing"
      detail = "model E2E runner was unavailable before dispatch"
    }
  }

  $arguments = @($ModelCanaryScript, "--state-dir", $StateDir)
  if (-not [string]::IsNullOrWhiteSpace($DemandKey)) {
    $arguments += @("--demand-key", $DemandKey.Trim())
  }
  try {
    $output = @(& $node.Source @arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $jsonText = ($output | ForEach-Object { [string]$_ }) -join "`n"
    $parsed = $jsonText.Trim() | ConvertFrom-Json
    if ($null -eq $parsed -or [string]$parsed.mode -ne "model_e2e") {
      throw "model E2E runner output schema is invalid"
    }
    $action = [string]$parsed.action
    $healthy = if ($null -eq $parsed.PSObject.Properties["healthy"] -or $null -eq $parsed.healthy) {
      $null
    } else {
      [bool]$parsed.healthy
    }
    $hasAttempted = $null -ne $parsed.PSObject.Properties["attempted"]
    $attempted = if ($hasAttempted) { [bool]$parsed.attempted } else { $action -in @("verified", "failed") }
    $schedule = Read-WatchdogStrictJson -Path $WatchdogModelCanaryState
    $routineFailures = [Math]::Max(0, [int](Get-ModelRoutineConsecutiveFailures -Schedule $schedule))
    $result = [ordered]@{
      enabled = $true
      healthy = $healthy
      status = if ($action -in $ModelCanaryDeferredActions -or $null -eq $healthy) {
        "deferred"
      } elseif ($healthy -eq $true) {
        "healthy"
      } else {
        "failed"
      }
      action = $action
      attempted = $attempted
      repairable = $false
      exitCode = $exitCode
      confirmedFailure = $routineFailures -ge $RequiredFailureConfirmations
      routineFailureActive = $healthy -eq $false `
        -and ([string]$schedule.lastReason).Trim().ToLowerInvariant() -eq "routine"
      runnerConfirmedFailure = [bool]$parsed.confirmedFailure
      routineConsecutiveFailures = $routineFailures
      consecutiveFailures = [Math]::Max(0, [int]$parsed.consecutiveFailures)
      runId = if ($parsed.runId) { [string]$parsed.runId } else { [string]$parsed.lastRunId }
      reason = [string]$parsed.reason
      lastReason = [string]$schedule.lastReason
      triggerLocalId = [string]$parsed.triggerLocalId
      replyLocalId = [string]$parsed.replyLocalId
      threadId = [string]$parsed.threadId
      turnId = [string]$parsed.turnId
      cursorCommittedAt = [string]$parsed.cursorCommittedAt
      receiptsVerified = $false
      checkedAt = [string]$parsed.checkedAt
      lastSuccessAt = [string]$parsed.lastSuccessAt
      nextDueAt = [string]$parsed.nextDueAt
      code = [string]$parsed.code
      error = [string]$parsed.error
      detail = [string]$parsed.detail
    }
    if ($action -eq "verified") {
      $proof = Test-ModelCanaryReceiptProof -Result $parsed
      if (-not $proof.verified) {
        $result.healthy = $false
        $result.status = "failed"
        $result.action = "failed"
        $result.attempted = $true
        $result.code = "MODEL_CANARY_PROOF_INCOMPLETE"
        $result.error = [string]$proof.detail
        $result.detail = "runner claimed verification without a complete bound receipt set"
      } else {
        $result.receiptsVerified = $true
        $result.cursorCommittedAt = [string]$proof.cursorCommittedAt
      }
    } elseif ($healthy -eq $true) {
      $persistedProof = Read-ModelCanaryStatus
      if ($persistedProof.healthy -ne $true -or $persistedProof.receiptsVerified -ne $true) {
        $result.healthy = $false
        $result.status = "failed"
        $result.action = "proof_invalid"
        $result.code = "MODEL_CANARY_PROOF_INCOMPLETE"
        $result.error = "the persisted healthy model E2E result has no complete bound receipt set"
        $result.detail = "model E2E scheduler returned healthy without durable proof"
        $result.routineFailureActive = ([string]$schedule.lastReason).Trim().ToLowerInvariant() -eq "routine"
      } else {
        $result.receiptsVerified = $true
        $result.runId = [string]$persistedProof.runId
        $result.triggerLocalId = [string]$persistedProof.triggerLocalId
        $result.replyLocalId = [string]$persistedProof.replyLocalId
        $result.threadId = [string]$persistedProof.threadId
        $result.turnId = [string]$persistedProof.turnId
        $result.cursorCommittedAt = [string]$persistedProof.cursorCommittedAt
      }
    }
    return $result
  } catch {
    $persisted = Read-ModelCanaryStatus
    return [ordered]@{
      enabled = $true
      healthy = $false
      status = "error"
      action = "error"
      attempted = $false
      repairable = $false
      confirmedFailure = [bool]$persisted.confirmedFailure
      routineFailureActive = [bool]$persisted.routineFailureActive
      routineConsecutiveFailures = [Math]::Max(0, [int]$persisted.routineConsecutiveFailures)
      receiptsVerified = $false
      code = "MODEL_CANARY_RUNNER_OUTPUT_INVALID"
      error = $_.Exception.Message
      detail = "model E2E runner output was unavailable"
    }
  }
}

function Update-RecoveryCanaryState {
  param(
    [Parameter(Mandatory = $true)]$RecoveryState,
    [Parameter(Mandatory = $true)]$Canary
  )

  $RecoveryState.lastCanaryStatus = [string]$Canary.status
  if ($Canary.runId) { $RecoveryState.lastCanaryRunId = [string]$Canary.runId }
  if ($Canary.attempted) {
    $attemptAt = if ($Canary.checkedAt) { [string]$Canary.checkedAt } else { (Get-Date).ToUniversalTime().ToString("o") }
    $RecoveryState.lastCanaryAttemptAt = $attemptAt
    if ($Canary.healthy -eq $true) {
      $RecoveryState.lastCanarySuccessAt = $attemptAt
      $RecoveryState.lastCanaryError = ""
      $RecoveryState.canaryConsecutiveFailures = 0
    } elseif ($Canary.healthy -eq $false) {
      $RecoveryState.lastCanaryFailureAt = $attemptAt
      $RecoveryState.lastCanaryError = if ($Canary.error) { [string]$Canary.error } else { [string]$Canary.detail }
      $RecoveryState.canaryConsecutiveFailures = [Math]::Min(100, [int]$RecoveryState.canaryConsecutiveFailures + 1)
    }
  }
}

function Set-WatchdogSnapshotProperty {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Value
  )

  if ($Snapshot -is [System.Collections.IDictionary]) {
    $Snapshot[$Name] = $Value
  } elseif ($null -ne $Snapshot.PSObject.Properties[$Name]) {
    $Snapshot.$Name = $Value
  } else {
    $Snapshot | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Test-WatchdogMember {
  param(
    $Value,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Value) { return $false }
  if ($Value -is [System.Collections.IDictionary]) { return $Value.Contains($Name) }
  return $null -ne $Value.PSObject.Properties[$Name]
}

function Set-SnapshotCanaryResult {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)]$Canary,
    [switch]$Deferred
  )

  if ($Deferred) {
    $Canary.status = "deferred"
    $Canary.healthy = $null
    $Canary.attempted = $false
    $Canary.detail = "canary result deferred while durable work is actively draining"
  }
  Set-WatchdogSnapshotProperty -Snapshot $Snapshot -Name "canary" -Value $Canary
  Set-WatchdogSnapshotProperty -Snapshot $Snapshot -Name "transportE2E" -Value $Canary
  $modelSnapshot = $null
  if ($Snapshot -is [System.Collections.IDictionary]) {
    if ($Snapshot.Contains("modelE2E")) {
      $modelSnapshot = $Snapshot["modelE2E"]
    }
  } elseif ($null -ne $Snapshot.PSObject.Properties["modelE2E"]) {
    $modelSnapshot = $Snapshot.modelE2E
  }
  $confirmedModelFailure = $ModelCanaryEnabled `
    -and $null -ne $modelSnapshot `
    -and $modelSnapshot.confirmedFailure -eq $true
  $Snapshot.healthy = [bool]((Test-SnapshotInfrastructureHealthy -Snapshot $Snapshot) `
    -and $Canary.healthy -eq $true `
    -and -not $confirmedModelFailure)
}

function Set-SnapshotModelCanaryResult {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)]$ModelCanary
  )

  $priorModelCanary = $null
  if ($Snapshot -is [System.Collections.IDictionary]) {
    if ($Snapshot.Contains("modelE2E")) { $priorModelCanary = $Snapshot["modelE2E"] }
  } elseif ($null -ne $Snapshot.PSObject.Properties["modelE2E"]) {
    $priorModelCanary = $Snapshot.modelE2E
  }
  $incomingDidNotComplete = $ModelCanary.healthy -ne $true `
    -and ([string]$ModelCanary.action -in $ModelCanaryDeferredActions `
      -or $ModelCanary.attempted -ne $true)
  $confirmedSource = if ($ModelCanary.confirmedFailure -eq $true) {
    $ModelCanary
  } elseif ($null -ne $priorModelCanary -and $priorModelCanary.confirmedFailure -eq $true) {
    $priorModelCanary
  } else {
    $null
  }
  if ($incomingDidNotComplete -and $null -ne $confirmedSource) {
    # A scheduler collision/target wait has no new model evidence. Preserve the
    # last completed two-failure routine verdict instead of replacing it with
    # unknown health and accidentally authorizing a generic stack restart.
    Set-WatchdogSnapshotProperty -Snapshot $ModelCanary -Name "healthy" -Value $false
    Set-WatchdogSnapshotProperty -Snapshot $ModelCanary -Name "confirmedFailure" -Value $true
    Set-WatchdogSnapshotProperty -Snapshot $ModelCanary -Name "routineFailureActive" -Value $true
    $failureCount = [Math]::Max(
      [Math]::Max(0, [int]$ModelCanary.routineConsecutiveFailures),
      [Math]::Max(0, [int]$confirmedSource.routineConsecutiveFailures)
    )
    Set-WatchdogSnapshotProperty -Snapshot $ModelCanary -Name "routineConsecutiveFailures" -Value $failureCount
    if ([string]::IsNullOrWhiteSpace([string]$ModelCanary.lastReason)) {
      Set-WatchdogSnapshotProperty -Snapshot $ModelCanary -Name "lastReason" -Value ([string]$confirmedSource.lastReason)
    }
    if ([string]::IsNullOrWhiteSpace([string]$ModelCanary.nextDueAt)) {
      Set-WatchdogSnapshotProperty -Snapshot $ModelCanary -Name "nextDueAt" -Value ([string]$confirmedSource.nextDueAt)
    }
  }

  Set-WatchdogSnapshotProperty -Snapshot $Snapshot -Name "modelE2E" -Value $ModelCanary
  # Model E2E is independently non-repairable. Only two completed routine
  # failures downgrade top health; disabled, unknown, unconfirmed deferred,
  # explicit, and single diagnostic failures never authorize transport repair.
  if ($ModelCanaryEnabled -and $ModelCanary.confirmedFailure -eq $true) {
    $Snapshot.healthy = $false
  }
}

function Test-SnapshotInfrastructureHealthy {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [switch]$IgnoreMainDelivery,
    [switch]$IgnoreReplyObligations
  )
  $mainDeliveryHealthy = $IgnoreMainDelivery `
    -or -not (Test-WatchdogMember -Value $Snapshot -Name "mainDelivery") `
    -or [bool]$Snapshot.mainDelivery.healthy
  $replyObligationsHealthy = $IgnoreReplyObligations `
    -or -not (Test-WatchdogMember -Value $Snapshot -Name "replyObligations") `
    -or [bool]$Snapshot.replyObligations.healthy
  $appServerAlive = -not (Test-WatchdogMember -Value $Snapshot.appServer -Name "alive") `
    -or [bool]$Snapshot.appServer.alive
  $uiaAlive = -not (Test-WatchdogMember -Value $Snapshot.uiaBridge -Name "alive") `
    -or [bool]$Snapshot.uiaBridge.alive
  $uiaHealth = -not (Test-WatchdogMember -Value $Snapshot.uiaBridge -Name "health") `
    -or [bool]$Snapshot.uiaBridge.health
  return $Snapshot.cyberboss.alive `
    -and $appServerAlive `
    -and $Snapshot.appServer.ready `
    -and $Snapshot.weflow.ready `
    -and $uiaAlive `
    -and $uiaHealth `
    -and $Snapshot.uiaBridge.ready `
    -and $Snapshot.weixin.alive `
    -and $Snapshot.sendSource -eq "azzy" `
    -and $Snapshot.inboxQueue.healthy `
    -and $Snapshot.pendingInbound.healthy `
    -and $Snapshot.deferredReplies.healthy `
    -and $replyObligationsHealthy `
    -and $mainDeliveryHealthy `
    -and $Snapshot.activity.healthy
}

function Get-ModelCanaryIsolationDisposition {
  param([Parameter(Mandatory = $true)]$Snapshot)

  $modelCanary = if ($Snapshot -is [System.Collections.IDictionary]) {
    if ($Snapshot.Contains("modelE2E")) { $Snapshot["modelE2E"] } else { $null }
  } elseif ($null -ne $Snapshot.PSObject.Properties["modelE2E"]) {
    $Snapshot.modelE2E
  } else {
    $null
  }
  if (-not $ModelCanaryEnabled `
    -or $null -eq $modelCanary `
    -or $modelCanary.confirmedFailure -ne $true) {
    return $null
  }
  # Let independently observed infrastructure/transport faults follow their
  # targeted policy. With no such fault, a persistent model verdict is always
  # non-restartable, regardless of this turn's deferred healthy/action fields.
  if (-not (Test-SnapshotInfrastructureHealthy -Snapshot $Snapshot) `
    -or $Snapshot.canary.healthy -eq $false) {
    return $null
  }
  return [ordered]@{
    action = "pipeline_blocked"
    repairable = $false
    exitCode = 2
    detail = "model E2E pipeline blocked after $($modelCanary.routineConsecutiveFailures) consecutive routine failures; currentAction=$($modelCanary.action); code=$($modelCanary.code); nextDue=$($modelCanary.nextDueAt); repair=false"
  }
}

function Test-CanaryVerificationPending {
  param([Parameter(Mandatory = $true)]$Snapshot)

  # Unknown is a real third state: the pipeline may be operational, but the
  # configured exact Azzy target has not produced a completed proof yet.
  return (Test-SnapshotInfrastructureHealthy -Snapshot $Snapshot) `
    -and $null -eq $Snapshot.canary.healthy
}

function Get-CanaryIdleGateBlockers {
  param([Parameter(Mandatory = $true)]$Snapshot)

  $blockers = [System.Collections.Generic.List[string]]::new()
  if (-not $Snapshot.cyberboss.alive) { $blockers.Add("cyberboss_unavailable") }
  if (-not $Snapshot.appServer.ready) { $blockers.Add("app_server_unavailable") }
  if (-not $Snapshot.weflow.ready) { $blockers.Add("weflow_unavailable") }
  if (-not $Snapshot.uiaBridge.ready) { $blockers.Add("uia_unavailable") }
  if (-not $Snapshot.weixin.alive) { $blockers.Add("weixin_unavailable") }
  if ($Snapshot.sendSource -ne "azzy") { $blockers.Add("send_source_not_azzy") }
  if (-not $Snapshot.inboxQueue.healthy) { $blockers.Add("inbox_queue_unhealthy") }
  if (-not $Snapshot.pendingInbound.healthy) { $blockers.Add("pending_inbound_unhealthy") }
  if (-not $Snapshot.deferredReplies.healthy) { $blockers.Add("deferred_replies_unhealthy") }
  if ((Test-WatchdogMember -Value $Snapshot -Name "replyObligations") `
    -and -not $Snapshot.replyObligations.healthy) {
    $blockers.Add("reply_obligations_unhealthy")
  }
  if (-not $Snapshot.inboxQueue.outgoingPoll.ready) {
    $blockers.Add("poll_not_ready")
  } elseif (-not $Snapshot.inboxQueue.outgoingPoll.healthy) {
    $blockers.Add("poll_unhealthy")
  }
  if ([int]$Snapshot.inboxQueue.pendingCount -ne 0) { $blockers.Add("inbox_queue_pending") }
  if ([int]$Snapshot.pendingInbound.pendingCount -ne 0) { $blockers.Add("pending_inbound_pending") }
  if ([int]$Snapshot.deferredReplies.pendingCount -ne 0) { $blockers.Add("deferred_replies_pending") }
  if ((Test-WatchdogMember -Value $Snapshot -Name "replyObligations") `
    -and [int]$Snapshot.replyObligations.openCount -ne 0) {
    $blockers.Add("reply_obligations_pending")
  }
  if (-not $Snapshot.activity.ready -or -not $Snapshot.activity.healthy) {
    $blockers.Add("activity_unavailable")
  }
  if (-not $Snapshot.activity.idle `
    -or [int]$Snapshot.activity.activeTurnCount -ne 0 `
    -or [int]$Snapshot.activity.turnGateCount -ne 0 `
    -or [int]$Snapshot.activity.activeDeliveryCount -ne 0 `
    -or [int]$Snapshot.activity.pendingInboundCount -ne 0) {
    $blockers.Add("activity_busy")
  }
  if ($null -ne $Snapshot.activity.userIdleSeconds `
    -and [long]$Snapshot.activity.userIdleSeconds -lt $CanaryUserQuietSeconds) {
    $blockers.Add("user_recent")
  }
  if ($null -eq $Snapshot.desktopInput -or -not [bool]$Snapshot.desktopInput.ready) {
    $blockers.Add("desktop_input_unavailable")
  } elseif (-not [bool]$Snapshot.desktopInput.idle `
    -or $null -eq $Snapshot.desktopInput.desktopIdleSeconds `
    -or [long]$Snapshot.desktopInput.desktopIdleSeconds -lt $CanaryDesktopQuietSeconds) {
    $blockers.Add("desktop_recent_input")
  }
  return @($blockers | Select-Object -Unique)
}

function Test-CanaryIdleGate {
  param([Parameter(Mandatory = $true)]$Snapshot)
  return (Test-CanaryPrerequisites -Snapshot $Snapshot) `
    -and $Snapshot.inboxQueue.outgoingPoll.ready `
    -and $Snapshot.inboxQueue.outgoingPoll.healthy `
    -and $Snapshot.inboxQueue.healthy `
    -and $Snapshot.pendingInbound.healthy `
    -and $Snapshot.deferredReplies.healthy `
    -and (-not (Test-WatchdogMember -Value $Snapshot -Name "replyObligations") `
      -or ($Snapshot.replyObligations.healthy `
        -and [int]$Snapshot.replyObligations.openCount -eq 0)) `
    -and [int]$Snapshot.inboxQueue.pendingCount -eq 0 `
    -and [int]$Snapshot.pendingInbound.pendingCount -eq 0 `
    -and [int]$Snapshot.deferredReplies.pendingCount -eq 0 `
    -and $Snapshot.activity.idle `
    -and [int]$Snapshot.activity.activeTurnCount -eq 0 `
    -and [int]$Snapshot.activity.turnGateCount -eq 0 `
    -and [int]$Snapshot.activity.activeDeliveryCount -eq 0 `
    -and [int]$Snapshot.activity.pendingInboundCount -eq 0 `
    -and ($null -eq $Snapshot.activity.userIdleSeconds `
      -or [long]$Snapshot.activity.userIdleSeconds -ge $CanaryUserQuietSeconds) `
    -and (Test-DesktopInputIdleGate -Snapshot $Snapshot)
}

function Test-ModelCanaryIdleGate {
  param([Parameter(Mandatory = $true)]$Snapshot)

  $transport = if (Test-WatchdogMember -Value $Snapshot -Name "transportE2E") {
    $Snapshot.transportE2E
  } else {
    $Snapshot.canary
  }
  return $ModelCanaryEnabled `
    -and $null -ne $transport `
    -and $transport.healthy -eq $true `
    -and (Test-CanaryIdleGate -Snapshot $Snapshot)
}

function Get-ModelCanaryIdleGateBlockers {
  param([Parameter(Mandatory = $true)]$Snapshot)

  $blockers = [System.Collections.Generic.List[string]]::new()
  foreach ($item in @(Get-CanaryIdleGateBlockers -Snapshot $Snapshot)) { $blockers.Add($item) }
  $transport = if (Test-WatchdogMember -Value $Snapshot -Name "transportE2E") {
    $Snapshot.transportE2E
  } else {
    $Snapshot.canary
  }
  if ($null -eq $transport -or $transport.healthy -ne $true) {
    $blockers.Add("transport_e2e_unverified")
  }
  return @($blockers | Select-Object -Unique)
}

function Test-DesktopInputIdleGate {
  param([Parameter(Mandatory = $true)]$Snapshot)

  return $null -ne $Snapshot.desktopInput `
    -and [bool]$Snapshot.desktopInput.ready `
    -and [bool]$Snapshot.desktopInput.idle `
    -and $null -ne $Snapshot.desktopInput.desktopIdleSeconds `
    -and [long]$Snapshot.desktopInput.desktopIdleSeconds -ge $CanaryDesktopQuietSeconds
}

function Test-PipelineRepairIdleGate {
  param([Parameter(Mandatory = $true)]$Snapshot)

  $serviceDead = -not $Snapshot.cyberboss.alive
  if ($serviceDead) {
    # There is no live turn left to interrupt. Durable queues survive the
    # targeted restart, and requiring a fresh activity file from a dead process
    # would otherwise deadlock recovery permanently.
    return $true
  }
  $deferredWaitingForInbound = (Test-WatchdogMember -Value $Snapshot.deferredReplies -Name "attentionRequired") `
    -and [bool]$Snapshot.deferredReplies.attentionRequired `
    -and [string]$Snapshot.deferredReplies.reason -eq "waiting_for_inbound"
  $freshQueueWork = ([int]$Snapshot.inboxQueue.pendingCount -gt 0 -and $Snapshot.inboxQueue.healthy) `
    -or ([int]$Snapshot.pendingInbound.pendingCount -gt 0 -and $Snapshot.pendingInbound.healthy) `
    -or ([int]$Snapshot.deferredReplies.pendingCount -gt 0 `
      -and $Snapshot.deferredReplies.healthy `
      -and -not $deferredWaitingForInbound) `
    -or ((Test-WatchdogMember -Value $Snapshot -Name "replyObligations") `
      -and [int]$Snapshot.replyObligations.openCount -gt 0 `
      -and $Snapshot.replyObligations.healthy)

  # A dead App Server cannot advance a gate which has no active turn,
  # delivery, or pending inbound work behind it.  Treat that exact shape as a
  # stranded in-memory gate rather than permanent activity: the durable queues
  # remain authoritative across the guarded restart.  Real active work (any
  # activeTurn/delivery/pending count) continues to block repair.
  $strandedGateOnDeadAppServer = -not [bool]$Snapshot.appServer.ready `
    -and $Snapshot.activity.ready `
    -and $Snapshot.activity.healthy `
    -and [int]$Snapshot.activity.turnGateCount -gt 0 `
    -and [int]$Snapshot.activity.activeTurnCount -eq 0 `
    -and [int]$Snapshot.activity.activeDeliveryCount -eq 0 `
    -and [int]$Snapshot.activity.pendingInboundCount -eq 0 `
    -and -not $freshQueueWork `
    -and ($null -eq $Snapshot.activity.userIdleSeconds `
      -or [long]$Snapshot.activity.userIdleSeconds -ge $CanaryUserQuietSeconds)
  if ($strandedGateOnDeadAppServer) {
    return $true
  }
  return $Snapshot.activity.ready `
    -and $Snapshot.activity.healthy `
    -and $Snapshot.activity.idle `
    -and ($Snapshot.inboxQueue.outgoingPoll.ready -or -not $Snapshot.inboxQueue.healthy) `
    -and -not $freshQueueWork `
    -and ($null -eq $Snapshot.activity.userIdleSeconds `
      -or [long]$Snapshot.activity.userIdleSeconds -ge $CanaryUserQuietSeconds)
}

function Test-CanaryProbeDeferredByActivity {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [string]$ProbeCode = ""
  )

  $replyObligationOpenCount = if (Test-WatchdogMember -Value $Snapshot -Name "replyObligations") {
    [int]$Snapshot.replyObligations.openCount
  } else {
    0
  }
  $freshQueueWork = ([int]$Snapshot.inboxQueue.pendingCount `
    + [int]$Snapshot.pendingInbound.pendingCount `
    + [int]$Snapshot.deferredReplies.pendingCount `
    + $replyObligationOpenCount) -gt 0 `
    -and $Snapshot.inboxQueue.healthy `
    -and $Snapshot.pendingInbound.healthy `
    -and $Snapshot.deferredReplies.healthy `
    -and (-not (Test-WatchdogMember -Value $Snapshot -Name "replyObligations") `
      -or $Snapshot.replyObligations.healthy)
  $recentUserActivity = $null -ne $Snapshot.activity.userIdleSeconds `
    -and [long]$Snapshot.activity.userIdleSeconds -lt $CanaryUserQuietSeconds
  $desktopBecameActive = $null -ne $Snapshot.desktopInput `
    -and [bool]$Snapshot.desktopInput.ready `
    -and -not [bool]$Snapshot.desktopInput.idle
  return $freshQueueWork `
    -or $Snapshot.activity.busy `
    -or $recentUserActivity `
    -or $desktopBecameActive `
    -or $ProbeCode -eq "CANARY_DESKTOP_ACTIVE"
}

function Get-HealthSnapshot {
  $bridgePid = Read-PidFile -Path $BridgePidFile
  $appServerPid = Read-PidFile -Path $AppServerPidFile
  $uiaPid = Read-PidFile -Path $UiaPidFile
  $bridgeProcessAlive = Test-PidAlive -PidValue $bridgePid
  $appServerProcessAlive = Test-PidAlive -PidValue $appServerPid
  $uiaProcessAlive = Test-PidAlive -PidValue $uiaPid
  $bridgeAlive = Test-VerifiedPidAlive -PidValue $bridgePid -CommandPattern $BridgeCommandPattern
  $appServerAlive = Test-VerifiedPidAlive -PidValue $appServerPid -CommandPattern $AppServerCommandPattern
  $uiaAlive = Test-VerifiedPidAlive -PidValue $uiaPid -CommandPattern $UiaCommandPattern
  $bridgeUptimeSeconds = -1
  if ($bridgeAlive) {
    $bridgeProcess = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
    if ($bridgeProcess) {
      $bridgeUptimeSeconds = [Math]::Max(
        0,
        [Math]::Floor(((Get-Date).ToUniversalTime() - $bridgeProcess.StartTime.ToUniversalTime()).TotalSeconds)
      )
    }
  }
  $appReady = Invoke-JsonEndpoint -Uri "http://127.0.0.1:$SharedPort/readyz"
  $uiaProcess = Invoke-JsonEndpoint -Uri "$($UiaBaseUrl.TrimEnd('/'))/healthz"
  $uiaReady = Invoke-JsonEndpoint -Uri "$($UiaBaseUrl.TrimEnd('/'))/readyz"
  $sendSource = Invoke-JsonEndpoint -Uri "$($UiaBaseUrl.TrimEnd('/'))/api/send-source"
  $weFlow = Get-WeFlowFunctionalHealth
  $weixinAlive = $null -ne (Get-Process -Name "Weixin" -ErrorAction SilentlyContinue | Select-Object -First 1)
  $sourceName = if ($sendSource.Ok) { [string]$sendSource.Body.send_source } else { "" }
  $inboxQueue = Get-CombinedInboxQueueHealth `
    -ServiceAlive $bridgeAlive `
    -ServiceUptimeSeconds $bridgeUptimeSeconds
  $pendingInbound = Get-PendingInboundQueueHealth
  $deferredReplies = Get-DeferredReplyQueueHealth
  $replyObligations = Get-ReplyObligationHealth
  $mainDelivery = Get-MainDeliveryHealth
  $canary = Read-CanaryStatus
  $modelCanary = Read-ModelCanaryStatus
  $canaryConfigurationFailure = Get-CanaryTargetConfigurationFailure
  if ($null -ne $canaryConfigurationFailure) {
    $canary = $canaryConfigurationFailure
    # Health snapshots are observations; only Invoke-CanaryCheck records a
    # confirmed attempt after the idle gate has been satisfied.
    $canary.attempted = $false
  }
  $activity = Get-PipelineActivityHealth -ExpectedPid $bridgePid
  $desktopInput = Get-DesktopInputIdleState
  $healthy = $bridgeAlive `
    -and $appServerAlive `
    -and $uiaAlive `
    -and $appReady.Ok `
    -and $uiaProcess.Ok `
    -and $uiaReady.Ok `
    -and $weFlow.ready `
    -and $weixinAlive `
    -and $sourceName -eq "azzy" `
    -and $inboxQueue.healthy `
    -and $pendingInbound.healthy `
    -and $deferredReplies.healthy `
    -and $replyObligations.healthy `
    -and $mainDelivery.healthy `
    -and $activity.healthy `
    -and $canary.healthy -eq $true `
    -and (-not $ModelCanaryEnabled -or $modelCanary.confirmedFailure -ne $true)

  return [ordered]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    healthy = [bool]$healthy
    cyberboss = [ordered]@{ pid = $bridgePid; alive = [bool]$bridgeAlive; processAlive = [bool]$bridgeProcessAlive; identityVerified = [bool]$bridgeAlive }
    appServer = [ordered]@{ pid = $appServerPid; alive = [bool]$appServerAlive; processAlive = [bool]$appServerProcessAlive; identityVerified = [bool]$appServerAlive; ready = [bool]$appReady.Ok }
    weflow = $weFlow
    uiaBridge = [ordered]@{ pid = $uiaPid; alive = [bool]$uiaAlive; processAlive = [bool]$uiaProcessAlive; identityVerified = [bool]$uiaAlive; health = [bool]$uiaProcess.Ok; ready = [bool]$uiaReady.Ok }
    weixin = [ordered]@{ alive = [bool]$weixinAlive }
    sendSource = $sourceName
    inboxQueue = $inboxQueue
    pendingInbound = $pendingInbound
    deferredReplies = $deferredReplies
    replyObligations = $replyObligations
    mainDelivery = $mainDelivery
    activity = $activity
    desktopInput = $desktopInput
    desktopIdleSeconds = $desktopInput.desktopIdleSeconds
    desktopIdleReason = $desktopInput.reason
    canary = $canary
    transportE2E = $canary
    modelE2E = $modelCanary
  }
}

function Get-WatchdogRestartNotificationStatus {
  $result = [ordered]@{
    action = "none"
    pendingCount = 0
    awaitingRepairVerificationCount = 0
    cancelledCount = 0
    repairIdentity = ""
    repairMode = ""
    verified = $false
    localId = ""
    attemptCount = 0
    lastAttemptAt = ""
    activatedAt = ""
    verifiedAt = ""
    cancelledAt = ""
    cancelReason = ""
    lastError = ""
    targetTalker = $WeFlowInboxChat
  }
  $candidates = @($RestartNotificationState, "$RestartNotificationState.bak")
  if (-not @($candidates | Where-Object { Test-Path -LiteralPath $_ }).Count) { return $result }
  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $parsed = $null
    $candidateErrors = @()
    foreach ($candidate in $candidates) {
      if (-not (Test-Path -LiteralPath $candidate)) { continue }
      try {
        $candidatePayload = [System.IO.File]::ReadAllText($candidate, $strictUtf8) | ConvertFrom-Json
        if ([int]$candidatePayload.version -ne 1 -or $null -eq $candidatePayload.PSObject.Properties["notifications"]) {
          throw "restart notification state schema is invalid"
        }
        $parsed = $candidatePayload
        break
      } catch {
        $candidateErrors += "$(Split-Path -Leaf $candidate): $($_.Exception.Message)"
      }
    }
    if ($null -eq $parsed) { throw ($candidateErrors -join "; ") }
    $notifications = @($parsed.notifications)
    $pending = @($notifications | Where-Object {
      [string]$_.status -in @("pending", "uncertain_pending")
    })
    $awaiting = @($notifications | Where-Object {
      [string]$_.status -eq "awaiting_repair_verification"
    })
    $cancelled = @($notifications | Where-Object { [string]$_.status -eq "cancelled" })
    $result.pendingCount = $pending.Count
    $result.awaitingRepairVerificationCount = $awaiting.Count
    $result.cancelledCount = $cancelled.Count
    if ($notifications.Count -eq 0) { return $result }
    $latest = $notifications[-1]
    $result.action = [string]$latest.status
    $result.repairIdentity = [string]$latest.repairIdentity
    $result.repairMode = [string]$latest.repairMode
    $result.localId = [string]$latest.localId
    $result.verified = [string]$latest.status -eq "verified" -and $result.localId -match "^[1-9]\d*$"
    $result.attemptCount = [Math]::Max(0, [int]$latest.attemptCount)
    $result.lastAttemptAt = [string]$latest.lastAttemptAt
    $result.activatedAt = [string]$latest.activatedAt
    $result.verifiedAt = [string]$latest.verifiedAt
    $result.cancelledAt = [string]$latest.cancelledAt
    $result.cancelReason = [string]$latest.cancelReason
    $result.lastError = [string]$latest.lastError
    $result.targetTalker = [string]$latest.targetTalker
  } catch {
    $result.action = "state_error"
    $result.lastError = $_.Exception.Message
  }
  return $result
}

function Get-WatchdogRestartNotificationText {
  param(
    [Parameter(Mandatory = $true)][string]$RepairMode,
    [string[]]$Components = @()
  )

  $componentText = @($Components | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_)
  } | Select-Object -Unique) -join ","
  $suffix = if ($componentText) { "（组件：$componentText）" } else { "" }
  return "♻️ Cyberboss 心跳守护管家已启动 $RepairMode 修复流程$suffix。这是重启事件通知；当前修复结果以最新心跳状态为准。"
}

function Invoke-WatchdogRestartNotification {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("enqueue", "activate", "cancel", "dispatch", "drain")][string]$Action,
    [string]$RepairIdentity = "",
    [string]$RepairMode = "",
    [string[]]$Components = @(),
    [string]$CancelReason = ""
  )

  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node -or -not (Test-Path -LiteralPath $RestartNotificationScript)) {
    return [pscustomobject]@{
      action = "error"
      verified = $false
      error = "restart notification helper is unavailable"
    }
  }
  if ($Action -ne "drain" -and [string]::IsNullOrWhiteSpace($RepairIdentity)) {
    return [pscustomobject]@{
      action = "error"
      verified = $false
      error = "repair identity is required"
    }
  }
  if ($Action -eq "enqueue" -and [string]::IsNullOrWhiteSpace($RepairMode)) {
    return [pscustomobject]@{
      action = "error"
      verified = $false
      error = "repair mode is required when enqueueing a restart notification"
    }
  }

  $timeoutText = Get-ProjectEnvValue -Name "CYBERBOSS_WEFLOW_BRIDGE_TIMEOUT_MS"
  $timeoutMs = if ($timeoutText -match "^\d+$" -and [int]$timeoutText -gt 0) {
    [int]$timeoutText
  } else {
    30000
  }
  $request = [ordered]@{
    stateDir = $StateDir
    stateFile = $RestartNotificationState
    ledgerFile = $WeFlowMessageLedger
    config = [ordered]@{
      weflowBridgeBaseUrl = $UiaBaseUrl
      weflowBridgeTimeoutMs = $timeoutMs
    }
    requireDesktopIdleSeconds = 0
    primaryTalker = $WeFlowInboxChat
    primaryContact = $WeFlowInboxDisplayName
    canaryTalker = $WeFlowCanaryChat
  }
  if ($Action -ne "drain") {
    $request.repairIdentity = $RepairIdentity
  }
  if ($Action -eq "enqueue") {
    $request.repairMode = $RepairMode
    $request.components = @($Components)
    $request.text = Get-WatchdogRestartNotificationText -RepairMode $RepairMode -Components $Components
  }
  if ($Action -eq "cancel") {
    $request.cancelReason = $CancelReason
  }

  $requestFile = Join-Path $StateDir "cyberboss-watchdog-restart-notification.$PID.request.json"
  try {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $json = $request | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText(
      $requestFile,
      $json,
      [System.Text.UTF8Encoding]::new($false)
    )
    $output = @(& $node.Source $RestartNotificationScript --action $Action --request-file $requestFile 2>&1)
    $exitCode = $LASTEXITCODE
    $jsonText = ($output | ForEach-Object { [string]$_ }) -join "`n"
    $parsed = $jsonText.Trim() | ConvertFrom-Json
    if ($exitCode -ne 0 -or $null -eq $parsed) {
      throw "restart notification helper exited $exitCode"
    }
    return $parsed
  } catch {
    return [pscustomobject]@{
      action = "error"
      verified = $false
      error = $_.Exception.Message
    }
  } finally {
    Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
  }
}

function Save-Status {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [string]$Action = "none",
    [string]$Detail = "",
    $RecoveryState = $null,
    [string]$NextRepairAllowedAtOverride = "",
    [string]$AdditionalGuardConstraint = ""
  )

  $guard = $null
  if ($RecoveryState) {
    $gate = Get-RecoveryGate -State $RecoveryState
    $guard = [ordered]@{
      consecutiveFailures = [int]$RecoveryState.consecutiveFailures
      failureFingerprint = [string]$RecoveryState.failureFingerprint
      failureCount = [int]$RecoveryState.failureCount
      failureFirstSeenAt = [string]$RecoveryState.failureFirstSeenAt
      failureLastSeenAt = [string]$RecoveryState.failureLastSeenAt
      requiredConfirmations = $RequiredFailureConfirmations
      confirmationWindowMinutes = $FailureConfirmationWindowMinutes
      cooldownMinutes = $RepairCooldownMinutes
      maxRepairsPerHour = $MaxRepairsPerHour
      maxRepairsPerDay = $MaxRepairsPerDay
      repairsLastHour = $gate.repairsLastHour
      repairsLast24Hours = $gate.repairsLast24Hours
      nextRepairAllowedAt = if ($NextRepairAllowedAtOverride) { $NextRepairAllowedAtOverride } else { $gate.retryAt }
      activeConstraints = @(@($gate.constraints) + @($AdditionalGuardConstraint | Where-Object { $_ }))
      recoveryStateValid = [bool]$RecoveryState.recoveryStateValid
      recoveryStateSource = [string]$RecoveryState.recoveryStateSource
      recoveryStateError = [string]$RecoveryState.recoveryStateError
      lastRepairFailureFingerprint = [string]$RecoveryState.lastRepairFailureFingerprint
      lastRepairMode = [string]$RecoveryState.lastRepairMode
      lastRepairOutcome = [string]$RecoveryState.lastRepairOutcome
      ineffectiveRepairCount = [int]$RecoveryState.ineffectiveRepairCount
      currentRepairIdentity = [string]$RecoveryState.currentRepairIdentity
      canaryConsecutiveFailures = [int]$RecoveryState.canaryConsecutiveFailures
      lastCanaryAttemptAt = [string]$RecoveryState.lastCanaryAttemptAt
      lastCanarySuccessAt = [string]$RecoveryState.lastCanarySuccessAt
      lastCanaryFailureAt = [string]$RecoveryState.lastCanaryFailureAt
      lastCanaryRunId = [string]$RecoveryState.lastCanaryRunId
      lastCanaryStatus = [string]$RecoveryState.lastCanaryStatus
      pendingRepairVerification = [bool]$RecoveryState.pendingRepairVerification
      pendingRepairVerificationAt = [string]$RecoveryState.pendingRepairVerificationAt
      lastVerificationCheckAt = [string]$RecoveryState.lastVerificationCheckAt
    }
  }
  $payload = [ordered]@{
    checkedAt = $Snapshot.checkedAt
    healthy = $Snapshot.healthy
    action = $Action
    detail = $Detail
    guard = $guard
    restartNotification = Get-WatchdogRestartNotificationStatus
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
  param([int]$TimeoutSeconds = 30)

  # The UIA bridge is contacted over a 3 second per-request timeout, and a repair
  # runs this immediately after (re)starting the bridge. A bridge that has not
  # finished listening yet therefore fails the first request, and treating that as
  # a hard error aborted the repair and drove another one - the stack was observed
  # restarting every few minutes while this endpoint was actually healthy moments
  # later. Poll within a bounded window instead, and only fail once it is clear the
  # bridge genuinely will not serve the command.
  $body = @{ command = "/azzy"; contact = "yourself"; notify = $false } | ConvertTo-Json -Compress
  $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
  $lastError = ""
  while ($true) {
    try {
      $result = Invoke-JsonEndpoint -Uri "$($UiaBaseUrl.TrimEnd('/'))/api/command" -Method POST -Body $body
      if ($result.Ok -and [string]$result.Body.send_source -eq "azzy") {
        return
      }
      $lastError = if ($result.Error) { $result.Error } else { "send_source=$([string]$result.Body.send_source)" }
    } catch {
      $lastError = $_.Exception.Message
    }
    if ((Get-Date) -ge $deadline) {
      throw "UIA bridge did not persist the azzy send source within ${TimeoutSeconds}s: $lastError"
    }
    Start-Sleep -Milliseconds 500
  }
}

function Test-LocalWeixinRecoveryEligible {
  param(
    [string[]]$Failed,
    $Snapshot
  )

  $components = @($Failed | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  if ($components.Count -eq 0) { return $false }
  if ($components.Count -eq 1 -and $components[0] -eq "weixin") { return $true }
  # If UIA remains a healthy process and only its exact chat target is absent,
  # starting the desktop session is the narrow repair. A full stack restart
  # would only destroy a usable core while the desktop session initializes.
  return $components.Count -eq 2 `
    -and $components -contains "uia" `
    -and $components -contains "weixin" `
    -and $null -ne $Snapshot `
    -and $Snapshot.uiaBridge.alive `
    -and $Snapshot.uiaBridge.health
}

function Test-UiAWaitingForWeixinSnapshot {
  param([Parameter(Mandatory = $true)]$Snapshot)

  return $Snapshot.cyberboss.alive `
    -and $Snapshot.appServer.ready `
    -and $Snapshot.weflow.ready `
    -and $Snapshot.uiaBridge.alive `
    -and $Snapshot.uiaBridge.health `
    -and (-not $Snapshot.uiaBridge.ready) `
    -and $Snapshot.weixin.alive
}

function Get-WatchdogFailureDisposition {
  param(
    [string[]]$Failed,
    [int]$ConsecutiveFailures,
    [int]$RequiredConfirmations = 2
  )

  $components = @($Failed | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  if ($ConsecutiveFailures -lt [Math]::Max(1, $RequiredConfirmations)) {
    return [ordered]@{ action = "observing"; shouldRepair = $false }
  }
  return [ordered]@{ action = "repair"; shouldRepair = $true }
}

function Get-WatchdogFailedComponents {
  param([Parameter(Mandatory = $true)]$Snapshot)

  $failed = @()
  if (-not $Snapshot.cyberboss.alive) { $failed += "cyberboss" }
  # The shared Codex app-server only exists for the codex runtime. With another
  # runtime (dsh, claudecode) the service intentionally skips it, so requiring it
  # would report a permanent failure and drive repairs that cannot help.
  if ($WatchdogRuntime -eq "codex") {
    if (-not $Snapshot.appServer.alive -or -not $Snapshot.appServer.ready) { $failed += "app-server" }
  }
  if (-not $Snapshot.weflow.ready) { $failed += "weflow" }
  if (-not $Snapshot.uiaBridge.alive -or -not $Snapshot.uiaBridge.health -or -not $Snapshot.uiaBridge.ready) { $failed += "uia" }
  if (-not $Snapshot.weixin.alive) { $failed += "weixin" }
  if ($Snapshot.sendSource -ne "azzy") { $failed += "send-source" }
  if (-not $Snapshot.inboxQueue.healthy) { $failed += "inboxQueue" }
  if (-not $Snapshot.pendingInbound.healthy) { $failed += "pendingInbound" }
  if (-not $Snapshot.deferredReplies.healthy) { $failed += "deferredReplies" }
  if (-not $Snapshot.replyObligations.healthy) { $failed += "replyObligations" }
  if (-not $Snapshot.mainDelivery.healthy) { $failed += "mainDelivery" }
  if (-not $Snapshot.activity.healthy) { $failed += "activity" }
  if ($Snapshot.canary.healthy -eq $false) { $failed += "canary" }
  return @($failed | Select-Object -Unique)
}

function Get-WatchdogFailureFingerprint {
  param(
    [string[]]$Failed,
    $Snapshot = $null
  )

  $components = @($Failed |
    Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
    ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } |
    Sort-Object -Unique)
  $parts = @()
  foreach ($component in $components) {
    $reason = ""
    if ($null -ne $Snapshot) {
      switch ($component) {
        "app-server" {
          $reason = "alive=$([bool]$Snapshot.appServer.alive),ready=$([bool]$Snapshot.appServer.ready)"
        }
        "weflow" { $reason = [string]$Snapshot.weflow.reason }
        "uia" {
          $reason = "alive=$([bool]$Snapshot.uiaBridge.alive),health=$([bool]$Snapshot.uiaBridge.health),ready=$([bool]$Snapshot.uiaBridge.ready)"
        }
        "weixin" { $reason = "alive=$([bool]$Snapshot.weixin.alive)" }
        "send-source" { $reason = "source=$([string]$Snapshot.sendSource)" }
        "inboxqueue" { $reason = [string]$Snapshot.inboxQueue.reason }
        "pendinginbound" { $reason = [string]$Snapshot.pendingInbound.reason }
        "deferredreplies" { $reason = [string]$Snapshot.deferredReplies.reason }
        "replyobligations" { $reason = [string]$Snapshot.replyObligations.reason }
        "maindelivery" { $reason = "$([string]$Snapshot.mainDelivery.reason):$([string]$Snapshot.mainDelivery.failureCode)" }
        "activity" { $reason = [string]$Snapshot.activity.reason }
        "canary" {
          $canaryCode = ([string]$Snapshot.canary.code).Trim()
          $reason = if ($canaryCode) {
            "code=$canaryCode,repairable=$([bool]$Snapshot.canary.repairable)"
          } else {
            "action=$([string]$Snapshot.canary.action),repairable=$([bool]$Snapshot.canary.repairable)"
          }
        }
      }
    }
    $normalizedReason = ([string]$reason).Trim().ToLowerInvariant() -replace "[|\r\n]+", "_"
    $parts += if ($normalizedReason) { "$component=$normalizedReason" } else { $component }
  }
  return $parts -join "|"
}

function Update-WatchdogFailureObservation {
  param(
    [Parameter(Mandatory = $true)]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$Fingerprint,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
    [int]$WindowMinutes = $FailureConfirmationWindowMinutes
  )

  $lastSeen = ConvertTo-UtcDateOrNull ([string]$RecoveryState.failureLastSeenAt)
  $expired = $null -eq $lastSeen `
    -or $Now.UtcDateTime -gt $lastSeen.AddMinutes([Math]::Max(1, $WindowMinutes))
  $changed = [string]$RecoveryState.failureFingerprint -cne $Fingerprint
  if ($changed -or $expired) {
    $RecoveryState.failureFingerprint = $Fingerprint
    $RecoveryState.failureCount = 1
    $RecoveryState.failureFirstSeenAt = $Now.ToUniversalTime().ToString("o")
  } else {
    $RecoveryState.failureCount = [Math]::Min(100, [int]$RecoveryState.failureCount + 1)
  }
  $RecoveryState.failureLastSeenAt = $Now.ToUniversalTime().ToString("o")
  # Retain the original field for compatibility with existing status readers.
  $RecoveryState.consecutiveFailures = [int]$RecoveryState.failureCount
  return [int]$RecoveryState.failureCount
}

function Reset-WatchdogFailureObservation {
  param([Parameter(Mandatory = $true)]$RecoveryState)

  $RecoveryState.consecutiveFailures = 0
  $RecoveryState.failureFingerprint = ""
  $RecoveryState.failureCount = 0
  $RecoveryState.failureFirstSeenAt = ""
  $RecoveryState.failureLastSeenAt = ""
}

function Get-WatchdogRepairPlan {
  param(
    [string[]]$Failed,
    [Parameter(Mandatory = $true)]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$Fingerprint,
    [ValidateSet("", "StartWeixin", "ResetAzzySource", "Restart", "FullRestart")]
    [string]$PreferredMode = "",
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )

  $baseMode = if ($PreferredMode) { $PreferredMode } else { Get-WatchdogRepairMode -Failed $Failed }
  $plan = [ordered]@{
    mode = $baseMode
    escalated = $false
    blocked = $false
    reason = "base_policy"
    retryAt = ""
  }
  $lastAttempt = ConvertTo-UtcDateOrNull ([string]$RecoveryState.lastRepairAttemptAt)
  $sameRecentFault = [string]$RecoveryState.lastRepairFailureFingerprint -ceq $Fingerprint `
    -and $null -ne $lastAttempt `
    -and $Now.UtcDateTime -lt $lastAttempt.AddHours([Math]::Max(1, $SameFaultRetryHours))
  if (-not $sameRecentFault) { return $plan }

  $outcome = ([string]$RecoveryState.lastRepairOutcome).Trim().ToLowerInvariant()
  $startedWasInterrupted = $outcome -eq "started" `
    -and $Now.UtcDateTime -gt $lastAttempt.AddMinutes(3)
  if ($outcome -eq "waiting_for_uia" -and [string]$RecoveryState.lastRepairMode -in @("Restart", "FullRestart")) {
    # The core stack is alive and the UIA transport is healthy, but the exact
    # logged-in chat window is not available. Repeating a process restart cannot
    # create that desktop state, so defer until the target window is present.
    $plan.blocked = $true
    $plan.reason = "weixin_chat_window_required"
    $plan.retryAt = $lastAttempt.AddHours([Math]::Max(1, $SameFaultRetryHours)).ToString("o")
    return $plan
  }
  $ineffective = $outcome -in @("controller_error", "repair_failed", "verification_failed", "unhealthy") `
    -or $startedWasInterrupted
  if ($outcome -eq "waiting_for_login" -and [string]$RecoveryState.lastRepairMode -eq "StartWeixin") {
    # Repeated process restarts cannot create a logged-in desktop session. Keep
    # the circuit open until the operator logs in or the same-fault retry window
    # expires, instead of burning the remaining restart budget.
    $plan.blocked = $true
    $plan.reason = "weixin_login_required"
    $plan.retryAt = $lastAttempt.AddHours([Math]::Max(1, $SameFaultRetryHours)).ToString("o")
    return $plan
  }
  if (-not $ineffective) { return $plan }

  switch ([string]$RecoveryState.lastRepairMode) {
    { $_ -in @("StartWeixin", "ResetAzzySource") } {
      # A narrow repair gets one chance. If the identical fault survives, move
      # to the guarded service restart instead of repeating the same no-op.
      $plan.mode = "Restart"
      $plan.escalated = $true
      $plan.reason = "same_fault_local_repair_ineffective"
      return $plan
    }
    "Restart" {
      $plan.mode = "FullRestart"
      $plan.escalated = $true
      $plan.reason = "same_fault_restart_ineffective"
      return $plan
    }
    "FullRestart" {
      $plan.blocked = $true
      $plan.reason = "same_fault_full_restart_ineffective"
      $plan.retryAt = $lastAttempt.AddHours([Math]::Max(1, $SameFaultRetryHours)).ToString("o")
      return $plan
    }
  }
  return $plan
}

function Set-WatchdogRepairStarted {
  param(
    [Parameter(Mandatory = $true)]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$Fingerprint,
    [Parameter(Mandatory = $true)][string]$RepairMode,
    [Parameter(Mandatory = $true)][string]$RepairIdentity
  )

  if ([string]$RecoveryState.lastRepairFailureFingerprint -cne $Fingerprint) {
    $RecoveryState.ineffectiveRepairCount = 0
  }
  $RecoveryState.lastRepairFailureFingerprint = $Fingerprint
  $RecoveryState.lastRepairMode = $RepairMode
  $RecoveryState.lastRepairOutcome = "started"
  $RecoveryState.currentRepairIdentity = $RepairIdentity
  # Every new repair creates a fresh verification obligation. Never carry an
  # old demand identity into a newly changed service instance.
  $RecoveryState.pendingRepairVerification = $false
  $RecoveryState.pendingRepairVerificationAt = ""
  $RecoveryState.pendingRepairVerificationIdentity = ""
}

function Set-WatchdogRepairOutcome {
  param(
    [Parameter(Mandatory = $true)]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$Outcome,
    [switch]$Ineffective,
    [switch]$Completed
  )

  $RecoveryState.lastRepairOutcome = $Outcome
  if ($Ineffective) {
    $RecoveryState.ineffectiveRepairCount = [Math]::Min(100, [int]$RecoveryState.ineffectiveRepairCount + 1)
  } elseif ($Outcome -in @("verified", "infrastructure_recovered")) {
    $RecoveryState.ineffectiveRepairCount = 0
  }
  if ($Completed) { $RecoveryState.currentRepairIdentity = "" }
}

function Test-CanaryFailureNonRestartable {
  param(
    [string[]]$Failed,
    [Parameter(Mandatory = $true)]$Canary
  )

  $components = @($Failed | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  return $components.Count -eq 1 `
    -and $components[0] -eq "canary" `
    -and $Canary.repairable -eq $false
}

function Test-MainDeliveryFailureNonRestartable {
  param(
    [string[]]$Failed,
    [Parameter(Mandatory = $true)]$MainDelivery
  )

  $components = @($Failed | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  $independentlyRepairable = @($components | Where-Object {
    $_ -in @(
      "cyberboss",
      "app-server",
      "weflow",
      "uia",
      "weixin",
      "send-source",
      "inboxQueue",
      "pendingInbound",
      "deferredReplies",
      "activity",
      "canary"
    )
  })
  return $components -contains "mainDelivery" `
    -and $MainDelivery.healthy -eq $false `
    -and $MainDelivery.repairable -eq $false `
    -and $independentlyRepairable.Count -eq 0
}

function Test-ReplyObligationFailureNonRestartable {
  param(
    [string[]]$Failed,
    [Parameter(Mandatory = $true)]$ReplyObligations
  )

  $components = @($Failed | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  $independentlyRepairable = @($components | Where-Object {
    $_ -in @(
      "cyberboss",
      "app-server",
      "weflow",
      "uia",
      "weixin",
      "send-source",
      "inboxQueue",
      "pendingInbound",
      "deferredReplies",
      "activity",
      "canary"
    )
  })
  return $components -contains "replyObligations" `
    -and $ReplyObligations.healthy -eq $false `
    -and $ReplyObligations.repairable -eq $false `
    -and $independentlyRepairable.Count -eq 0
}

function Test-CanaryDeferredOnly {
  param(
    [string[]]$Failed,
    [Parameter(Mandatory = $true)]$Canary
  )

  $components = @($Failed | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  return $components.Count -eq 1 `
    -and $components[0] -eq "canary" `
    -and [string]$Canary.action -in $CanaryDeferredActions
}

function Get-WatchdogRepairMode {
  param([string[]]$Failed)

  $components = @($Failed | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  $messagePipeline = @("cyberboss", "app-server", "uia", "weixin", "send-source", "inboxQueue", "pendingInbound", "deferredReplies", "replyObligations", "activity", "canary")
  if ($components.Count -gt 0 -and @($components | Where-Object { $_ -notin $messagePipeline }).Count -eq 0) {
    return "Restart"
  }
  return "FullRestart"
}

function Set-PendingRepairVerification {
  param(
    [Parameter(Mandatory = $true)]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$RepairIdentity
  )

  $identity = $RepairIdentity.Trim()
  if (-not $identity) { throw "repair verification identity is required" }
  $checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  $identityChanged = -not [bool]$RecoveryState.pendingRepairVerification `
    -or [string]$RecoveryState.pendingRepairVerificationIdentity -cne $identity
  $RecoveryState.pendingRepairVerification = $true
  $RecoveryState.pendingRepairVerificationIdentity = $identity
  if ($identityChanged -or [string]::IsNullOrWhiteSpace([string]$RecoveryState.pendingRepairVerificationAt)) {
    $RecoveryState.pendingRepairVerificationAt = $checkedAt
  }
  $RecoveryState.lastVerificationCheckAt = $checkedAt
}

function Set-VerifiedRecoveryState {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)]$RecoveryState
  )

  Reset-WatchdogFailureObservation -RecoveryState $RecoveryState
  $RecoveryState.canaryConsecutiveFailures = 0
  $RecoveryState.lastCanaryError = ""
  $RecoveryState.lastHealthyAt = $Snapshot.checkedAt
  $RecoveryState.pendingRepairVerification = $false
  $RecoveryState.pendingRepairVerificationAt = ""
  $RecoveryState.pendingRepairVerificationIdentity = ""
}

function Complete-VerifiedRepair {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)]$RecoveryState,
    [string]$Detail = ""
  )

  $repairIdentity = [string]$RecoveryState.currentRepairIdentity
  if ([string]::IsNullOrWhiteSpace($repairIdentity)) {
    $repairIdentity = [string]$RecoveryState.lastRepairAttemptAt
  }
  $repairMode = [string]$RecoveryState.lastRepairMode
  Set-VerifiedRecoveryState -Snapshot $Snapshot -RecoveryState $RecoveryState
  Set-WatchdogRepairOutcome -RecoveryState $RecoveryState -Outcome "verified" -Completed
  $RecoveryState.lastSuccessfulRepairAt = $Snapshot.checkedAt
  Save-RecoveryState -State $RecoveryState
  if ($repairMode -in @("Restart", "FullRestart")) {
    # The obligation was activated before controller startup. Dispatch loads
    # that immutable payload by repair identity; a later canary detail must
    # never alter the idempotent message.
    if ($Snapshot.uiaBridge.ready) {
      $notification = Invoke-WatchdogRestartNotification `
        -Action "dispatch" `
        -RepairIdentity $repairIdentity
      if ([bool]$notification.verified) {
        Write-WatchdogLog "restart notification verified localId=$($notification.localId) identity=$repairIdentity"
      } else {
        Write-WatchdogLog "restart notification remains pending action=$($notification.action) identity=$repairIdentity error=$($notification.lastError)$($notification.error)"
      }
    } else {
      Write-WatchdogLog "restart notification remains pending until UIA is ready identity=$repairIdentity"
    }
  }
  Save-Status -Snapshot $Snapshot -Action "repaired" -Detail $Detail -RecoveryState $RecoveryState
  Write-WatchdogLog "repair verified healthy"
}

function Wait-WatchdogInfrastructureRecovery {
  param(
    [ValidateRange(1, 120)][int]$TimeoutSeconds = 30,
    [switch]$IgnoreMainDelivery,
    [switch]$IgnoreReplyObligations
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $candidate = Get-HealthSnapshot
    if (Test-SnapshotInfrastructureHealthy `
        -Snapshot $candidate `
        -IgnoreMainDelivery:$IgnoreMainDelivery `
        -IgnoreReplyObligations:$IgnoreReplyObligations) {
      return $candidate
    }
    if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  } while ((Get-Date) -lt $deadline)
  return $candidate
}

function Invoke-PostRepairCanaryVerification {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$RepairIdentity
  )

  if (-not (Test-CanaryIdleGate -Snapshot $Snapshot)) {
    $blockers = @(Get-CanaryIdleGateBlockers -Snapshot $Snapshot)
    $blockerDetail = if ($blockers.Count -gt 0) { $blockers -join "," } else { "unknown_idle_gate" }
    $blocked = [ordered]@{
      healthy = $null
      status = "blocked"
      action = "repair_verification_blocked"
      attempted = $false
      runId = ""
      error = "post-repair canary idle gate blocked: $blockerDetail"
      detail = "post-repair canary idle gate blockers=$blockerDetail"
    }
    Set-PendingRepairVerification -RecoveryState $RecoveryState -RepairIdentity $RepairIdentity
    Set-WatchdogRepairOutcome -RecoveryState $RecoveryState -Outcome "verification_pending"
    Set-SnapshotCanaryResult -Snapshot $Snapshot -Canary $blocked
    Save-RecoveryState -State $RecoveryState
    return $Snapshot
  }

  # Persist the verification obligation before starting the bounded runner.
  # Task Scheduler, an OS shutdown, or a process crash can terminate the host at
  # any instruction after this point; the next watchdog run must resume
  # verification rather than trusting a pre-repair healthy snapshot.
  Set-PendingRepairVerification -RecoveryState $RecoveryState -RepairIdentity $RepairIdentity
  Set-WatchdogRepairOutcome -RecoveryState $RecoveryState -Outcome "verification_pending"
  Save-RecoveryState -State $RecoveryState

  $canary = Invoke-CanaryCheck `
    -Force `
    -Reason "repair_verification" `
    -DemandKey "repair:$RepairIdentity"
  Update-RecoveryCanaryState -RecoveryState $RecoveryState -Canary $canary
  $verified = $canary.action -eq "verified" `
    -and [string]$canary.triggerLocalId -match "^\d+$" `
    -and [string]$canary.replyLocalId -match "^\d+$"
  $deferred = -not $verified `
    -and ($null -eq $canary.healthy -or [string]$canary.action -in $CanaryDeferredActions)
  if ($deferred) {
    $canary.healthy = $null
    $canary.status = "deferred"
    $canary.action = "repair_verification_deferred"
    $canary.detail = "post-repair canary is awaiting a new verified trigger/reply pair"
    Set-PendingRepairVerification -RecoveryState $RecoveryState -RepairIdentity $RepairIdentity
    Set-WatchdogRepairOutcome -RecoveryState $RecoveryState -Outcome "verification_pending"
  } elseif (-not $verified) {
    # A completed negative proof is not a scheduler wait. Preserve it as a
    # failure so the next confirmed incident can escalate instead of replaying
    # a demand key that the canary runner has already completed.
    $originalAction = [string]$canary.action
    $canary.healthy = $false
    $canary.status = "failed"
    $canary.action = "repair_verification_failed"
    $canary.detail = "post-repair canary completed without a verified trigger/reply pair; result=$originalAction; code=$([string]$canary.code)"
    $RecoveryState.pendingRepairVerification = $false
    $RecoveryState.pendingRepairVerificationAt = ""
    $RecoveryState.pendingRepairVerificationIdentity = ""
    Set-WatchdogRepairOutcome -RecoveryState $RecoveryState -Outcome "verification_failed" -Ineffective -Completed
  }
  Save-RecoveryState -State $RecoveryState
  $refreshed = Get-HealthSnapshot
  Set-SnapshotCanaryResult -Snapshot $refreshed -Canary $canary
  return $refreshed
}

function Save-PostRepairCanaryFailure {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)]$RecoveryState,
    [string]$RepairMode = "repair"
  )

  $detail = "$RepairMode restored infrastructure, but the completed end-to-end canary failed; code=$([string]$Snapshot.canary.code); error=$([string]$Snapshot.canary.error)"
  # Invoke-PostRepairCanaryVerification already closed the pending obligation and
  # recorded exactly one ineffective result. Do not increment it a second time
  # while publishing the terminal status.
  Save-RecoveryState -State $RecoveryState
  Save-Status -Snapshot $Snapshot -Action "repair_failed" -Detail $detail -RecoveryState $RecoveryState
  Write-WatchdogLog $detail
}

function Invoke-ExplicitCanaryDemand {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$DemandIdentity
  )

  if ([string]::IsNullOrWhiteSpace($DemandIdentity)) {
    throw "explicit canary demand identity is required"
  }
  if (-not (Test-CanaryIdleGate -Snapshot $Snapshot)) {
    $blockers = @(Get-CanaryIdleGateBlockers -Snapshot $Snapshot)
    $blockerDetail = if ($blockers.Count -gt 0) { $blockers -join "," } else { "unknown_idle_gate" }
    $blocked = [ordered]@{
      healthy = $null
      status = "deferred"
      action = "demand_blocked"
      attempted = $false
      repairable = $false
      runId = ""
      checkedAt = (Get-Date).ToUniversalTime().ToString("o")
      error = ""
      detail = "explicit canary demand idle gate blockers=$blockerDetail"
    }
    Set-SnapshotCanaryResult -Snapshot $Snapshot -Canary $blocked
    return $Snapshot
  }

  $canary = Invoke-CanaryCheck `
    -Force `
    -Reason "user_demand" `
    -DemandKey $DemandIdentity
  $afterProbe = Get-HealthSnapshot
  if ($canary.healthy -eq $false) {
    $becameBusy = Test-CanaryProbeDeferredByActivity `
      -Snapshot $afterProbe `
      -ProbeCode ([string]$canary.code)
    if ($becameBusy `
      -and ($canary.repairable -ne $false `
        -or $canary.code -eq "CANARY_DESKTOP_ACTIVE" `
        -or $canary.action -eq "deferred_busy")) {
      Set-SnapshotCanaryResult -Snapshot $afterProbe -Canary $canary -Deferred
    } else {
      Set-SnapshotCanaryResult -Snapshot $afterProbe -Canary $canary
    }
  } else {
    Set-SnapshotCanaryResult -Snapshot $afterProbe -Canary $canary
  }
  Update-RecoveryCanaryState -RecoveryState $RecoveryState -Canary $afterProbe.canary
  Save-RecoveryState -State $RecoveryState
  return $afterProbe
}

function Invoke-ExplicitModelCanaryDemand {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)][string]$DemandIdentity
  )

  if ([string]::IsNullOrWhiteSpace($DemandIdentity)) {
    throw "explicit model E2E demand identity is required"
  }
  if (-not $ModelCanaryEnabled) {
    Set-SnapshotModelCanaryResult -Snapshot $Snapshot -ModelCanary (Read-ModelCanaryStatus)
    return $Snapshot
  }
  if (-not (Test-ModelCanaryIdleGate -Snapshot $Snapshot)) {
    $blockers = @(Get-ModelCanaryIdleGateBlockers -Snapshot $Snapshot)
    $blockerDetail = if ($blockers.Count -gt 0) { $blockers -join "," } else { "unknown_idle_gate" }
    $blocked = [ordered]@{
      enabled = $true
      healthy = $null
      status = "deferred"
      action = "deferred_busy"
      attempted = $false
      repairable = $false
      confirmedFailure = $false
      routineConsecutiveFailures = 0
      receiptsVerified = $false
      runId = ""
      checkedAt = (Get-Date).ToUniversalTime().ToString("o")
      nextDueAt = ""
      code = "MODEL_CANARY_IDLE_GATE_BLOCKED"
      error = ""
      detail = "explicit model E2E demand idle gate blockers=$blockerDetail"
    }
    Set-SnapshotModelCanaryResult -Snapshot $Snapshot -ModelCanary $blocked
    return $Snapshot
  }

  $modelCanary = Invoke-ModelCanaryCheck -DemandKey $DemandIdentity
  $afterProbe = Get-HealthSnapshot
  Set-SnapshotModelCanaryResult -Snapshot $afterProbe -ModelCanary $modelCanary
  return $afterProbe
}

if ($env:CYBERBOSS_WATCHDOG_LIBRARY_ONLY -eq "1") {
  return
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
  $repairStarted = $false
  $snapshot = Get-HealthSnapshot
  if ($Mode -eq "Status") {
    $statusGate = Get-RecoveryGate -State $recovery
    if (-not [bool]$recovery.recoveryStateValid) {
      $detail = "repair guard state is invalid and the circuit is fail-closed; $($recovery.recoveryStateError)"
      Save-Status -Snapshot $snapshot -Action "circuit_open" -Detail $detail -RecoveryState $recovery
    } elseif (-not $snapshot.healthy -and -not $statusGate.allowed) {
      $statusFailed = @(Get-WatchdogFailedComponents -Snapshot $snapshot)
      $statusAction = if ($statusGate.reason -eq "cooldown") { "cooldown" } else { "circuit_open" }
      $detail = "components=$($statusFailed -join ','); reason=$($statusGate.reason); retryAt=$($statusGate.retryAt); status_only=true"
      Save-Status -Snapshot $snapshot -Action $statusAction -Detail $detail -RecoveryState $recovery
    } elseif ($ModelCanaryEnabled -and $snapshot.modelE2E.confirmedFailure -eq $true) {
      $detail = "model E2E pipeline is blocked after $($snapshot.modelE2E.routineConsecutiveFailures) consecutive routine failures; nextDue=$($snapshot.modelE2E.nextDueAt); repair=false"
      Save-Status -Snapshot $snapshot -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
    } elseif (Test-CanaryVerificationPending -Snapshot $snapshot) {
      $detail = "canary verification pending for the configured Azzy target; action=$($snapshot.canary.action); nextDue=$($snapshot.canary.nextDueAt)"
      Save-Status -Snapshot $snapshot -Action "verification_pending" -Detail $detail -RecoveryState $recovery
    } else {
      Save-Status -Snapshot $snapshot -RecoveryState $recovery
    }
    $snapshot | ConvertTo-Json -Depth 8
    exit $(if ($snapshot.healthy) { 0 } else { 1 })
  }

  # Restart notifications are durable obligations, not repair attempts.  Drain
  # them whenever the UIA transport is ready, including while the restart
  # circuit itself is cooling down/open; this does not consume or bypass any
  # repair budget.
  if ($snapshot.uiaBridge.ready -and (Test-DesktopInputIdleGate -Snapshot $snapshot)) {
    $pendingNotificationStatus = Get-WatchdogRestartNotificationStatus
    if ([int]$pendingNotificationStatus.pendingCount -gt 0) {
      $notificationResults = @(Invoke-WatchdogRestartNotification -Action "drain")
      foreach ($notificationResult in $notificationResults) {
        if ([bool]$notificationResult.verified `
            -and [string]$notificationResult.localId -match "^[1-9]\d*$") {
          Write-WatchdogLog "pending restart notification verified localId=$($notificationResult.localId) identity=$($notificationResult.repairIdentity)"
        } elseif ([string]$notificationResult.action -eq "error") {
          Write-WatchdogLog "pending restart notification drain failed error=$($notificationResult.error)"
        } else {
          Write-WatchdogLog "pending restart notification retained action=$($notificationResult.action) identity=$($notificationResult.repairIdentity) error=$($notificationResult.lastError)"
        }
      }
      # The outbound receipt and message ledger are part of the snapshot; read
      # them again after a drain so the status file reports the same observation.
      $snapshot = Get-HealthSnapshot
    }
  }

  if (-not [bool]$recovery.recoveryStateValid) {
    $detail = "repair guard state is invalid and the circuit is fail-closed; $($recovery.recoveryStateError)"
    Save-Status -Snapshot $snapshot -Action "circuit_open" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 2
  }

  if ($ExplicitModelDemandKey) {
    $modelDemandSnapshot = Invoke-ExplicitModelCanaryDemand `
      -Snapshot $snapshot `
      -DemandIdentity $ExplicitModelDemandKey
    $modelResult = $modelDemandSnapshot.modelE2E
    $modelVerified = $modelResult.healthy -eq $true `
      -and $modelResult.action -eq "verified" `
      -and $modelResult.receiptsVerified -eq $true `
      -and [string]$modelResult.triggerLocalId -match "^\d+$" `
      -and [string]$modelResult.replyLocalId -match "^\d+$"
    if ($modelVerified) {
      $detail = "explicit model E2E demand verified Azzy trigger/runtime/model/reply receipt chain; demand=$ExplicitModelDemandKey; runId=$($modelResult.runId); triggerLocalId=$($modelResult.triggerLocalId); replyLocalId=$($modelResult.replyLocalId)"
      Save-Status -Snapshot $modelDemandSnapshot -Action "model_e2e_verified" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 0
    }
    if (-not $ModelCanaryEnabled `
      -or [string]$modelResult.action -in $ModelCanaryDeferredActions `
      -or $null -eq $modelResult.healthy) {
      $detail = "explicit model E2E demand deferred without repair; demand=$ExplicitModelDemandKey; action=$($modelResult.action); nextDue=$($modelResult.nextDueAt)"
      Save-Status -Snapshot $modelDemandSnapshot -Action "model_e2e_deferred" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 0
    }
    $detail = "explicit model E2E demand failed without repair; demand=$ExplicitModelDemandKey; code=$($modelResult.code); repair=false"
    Save-Status -Snapshot $modelDemandSnapshot -Action "model_e2e_failed" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 1
  }

  if ($recovery.pendingRepairVerification -and (Test-SnapshotInfrastructureHealthy -Snapshot $snapshot)) {
    $identity = if ($recovery.pendingRepairVerificationIdentity) {
      [string]$recovery.pendingRepairVerificationIdentity
    } else {
      [string]$recovery.pendingRepairVerificationAt
    }
    $verification = Invoke-PostRepairCanaryVerification `
      -Snapshot $snapshot `
      -RecoveryState $recovery `
      -RepairIdentity $identity
    Save-RecoveryState -State $recovery
    if ($verification.healthy `
      -and $verification.canary.action -eq "verified" `
      -and [string]$verification.canary.triggerLocalId -match "^\d+$" `
      -and [string]$verification.canary.replyLocalId -match "^\d+$") {
      Complete-VerifiedRepair -Snapshot $verification -RecoveryState $recovery -Detail "deferred post-repair canary verified"
      exit 0
    }
    if ($verification.canary.action -eq "repair_verification_failed" -or $verification.canary.healthy -eq $false) {
      $detail = "post-repair canary verification failed; action=$($verification.canary.action); code=$($verification.canary.code); error=$($verification.canary.error)"
      Save-Status -Snapshot $verification -Action "repair_failed" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 1
    }
    $detail = "post-repair canary remains deferred; action=$($verification.canary.action); nextDue=$($verification.canary.nextDueAt); activity=$($verification.activity.reason)"
    Save-Status -Snapshot $verification -Action "repair_verification_deferred" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 0
  }

  if ($ExplicitDemandKey) {
    $demandSnapshot = Invoke-ExplicitCanaryDemand `
      -Snapshot $snapshot `
      -RecoveryState $recovery `
      -DemandIdentity $ExplicitDemandKey
    $demandVerified = $demandSnapshot.healthy `
      -and $demandSnapshot.canary.action -eq "verified" `
      -and [string]$demandSnapshot.canary.triggerLocalId -match "^\d+$" `
      -and [string]$demandSnapshot.canary.replyLocalId -match "^\d+$"
    if ($demandVerified) {
      Set-VerifiedRecoveryState -Snapshot $demandSnapshot -RecoveryState $recovery
      Save-RecoveryState -State $recovery
      $detail = "explicit canary demand verified one exact Azzy trigger/reply chain; demand=$ExplicitDemandKey"
      Save-Status -Snapshot $demandSnapshot -Action "demand_verified" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 0
    }
    if ([string]$demandSnapshot.canary.action -in $CanaryDeferredActions `
      -or $null -eq $demandSnapshot.canary.healthy) {
      $detail = "explicit canary demand deferred without repair; demand=$ExplicitDemandKey; action=$($demandSnapshot.canary.action); nextDue=$($demandSnapshot.canary.nextDueAt)"
      Save-Status -Snapshot $demandSnapshot -Action "demand_deferred" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 0
    }
    $detail = "explicit canary demand failed without starting repair; demand=$ExplicitDemandKey; code=$($demandSnapshot.canary.code); confirmation=$($recovery.canaryConsecutiveFailures)/$RequiredFailureConfirmations"
    Save-Status -Snapshot $demandSnapshot -Action "demand_failed" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 1
  }

  $queuePendingCount = [int]$snapshot.inboxQueue.pendingCount `
    + [int]$snapshot.pendingInbound.pendingCount `
    + [int]$snapshot.deferredReplies.pendingCount `
    + [int]$snapshot.replyObligations.openCount
  $freshDurableWork = $queuePendingCount -gt 0 `
    -and $snapshot.inboxQueue.healthy `
    -and $snapshot.pendingInbound.healthy `
    -and $snapshot.deferredReplies.healthy `
    -and $snapshot.replyObligations.healthy
  $canaryInvoked = $false
  if ($null -ne (Get-CanaryTargetConfigurationFailure)) {
    # This is a deterministic local configuration error. Confirm it without
    # waiting for user-idle/UI gates, while Invoke-CanaryCheck still guarantees
    # that the runner and UI dispatch are never reached.
    $snapshot.canary = Invoke-CanaryCheck -Reason "configuration_validation"
    $canaryInvoked = $true
  } elseif (Test-CanaryIdleGate -Snapshot $snapshot) {
    $snapshot.canary = Invoke-CanaryCheck -Reason "routine"
    $canaryInvoked = $true
  } elseif ((Test-CanaryPrerequisites -Snapshot $snapshot) `
    -and (Test-PipelineRepairIdleGate -Snapshot $snapshot) `
    -and (Test-DesktopInputIdleGate -Snapshot $snapshot) `
    -and $snapshot.inboxQueue.reason -ne "canary_cursor_target_mismatch" `
    -and (-not $snapshot.inboxQueue.healthy `
      -or -not $snapshot.pendingInbound.healthy `
      -or -not $snapshot.deferredReplies.healthy)) {
    $demandKey = "inbox:$($snapshot.inboxQueue.oldestKey):$($snapshot.inboxQueue.pendingCount)" `
      + "|pending:$($snapshot.pendingInbound.oldestKey):$($snapshot.pendingInbound.pendingCount)" `
      + "|deferred:$($snapshot.deferredReplies.oldestKey):$($snapshot.deferredReplies.pendingCount)"
    $snapshot.canary = Invoke-CanaryCheck -Force -Reason "durable_backlog" -DemandKey $demandKey
    $canaryInvoked = $true
  } elseif ($freshDurableWork -or $snapshot.activity.busy -or -not $snapshot.inboxQueue.outgoingPoll.ready) {
    $deferredCanary = Read-CanaryStatus
    Set-SnapshotCanaryResult -Snapshot $snapshot -Canary $deferredCanary -Deferred
  } elseif ($snapshot.activity.idle `
    -and $null -ne $snapshot.activity.userIdleSeconds `
    -and [long]$snapshot.activity.userIdleSeconds -lt $CanaryUserQuietSeconds) {
    $deferredCanary = Read-CanaryStatus
    $deferredCanary.status = "deferred_recent_user"
    $deferredCanary.action = "deferred_recent_user"
    $deferredCanary.healthy = $null
    $deferredCanary.detail = "waiting for five quiet minutes after the last user message"
    Set-SnapshotCanaryResult -Snapshot $snapshot -Canary $deferredCanary
  }

  if ($canaryInvoked) {
    if ($snapshot.canary.healthy -eq $false) {
      # Work may have arrived while the bounded probe was running. A timeout in
      # that normal busy/deferred state is diagnostic, not a repair confirmation.
      $afterProbe = Get-HealthSnapshot
      $becameBusy = Test-CanaryProbeDeferredByActivity `
        -Snapshot $afterProbe `
        -ProbeCode ([string]$snapshot.canary.code)
      if ($becameBusy `
        -and ($snapshot.canary.repairable -ne $false `
          -or $snapshot.canary.code -eq "CANARY_DESKTOP_ACTIVE" `
          -or $snapshot.canary.action -eq "deferred_busy")) {
        Set-SnapshotCanaryResult -Snapshot $afterProbe -Canary $snapshot.canary -Deferred
        $snapshot = $afterProbe
      } else {
        Set-SnapshotCanaryResult -Snapshot $afterProbe -Canary $snapshot.canary
        $snapshot = $afterProbe
      }
    } else {
      $afterProbe = Get-HealthSnapshot
      Set-SnapshotCanaryResult -Snapshot $afterProbe -Canary $snapshot.canary
      $snapshot = $afterProbe
    }
    Update-RecoveryCanaryState -RecoveryState $recovery -Canary $snapshot.canary
    Save-RecoveryState -State $recovery
  }

  if ($ModelCanaryEnabled) {
    if (Test-ModelCanaryIdleGate -Snapshot $snapshot) {
      $modelRoutineResult = Invoke-ModelCanaryCheck
      $afterModelProbe = Get-HealthSnapshot
      Set-SnapshotModelCanaryResult -Snapshot $afterModelProbe -ModelCanary $modelRoutineResult
      $snapshot = $afterModelProbe
    } else {
      $modelDeferred = Read-ModelCanaryStatus
      $modelBlockers = @(Get-ModelCanaryIdleGateBlockers -Snapshot $snapshot)
      $modelDeferred.status = "deferred"
      $modelDeferred.action = "deferred_busy"
      $modelDeferred.attempted = $false
      if ($modelDeferred.healthy -ne $false) { $modelDeferred.healthy = $null }
      $modelDeferred.detail = "routine model E2E idle gate blockers=$($modelBlockers -join ',')"
      Set-SnapshotModelCanaryResult -Snapshot $snapshot -ModelCanary $modelDeferred
    }
  }

  $modelIsolation = Get-ModelCanaryIsolationDisposition -Snapshot $snapshot
  if ($null -ne $modelIsolation) {
    $snapshot.healthy = $false
    $detail = [string]$modelIsolation.detail
    Save-Status -Snapshot $snapshot -Action ([string]$modelIsolation.action) -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    # Persistent model inference/delivery evidence is diagnostic and explicitly
    # non-restartable, even when this scheduler turn was deferred/null.
    exit ([int]$modelIsolation.exitCode)
  }

  if ($ModelCanaryEnabled `
    -and $snapshot.modelE2E.healthy -eq $false `
    -and $snapshot.modelE2E.routineFailureActive -eq $true `
    -and $snapshot.canary.healthy -eq $true `
    -and (Test-SnapshotInfrastructureHealthy -Snapshot $snapshot)) {
    if ([string]$snapshot.modelE2E.action -notin $ModelCanaryDeferredActions) {
      $detail = "model E2E routine failure is observing confirmation $($snapshot.modelE2E.routineConsecutiveFailures)/$RequiredFailureConfirmations; code=$($snapshot.modelE2E.code); nextDue=$($snapshot.modelE2E.nextDueAt); repair=false"
      Save-Status -Snapshot $snapshot -Action "model_e2e_observing" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 0
    }
  }

  if (Test-CanaryVerificationPending -Snapshot $snapshot) {
    $detail = "canary verification pending for the configured Azzy target; action=$($snapshot.canary.action); nextDue=$($snapshot.canary.nextDueAt)"
    Save-Status -Snapshot $snapshot -Action "verification_pending" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    # Unknown is neither success nor failure: keep existing confirmation state,
    # consume no repair budget, and leave the runner free to probe when due.
    exit 0
  }

  if ($snapshot.healthy) {
    Reset-WatchdogFailureObservation -RecoveryState $recovery
    $recovery.lastHealthyAt = $snapshot.checkedAt
    Save-RecoveryState -State $recovery
    Save-Status -Snapshot $snapshot -RecoveryState $recovery
    Write-WatchdogLog "heartbeat healthy"
    exit 0
  }

  $failed = @(Get-WatchdogFailedComponents -Snapshot $snapshot)
  if ($failed.Count -eq 0) {
    $detail = "snapshot is unhealthy but no restartable component was attributed; modelConfirmed=$($snapshot.modelE2E.confirmedFailure); modelAction=$($snapshot.modelE2E.action); repair=blocked_nonrestartable"
    Save-Status -Snapshot $snapshot -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "unattributed watchdog failure was blocked before generic repair: $detail"
    exit 2
  }
  if ($failed.Count -gt 0 `
    -and @($failed | Where-Object { $_ -notin @("activity", "canary") }).Count -eq 0 `
    -and -not $snapshot.activity.ready) {
    $detail = "components=$($failed -join ','); activity=$($snapshot.activity.reason); ageSeconds=$($snapshot.activity.ageSeconds); repair=deferred_not_idle"
    Save-Status -Snapshot $snapshot -Action "deferred_not_idle" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "heartbeat canary deferred until the pipeline activity snapshot is fresh: $detail"
    exit 0
  }
  $canaryWaitingOnly = Test-CanaryDeferredOnly -Failed $failed -Canary $snapshot.canary
  $failureFingerprint = Get-WatchdogFailureFingerprint -Failed $failed -Snapshot $snapshot
  if (-not $canaryWaitingOnly) {
    $null = Update-WatchdogFailureObservation `
      -RecoveryState $recovery `
      -Fingerprint $failureFingerprint
  }
  Save-RecoveryState -State $recovery
  if ($canaryWaitingOnly) {
    $detail = "canary probe deferred by its bounded runner; action=$($snapshot.canary.action); preservedConfirmation=$($recovery.canaryConsecutiveFailures)/$RequiredFailureConfirmations; nextDue=$($snapshot.canary.nextDueAt); repair=false"
    Save-Status -Snapshot $snapshot -Action "canary_deferred" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    # A scheduler wait never authorizes a restart, even when an earlier
    # completed probe already accumulated the confirmation threshold.
    exit 0
  }
  # Every component, including the canary, uses the same time-bounded stable
  # fingerprint. The runner's aggregate counter remains diagnostic only.
  $confirmationCount = [int]$recovery.failureCount
  $disposition = Get-WatchdogFailureDisposition `
    -Failed $failed `
    -ConsecutiveFailures $confirmationCount `
    -RequiredConfirmations $RequiredFailureConfirmations
  $inboxDetail = if ($failed -contains "inboxQueue") {
    "; inboxPending=$($snapshot.inboxQueue.pendingCount); inboxOldestAgeSeconds=$($snapshot.inboxQueue.oldestAgeSeconds); inboxOldestKey=$($snapshot.inboxQueue.oldestKey); inboxReason=$($snapshot.inboxQueue.reason); outgoingPollLagSeconds=$($snapshot.inboxQueue.outgoingPoll.lagSeconds); outgoingPollCursorAgeSeconds=$($snapshot.inboxQueue.outgoingPoll.cursorAgeSeconds)"
  } else {
    ""
  }
  $durableDetail = "; pendingInbound=$($snapshot.pendingInbound.pendingCount)/$($snapshot.pendingInbound.oldestAgeSeconds)s" `
    + "; deferredReplies=$($snapshot.deferredReplies.pendingCount)/$($snapshot.deferredReplies.oldestAgeSeconds)s" `
    + "; replyObligations=$($snapshot.replyObligations.openCount)/$($snapshot.replyObligations.overdueCount); deferredObligations=$($snapshot.replyObligations.deferredCount); failedObligations=$($snapshot.replyObligations.terminalFailureCount); obligationReason=$($snapshot.replyObligations.reason); obligationNextDeadline=$($snapshot.replyObligations.nextDeadlineAt)" `
    + "; canary=$($snapshot.canary.status)/$($snapshot.canary.action); canaryRunId=$($snapshot.canary.runId); canaryNextDue=$($snapshot.canary.nextDueAt)"
  $mainDeliveryDetail = if ($failed -contains "mainDelivery") {
    "; mainDeliveryReason=$($snapshot.mainDelivery.reason); latestStatus=$($snapshot.mainDelivery.latestStatus); failedAt=$($snapshot.mainDelivery.failedAt); messageKind=$($snapshot.mainDelivery.messageKind); failureCode=$($snapshot.mainDelivery.failureCode); failureHash=$($snapshot.mainDelivery.failureHash); windowSeconds=$($snapshot.mainDelivery.windowSeconds)"
  } else {
    ""
  }
  $replyObligationDetail = if ($failed -contains "replyObligations") {
    "; replyObligationReason=$($snapshot.replyObligations.reason); open=$($snapshot.replyObligations.openCount); overdue=$($snapshot.replyObligations.overdueCount); deferred=$($snapshot.replyObligations.deferredCount); terminalFailures=$($snapshot.replyObligations.terminalFailureCount); latestOutcome=$($snapshot.replyObligations.latestFailureOutcome); latestFailureAt=$($snapshot.replyObligations.latestFailureAt); latestFailureKey=$($snapshot.replyObligations.latestFailureKey); latestError=$($snapshot.replyObligations.latestFailureError)"
  } else {
    ""
  }
  if ($disposition.action -eq "observing") {
    $detail = "components=$($failed -join ','); confirmation=$confirmationCount/$RequiredFailureConfirmations$inboxDetail$durableDetail$mainDeliveryDetail$replyObligationDetail"
    Save-Status -Snapshot $snapshot -Action "observing" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "heartbeat unhealthy $detail; waiting for confirmation"
    exit 0
  }

  if (Test-ReplyObligationFailureNonRestartable `
      -Failed $failed `
      -ReplyObligations $snapshot.replyObligations) {
    $detail = "components=$($failed -join ','); confirmation=$confirmationCount/$RequiredFailureConfirmations; repair=blocked_nonrestartable$replyObligationDetail$mainDeliveryDetail"
    Save-Status -Snapshot $snapshot -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "reply obligation failed terminally and cannot be repaired by a stack restart: $detail"
    exit 2
  }

  if (Test-MainDeliveryFailureNonRestartable -Failed $failed -MainDelivery $snapshot.mainDelivery) {
    $detail = "components=$($failed -join ','); confirmation=$confirmationCount/$RequiredFailureConfirmations; repair=blocked_nonrestartable$mainDeliveryDetail$replyObligationDetail"
    Save-Status -Snapshot $snapshot -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "main delivery failed terminally and cannot be repaired by a stack restart: $detail"
    exit 2
  }

  if (Test-CanaryFailureNonRestartable -Failed $failed -Canary $snapshot.canary) {
    $detail = "components=canary; checker_error=$($snapshot.canary.error); confirmation=$confirmationCount/$RequiredFailureConfirmations; repair=blocked_nonrestartable"
    Save-Status -Snapshot $snapshot -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "canary checker failed repeatedly and is not restart-repairable: $detail"
    exit 2
  }

  # A terminal delivery failure is diagnostic/non-restartable. When an
  # independent infrastructure fault is present, repair only that repairable
  # subset under the normal idle/budget policy, then re-read the ledger.
  $repairableFailed = @($failed | Where-Object { $_ -notin @("mainDelivery", "replyObligations") })
  $ignoreMainDeliveryDuringRepair = $failed -contains "mainDelivery"
  $ignoreReplyObligationsDuringRepair = $failed -contains "replyObligations"
  $currentSnapshot = Get-HealthSnapshot
  # Preserve the just-observed probe result; Get-HealthSnapshot only reads the
  # schedule summary and does not carry this run's localIds/action fields.
  Set-SnapshotCanaryResult -Snapshot $currentSnapshot -Canary $snapshot.canary
  $localRecoveryEligible = Test-LocalWeixinRecoveryEligible `
    -Failed $repairableFailed `
    -Snapshot $currentSnapshot
  $sourceRecoveryEligible = $repairableFailed.Count -eq 1 -and $repairableFailed[0] -eq "send-source"
  if ($currentSnapshot.healthy) {
    Reset-WatchdogFailureObservation -RecoveryState $recovery
    $recovery.lastHealthyAt = $currentSnapshot.checkedAt
    Save-RecoveryState -State $recovery
    Save-Status -Snapshot $currentSnapshot -Action "recovered_before_repair" -Detail "the confirmed anomaly cleared during the mandatory pre-repair recheck" -RecoveryState $recovery
    Write-WatchdogLog "confirmed anomaly cleared before repair; no budget was consumed"
    exit 0
  }
  $currentFailed = @(Get-WatchdogFailedComponents -Snapshot $currentSnapshot)
  if ($currentFailed.Count -eq 0) {
    $detail = "pre-repair snapshot is unhealthy but has no repairable component attribution; repair=blocked_nonrestartable"
    Save-Status -Snapshot $currentSnapshot -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 2
  }
  $currentFingerprint = Get-WatchdogFailureFingerprint -Failed $currentFailed -Snapshot $currentSnapshot
  if ($currentFingerprint -cne $failureFingerprint) {
    $newCount = Update-WatchdogFailureObservation -RecoveryState $recovery -Fingerprint $currentFingerprint
    Save-RecoveryState -State $recovery
    $detail = "fault changed during pre-repair recheck; previous=$failureFingerprint; current=$currentFingerprint; confirmation=$newCount/$RequiredFailureConfirmations"
    Save-Status -Snapshot $currentSnapshot -Action "observing" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 0
  }
  if (Test-UiAWaitingForWeixinSnapshot -Snapshot $currentSnapshot) {
    # A healthy UIA transport plus a live Weixin process but no strict main-chat
    # root means the desktop session is at login/account selection (or otherwise
    # lacks the logged-in chat window). Restarting the already-healthy core/UIA
    # cannot create that UI state and only burns the repair budget. Keep durable
    # notifications queued; a later heartbeat will drain them after readyz and
    # the desktop-idle gate both pass.
    $detail = "core stack is healthy; WeFlow UIA readyz is waiting for the logged-in main chat window; process restart skipped; restart notifications remain queued"
    Save-Status `
      -Snapshot $currentSnapshot `
      -Action "waiting_for_weixin_login" `
      -Detail $detail `
      -RecoveryState $recovery `
      -AdditionalGuardConstraint "weixin_chat_window_required"
    Write-WatchdogLog $detail
    exit 0
  }
  if (-not (Test-PipelineRepairIdleGate -Snapshot $currentSnapshot)) {
    $detail = "components=$($failed -join ','); repair=deferred_busy; activity=$($currentSnapshot.activity.reason); activeTurns=$($currentSnapshot.activity.activeTurnCount); deliveries=$($currentSnapshot.activity.activeDeliveryCount); pending=$($currentSnapshot.activity.pendingInboundCount)$inboxDetail$durableDetail"
    Save-Status -Snapshot $currentSnapshot -Action "deferred_busy" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "heartbeat repair deferred because the current pipeline snapshot is busy or uncertain: $detail"
    exit 0
  }
  $snapshot = $currentSnapshot

  $preferredRepairMode = if ($localRecoveryEligible) {
    "StartWeixin"
  } elseif ($sourceRecoveryEligible) {
    "ResetAzzySource"
  } else {
    ""
  }
  $repairPlan = Get-WatchdogRepairPlan `
    -Failed $repairableFailed `
    -RecoveryState $recovery `
    -Fingerprint $failureFingerprint `
    -PreferredMode $preferredRepairMode
  if ($repairPlan.blocked) {
    $blockedGate = Get-RecoveryGate -State $recovery
    $effectiveRetry = @([string]$repairPlan.retryAt, [string]$blockedGate.retryAt | ForEach-Object {
      ConvertTo-UtcDateOrNull $_
    } | Where-Object { $null -ne $_ } | Sort-Object | Select-Object -Last 1)
    $effectiveRetryAt = if ($effectiveRetry.Count -gt 0) { $effectiveRetry[0].ToString("o") } else { "" }
    $detail = "components=$($failed -join ','); fingerprint=$failureFingerprint; previousMode=$($recovery.lastRepairMode); previousOutcome=$($recovery.lastRepairOutcome); repair=exhausted_same_fault; retryAt=$effectiveRetryAt"
    Save-Status `
      -Snapshot $snapshot `
      -Action "circuit_open" `
      -Detail $detail `
      -RecoveryState $recovery `
      -NextRepairAllowedAtOverride $effectiveRetryAt `
      -AdditionalGuardConstraint ([string]$repairPlan.reason)
    Write-WatchdogLog $detail
    exit 2
  }
  $repairMode = [string]$repairPlan.mode

  $gate = Get-RecoveryGate -State $recovery
  if (-not $gate.allowed) {
    $action = if ($gate.reason -eq "cooldown") { "cooldown" } else { "circuit_open" }
    $detail = "components=$($failed -join ','); plannedRepair=$repairMode; reason=$($gate.reason); retryAt=$($gate.retryAt)$inboxDetail$durableDetail"
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
  Set-WatchdogRepairStarted `
    -RecoveryState $recovery `
    -Fingerprint $failureFingerprint `
    -RepairMode $repairMode `
    -RepairIdentity $attemptAt
  Add-RecoveryRepairAttemptJournal `
    -AttemptAt $attemptAt `
    -Fingerprint $failureFingerprint `
    -RepairMode $repairMode `
    -RepairIdentity $attemptAt
  Save-RecoveryState -State $recovery
  $repairStarted = $true
  if ($repairMode -in @("Restart", "FullRestart")) {
    $notification = Invoke-WatchdogRestartNotification `
      -Action "enqueue" `
      -RepairIdentity $attemptAt `
      -RepairMode $repairMode `
      -Components $failed
    if ([string]$notification.action -eq "error") {
      Write-WatchdogLog "restart notification enqueue failed identity=$attemptAt error=$($notification.error)"
    } else {
      Write-WatchdogLog "restart notification persisted identity=$attemptAt action=$($notification.action)"
      # Mark the durable event deliverable before the controller can stop any
      # process. If this watchdog is interrupted mid-restart, a later Once run
      # can drain the exact same idempotent obligation.
      $activation = Invoke-WatchdogRestartNotification `
        -Action "activate" `
        -RepairIdentity $attemptAt
      if ([string]$activation.action -eq "error") {
        Write-WatchdogLog "restart notification activation failed identity=$attemptAt error=$($activation.error)"
      } else {
        Write-WatchdogLog "restart notification activated identity=$attemptAt action=$($activation.action)"
      }
    }
  }
  Write-WatchdogLog "heartbeat unhealthy components=$($failed -join ','); fingerprint=$failureFingerprint; repair=$repairMode; escalated=$($repairPlan.escalated); allowed by guard"

  if ($repairMode -eq "StartWeixin") {
    Ensure-WeixinStarted
    Write-WatchdogLog "attempting local desktop WeChat recovery without restarting the Cyberboss stack"
    $localSnapshot = Wait-WatchdogInfrastructureRecovery `
      -TimeoutSeconds 20 `
      -IgnoreMainDelivery:$ignoreMainDeliveryDuringRepair `
      -IgnoreReplyObligations:$ignoreReplyObligationsDuringRepair
    if (Test-SnapshotInfrastructureHealthy -Snapshot $localSnapshot) {
      $localSnapshot = Invoke-PostRepairCanaryVerification `
        -Snapshot $localSnapshot `
        -RecoveryState $recovery `
        -RepairIdentity $attemptAt
    }
    if ([string]$localSnapshot.canary.action -eq "repair_verification_failed") {
      Save-PostRepairCanaryFailure -Snapshot $localSnapshot -RecoveryState $recovery -RepairMode "StartWeixin"
      exit 1
    }
    if ($localSnapshot.healthy) {
      Complete-VerifiedRepair -Snapshot $localSnapshot -RecoveryState $recovery -Detail ($failed -join ",")
      exit 0
    }
    if ((Test-SnapshotInfrastructureHealthy -Snapshot $localSnapshot) -and $recovery.pendingRepairVerification) {
      Save-RecoveryState -State $recovery
      $detail = "desktop WeChat recovered; post-repair canary is deferred action=$($localSnapshot.canary.action) nextDue=$($localSnapshot.canary.nextDueAt)"
      Save-Status -Snapshot $localSnapshot -Action "repair_verification_deferred" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 0
    }
    if (($ignoreMainDeliveryDuringRepair -or $ignoreReplyObligationsDuringRepair) `
      -and (Test-SnapshotInfrastructureHealthy `
        -Snapshot $localSnapshot `
        -IgnoreMainDelivery:$ignoreMainDeliveryDuringRepair `
        -IgnoreReplyObligations:$ignoreReplyObligationsDuringRepair) `
      -and (($ignoreMainDeliveryDuringRepair -and -not $localSnapshot.mainDelivery.healthy) `
        -or ($ignoreReplyObligationsDuringRepair -and -not $localSnapshot.replyObligations.healthy))) {
      $logicalComponents = @()
      if ($ignoreMainDeliveryDuringRepair -and -not $localSnapshot.mainDelivery.healthy) { $logicalComponents += "mainDelivery" }
      if ($ignoreReplyObligationsDuringRepair -and -not $localSnapshot.replyObligations.healthy) { $logicalComponents += "replyObligations" }
      Set-WatchdogRepairOutcome -RecoveryState $recovery -Outcome "infrastructure_recovered" -Completed
      Save-RecoveryState -State $recovery
      $detail = "components=$($logicalComponents -join ','); independent desktop WeChat recovery completed; logical delivery failure remains terminal$mainDeliveryDetail$replyObligationDetail"
      Save-Status -Snapshot $localSnapshot -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 2
    }

    $localFailed = @()
    if (-not $localSnapshot.uiaBridge.ready) { $localFailed += "uia" }
    if (-not $localSnapshot.weixin.alive) { $localFailed += "weixin" }
    Set-WatchdogRepairOutcome -RecoveryState $recovery -Outcome "waiting_for_login" -Completed
    Save-RecoveryState -State $recovery
    $detail = "components=$($localFailed -join ','); desktop WeChat process started but its logged-in chat window is not ready"
    Save-Status -Snapshot $localSnapshot -Action "waiting_for_weixin_login" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog "$detail; full stack restart skipped"
    exit 1
  }

  if ($repairMode -eq "ResetAzzySource") {
    Write-WatchdogLog "resetting the UIA send source to azzy without restarting healthy processes"
    Ensure-AzzySource
    $sourceSnapshot = Wait-WatchdogInfrastructureRecovery `
      -TimeoutSeconds 15 `
      -IgnoreMainDelivery:$ignoreMainDeliveryDuringRepair `
      -IgnoreReplyObligations:$ignoreReplyObligationsDuringRepair
    if (Test-SnapshotInfrastructureHealthy -Snapshot $sourceSnapshot) {
      $sourceSnapshot = Invoke-PostRepairCanaryVerification `
        -Snapshot $sourceSnapshot `
        -RecoveryState $recovery `
        -RepairIdentity $attemptAt
    }
    if ([string]$sourceSnapshot.canary.action -eq "repair_verification_failed") {
      Save-PostRepairCanaryFailure -Snapshot $sourceSnapshot -RecoveryState $recovery -RepairMode "ResetAzzySource"
      exit 1
    }
    if ($sourceSnapshot.healthy) {
      Complete-VerifiedRepair -Snapshot $sourceSnapshot -RecoveryState $recovery -Detail "send-source"
      exit 0
    }
    if ((Test-SnapshotInfrastructureHealthy -Snapshot $sourceSnapshot) -and $recovery.pendingRepairVerification) {
      $detail = "send source reset to azzy; post-repair canary deferred action=$($sourceSnapshot.canary.action) nextDue=$($sourceSnapshot.canary.nextDueAt)"
      Save-Status -Snapshot $sourceSnapshot -Action "repair_verification_deferred" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 0
    }
    if (($ignoreMainDeliveryDuringRepair -or $ignoreReplyObligationsDuringRepair) `
      -and (Test-SnapshotInfrastructureHealthy `
        -Snapshot $sourceSnapshot `
        -IgnoreMainDelivery:$ignoreMainDeliveryDuringRepair `
        -IgnoreReplyObligations:$ignoreReplyObligationsDuringRepair)) {
      Set-WatchdogRepairOutcome -RecoveryState $recovery -Outcome "infrastructure_recovered" -Completed
      Save-RecoveryState -State $recovery
      $detail = "send-source recovered independently; a terminal logical delivery condition remains$mainDeliveryDetail$replyObligationDetail"
      Save-Status -Snapshot $sourceSnapshot -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
      Write-WatchdogLog $detail
      exit 2
    }
    Set-WatchdogRepairOutcome -RecoveryState $recovery -Outcome "repair_failed" -Ineffective -Completed
    Save-RecoveryState -State $recovery
    $detail = "send source reset did not restore the verified Azzy pipeline"
    Save-Status -Snapshot $sourceSnapshot -Action "repair_failed" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 1
  }

  Ensure-WeixinStarted
  $repairStdout = Join-Path $StateDir "cyberboss-watchdog-repair.out.log"
  $repairStderr = Join-Path $StateDir "cyberboss-watchdog-repair.err.log"
  Remove-Item -LiteralPath $repairStdout, $repairStderr -Force -ErrorAction SilentlyContinue
  $repairProcess = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ServiceScript, "-Mode", $repairMode) `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $repairStdout `
    -RedirectStandardError $repairStderr
  if (-not $repairProcess.WaitForExit(120000)) {
    Stop-Process -Id $repairProcess.Id -Force -ErrorAction SilentlyContinue
    throw "$repairMode controller exceeded 120 seconds"
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
    throw "$repairMode returned exit code $repairExitCode"
  }
  Ensure-AzzySource
  $repaired = Wait-WatchdogInfrastructureRecovery `
    -TimeoutSeconds 30 `
    -IgnoreMainDelivery:$ignoreMainDeliveryDuringRepair `
    -IgnoreReplyObligations:$ignoreReplyObligationsDuringRepair
  if (Test-UiAWaitingForWeixinSnapshot -Snapshot $repaired) {
    Set-WatchdogRepairOutcome -RecoveryState $recovery -Outcome "waiting_for_uia" -Completed
    Save-RecoveryState -State $recovery
    $detail = "core stack recovered; WeFlow UIA bridge healthz is ready but readyz is waiting for the logged-in main chat window; restart notification remains queued"
    Save-Status -Snapshot $repaired -Action "waiting_for_weixin_login" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 0
  }
  if (Test-SnapshotInfrastructureHealthy -Snapshot $repaired) {
    $repaired = Invoke-PostRepairCanaryVerification `
      -Snapshot $repaired `
      -RecoveryState $recovery `
      -RepairIdentity $attemptAt
  }
  if ([string]$repaired.canary.action -eq "repair_verification_failed") {
    Save-PostRepairCanaryFailure -Snapshot $repaired -RecoveryState $recovery -RepairMode $repairMode
    exit 1
  }
  if ((Test-SnapshotInfrastructureHealthy -Snapshot $repaired) -and $recovery.pendingRepairVerification) {
    Save-RecoveryState -State $recovery
    $detail = "components=$($failed -join ','); $repairMode completed; post-repair canary deferred action=$($repaired.canary.action) nextDue=$($repaired.canary.nextDueAt)"
    Save-Status -Snapshot $repaired -Action "repair_verification_deferred" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 0
  }
  if (($ignoreMainDeliveryDuringRepair -or $ignoreReplyObligationsDuringRepair) `
    -and (Test-SnapshotInfrastructureHealthy `
      -Snapshot $repaired `
      -IgnoreMainDelivery:$ignoreMainDeliveryDuringRepair `
      -IgnoreReplyObligations:$ignoreReplyObligationsDuringRepair) `
    -and (($ignoreMainDeliveryDuringRepair -and -not $repaired.mainDelivery.healthy) `
      -or ($ignoreReplyObligationsDuringRepair -and -not $repaired.replyObligations.healthy))) {
    $logicalComponents = @()
    if ($ignoreMainDeliveryDuringRepair -and -not $repaired.mainDelivery.healthy) { $logicalComponents += "mainDelivery" }
    if ($ignoreReplyObligationsDuringRepair -and -not $repaired.replyObligations.healthy) { $logicalComponents += "replyObligations" }
    Set-WatchdogRepairOutcome -RecoveryState $recovery -Outcome "infrastructure_recovered" -Completed
    Save-RecoveryState -State $recovery
    $detail = "components=$($logicalComponents -join ','); $repairMode repaired independent components; logical delivery failure remains terminal$mainDeliveryDetail$replyObligationDetail"
    Save-Status -Snapshot $repaired -Action "pipeline_blocked" -Detail $detail -RecoveryState $recovery
    Write-WatchdogLog $detail
    exit 2
  }
  if (-not $repaired.healthy) {
    Set-WatchdogRepairOutcome -RecoveryState $recovery -Outcome "repair_failed" -Ineffective -Completed
    Save-RecoveryState -State $recovery
    Save-Status -Snapshot $repaired -Action "repair_failed" -Detail ($failed -join ",") -RecoveryState $recovery
    Write-WatchdogLog "repair verification unhealthy"
    exit 1
  }
  Complete-VerifiedRepair -Snapshot $repaired -RecoveryState $recovery -Detail ($failed -join ",")
  exit 0
} catch {
  $detail = $_.Exception.Message
  if ($repairStarted -and $null -ne $recovery) {
    try {
      Set-WatchdogRepairOutcome -RecoveryState $recovery -Outcome "controller_error" -Ineffective -Completed
      Save-RecoveryState -State $recovery
    } catch {
      $detail = "$detail; repair outcome persistence failed: $($_.Exception.Message)"
    }
  }
  $fallback = if ($snapshot) { $snapshot } else { [ordered]@{ checkedAt = (Get-Date).ToUniversalTime().ToString("o"); healthy = $false } }
  Save-Status -Snapshot $fallback -Action "error" -Detail $detail -RecoveryState $recovery
  Write-WatchdogLog "heartbeat error: $detail"
  exit 1
} finally {
  if ($hasMutex) { [void]$mutex.ReleaseMutex() }
  $mutex.Dispose()
}
