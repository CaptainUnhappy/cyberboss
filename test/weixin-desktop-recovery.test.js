const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const serviceScript = path.join(projectRoot, "scripts", "cyberboss-service.ps1");
const watchdogScript = path.join(projectRoot, "scripts", "cyberboss-watchdog.ps1");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `${command} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

test("WeFlow window selection accepts a hidden logged-in chat window but rejects a login card", () => {
  const source = [
    "from scripts.weflow_window_selection import is_wechat_chat_window_geometry as geometry, is_wechat_main_window_identity as identity, select_wechat_window_handle as choose",
    "assert choose([(10, True, False)], require_chat_window=True) == 0",
    "assert choose([(10, True, False), (20, False, True)], require_chat_window=True) == 20",
    "assert choose([(20, False, True), (30, True, True)], require_chat_window=True) == 0",
    "assert choose([(10, True, False)], require_chat_window=False) == 10",
    "assert geometry('Qt51514QWindowIcon', 159, 27, is_iconic=True, normal_width=894, normal_height=647)",
    "assert not geometry('Qt51514QWindowIcon', 159, 27, is_iconic=True, normal_width=218, normal_height=247)",
    "assert not geometry('Qt51514QWindowIcon', 218, 247)",
    "assert geometry('mmui::MainWindow', 0, 0)",
    "assert identity(class_name='mmui::MainWindow', control_type_name='WindowControl')",
    "assert not identity(class_name='mmui::SearchMsgWindow', control_type_name='WindowControl')",
    "assert not identity(class_name='mmui::MainWindow', control_type_name='PaneControl')",
    "assert choose([(40, True, geometry('Qt51514QWindowIcon', 159, 27, is_iconic=True, normal_width=894, normal_height=647))], require_chat_window=True) == 40",
    "print('ok')",
  ].join("\n");
  assert.equal(run("python", ["-c", source]), "ok");
});

test("PowerShell service and watchdog scripts remain syntactically valid", () => {
  const scriptPaths = [serviceScript, watchdogScript]
    .map((filePath) => `'${filePath.replaceAll("'", "''")}'`)
    .join(", ");
  const source = [
    "$failed = $false",
    `foreach ($path in @(${scriptPaths})) {`,
    "  $tokens = $null; $errors = $null",
    "  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)",
    "  if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_) }; $failed = $true }",
    "}",
    "if ($failed) { exit 1 }",
  ].join("; ");
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", source]);
});

test("service process identity accepts quoted and unquoted managed script paths", () => {
  const escapedPath = serviceScript.replaceAll("'", "''");
  const source = [
    "$ErrorActionPreference='Stop'",
    "$env:CYBERBOSS_SERVICE_LIBRARY_ONLY='1'",
    `. '${escapedPath}'`,
    "$quotedUia='python.exe \"C:\\Fixture Root\\cyberboss\\scripts\\weflow-uia-bridge.py\" --host 127.0.0.1 --port 8766'",
    "$unquotedUia='python.exe D:\\cyberboss\\scripts\\weflow-uia-bridge.py --host 127.0.0.1 --port 8766'",
    "$quotedLauncher='\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Fixture Root\\cyberboss\\scripts\\shared-start.js\"'",
    "$unquotedLauncher='node.exe D:\\cyberboss\\scripts\\shared-start.js'",
    "if ($quotedUia -notmatch $WeFlowUiaCommandPattern) { exit 2 }",
    "if ($unquotedUia -notmatch $WeFlowUiaCommandPattern) { exit 3 }",
    "if ($quotedLauncher -notmatch $SharedStartCommandPattern) { exit 4 }",
    "if ($unquotedLauncher -notmatch $SharedStartCommandPattern) { exit 5 }",
  ].join("; ");
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source]);
});

test("service starts desktop WeChat before the dependent service stack", () => {
  const source = fs.readFileSync(serviceScript, "utf8");
  const functionStart = source.indexOf("function Start-CyberbossService");
  const switchStart = source.indexOf("function Invoke-ServiceControllerMode", functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(switchStart, -1);
  const body = source.slice(functionStart, switchStart);
  const weixinStart = body.indexOf("Ensure-WeixinStarted");
  const weflowStart = body.indexOf("Ensure-WeFlowReady");
  assert.ok(weixinStart >= 0);
  assert.ok(weflowStart > weixinStart);
  assert.match(source, /Get-Process -Name "Weixin"[\s\S]+?return[\s\S]+?Start-Process -FilePath \$weixinExe/u);
});

test("service library accepts conventional true flags and treats disabled WeFlow/UIA as healthy", () => {
  const escapedPath = serviceScript.replaceAll("'", "''");
  const source = [
    "$ErrorActionPreference='Stop'",
    "$env:CYBERBOSS_SERVICE_LIBRARY_ONLY='1'",
    `. '${escapedPath}'`,
    "$script:fixtureFlag=''",
    "function global:Get-ProjectEnvValue { param([string]$Name) return $script:fixtureFlag }",
    "$flags=@()",
    "foreach($candidate in @('1','true','TRUE','yes','on','0','false','')){$script:fixtureFlag=$candidate;$flags += [pscustomobject]@{candidate=$candidate;value=(Test-ProjectEnvFlag -Name 'fixture')}} ",
    "function global:Test-ProjectEnvFlag { param([string]$Name) return $false }",
    "function global:Read-PidFile { param([string]$Path) return 123 }",
    "function global:Test-PidAlive { param([int]$PidValue) return $true }",
    "function global:Test-VerifiedPidAlive { param([int]$PidValue,[string]$CommandPattern) return $true }",
    "function global:Test-Ready { return $true }",
    "function global:Test-WeFlowUiaReady { return $true }",
    "function global:Test-WeFlowFunctionalReady { return $true }",
    "$status=Show-ServiceStatus 6>$null",
    "$value=[ordered]@{flags=$flags;status=$status};$value|ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");
  const result = JSON.parse(run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source]));
  assert.deepEqual(result.flags.map(({ value }) => value), [true, true, true, true, true, false, false, false]);
  assert.equal(result.status, true);
});

test("service restart validates first, reconciles PID metadata, uses hidden process-tree cleanup, and rolls back only new children", () => {
  const source = fs.readFileSync(serviceScript, "utf8");
  const controllerStart = source.indexOf("function Invoke-ServiceControllerMode");
  const controller = source.slice(controllerStart);
  const restartCase = controller.slice(controller.indexOf('"Restart"'), controller.indexOf('"FullRestart"'));
  const fullRestartCase = controller.slice(controller.indexOf('"FullRestart"'), controller.indexOf("default"));
  assert.ok(restartCase.indexOf("Assert-ServiceStartPrerequisites") < restartCase.indexOf("Stop-CyberbossComponents"));
  assert.ok(fullRestartCase.indexOf("Assert-ServiceStartPrerequisites") < fullRestartCase.indexOf("Stop-CyberbossComponents"));
  assert.match(source, /function Repair-PidFileFromListener[\s\S]+?Write-PidFileAtomic/u);
  assert.match(source, /function Repair-BridgePidFileFromActivity[\s\S]+?fresh pipeline activity PID/u);
  assert.match(source, /function Invoke-TaskkillProcessTree[\s\S]+?CreateNoWindow = \$true[\s\S]+?RedirectStandardError = \$true/u);
  assert.match(source, /Invoke-TaskkillProcessTree -PidValue \$pidValue[\s\S]+?Invoke-TaskkillProcessTree -PidValue \$pidValue -Force/u);
  assert.doesNotMatch(source, /&\s+\$taskkill/u);
  const startFunction = source.slice(
    source.indexOf("function Start-CyberbossService"),
    source.indexOf("function Invoke-ServiceControllerMode"),
  );
  assert.match(startFunction, /\$baseline = \[pscustomobject\]/u);
  assert.match(startFunction, /Stop-NewCyberbossComponents -Baseline \$baseline -LauncherPid \$launcherPid/u);
  assert.doesNotMatch(startFunction, /Partial startup was rolled back;[\s\S]+?Stop-CyberbossComponents/u);
});

test("FullRestart runs the exact torn-commit repair only after shutdown verification and without a visible console", () => {
  const source = fs.readFileSync(serviceScript, "utf8");
  const controller = source.slice(source.indexOf("function Invoke-ServiceControllerMode"));
  const fullRestart = controller.slice(controller.indexOf('"FullRestart"'), controller.indexOf("default"));
  const stopCore = fullRestart.indexOf("Stop-CyberbossComponents");
  const stopWeFlow = fullRestart.indexOf("Stop-WeFlowProcesses");
  const closedCheck = fullRestart.indexOf("if ($openEndpoints.Count -gt 0)");
  const repair = fullRestart.indexOf("Invoke-WeFlowAnchorTornCommitRepair");
  const start = fullRestart.indexOf("Start-CyberbossService");
  assert.ok(stopCore >= 0 && stopWeFlow > stopCore);
  assert.ok(closedCheck > stopWeFlow);
  assert.ok(repair > closedCheck);
  assert.ok(start > repair);

  const repairFunction = source.slice(
    source.indexOf("function Invoke-WeFlowAnchorTornCommitRepair"),
    source.indexOf("function Stop-CyberbossComponents"),
  );
  assert.match(repairFunction, /--action", "repair"/u);
  assert.match(repairFunction, /-WindowStyle Hidden/u);
  assert.match(repairFunction, /status -notin @\("not_repairable", "repaired_verified"\)/u);
  assert.match(repairFunction, /finally \{[\s\S]+?Remove-Item -LiteralPath \$requestFile, \$stdoutFile, \$stderrFile/u);
});

test("anchor helper launch preserves quoted project and state paths", {
  skip: process.platform !== "win32",
}, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss helper path "));
  try {
    const scriptsDir = path.join(fixtureRoot, "Project With Spaces", "scripts");
    const stateDir = path.join(fixtureRoot, "State With Spaces");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const copiedService = path.join(scriptsDir, "cyberboss-service.ps1");
    fs.copyFileSync(serviceScript, copiedService);
    fs.writeFileSync(path.join(scriptsDir, "weflow-anchor-torn-commit-repair.js"), [
      "const fs = require('node:fs');",
      "const index = process.argv.indexOf('--request-file');",
      "if (index < 0 || !process.argv[index + 1]) process.exit(2);",
      "JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));",
      "process.stdout.write(JSON.stringify({ action: 'Repair', status: 'not_repairable', repaired: false }) + '\\n');",
    ].join("\n"), "utf8");

    const escapedService = copiedService.replaceAll("'", "''");
    const escapedState = stateDir.replaceAll("'", "''");
    const source = [
      "$ErrorActionPreference='Stop'",
      "$env:CYBERBOSS_SERVICE_LIBRARY_ONLY='1'",
      `. '${escapedService}'`,
      `$global:StateDir='${escapedState}'`,
      "$global:WeFlowEndpoint=[pscustomobject]@{IsLoopback=$true}",
      "function global:Test-ProjectEnvFlag { param([string]$Name);return $true }",
      "$result=Invoke-WeFlowAnchorTornCommitRepair -NodeCommand 'node.exe'",
      "if([string]$result.status -ne 'not_repairable'){exit 7}",
      "if(Get-ChildItem -LiteralPath $global:StateDir -Filter 'weflow-anchor-repair.*' -ErrorAction SilentlyContinue){exit 8}",
    ].join("; ");
    run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source]);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("health-reachable WeFlow message degradation is preserved instead of recycled", () => {
  const escapedPath = serviceScript.replaceAll("'", "''");
  const source = [
    "$ErrorActionPreference='Stop'",
    "$env:CYBERBOSS_SERVICE_LIBRARY_ONLY='1'",
    `. '${escapedPath}'`,
    "$global:stopCalls=0;$global:startCalls=0",
    "$global:WeFlowEndpoint=[pscustomobject]@{IsLoopback=$true;Host='127.0.0.1';Port=5031}",
    "function global:Test-ProjectEnvFlag { param([string]$Name);return $true }",
    "function global:Test-WeFlowFunctionalReady { return $false }",
    "function global:Test-WeFlowHealthReady { return $true }",
    "function global:Test-WeFlowOwnsApiPort { return $true }",
    "function global:Stop-WeFlowProcesses { $global:stopCalls+=1 }",
    "function global:Start-Process { $global:startCalls+=1 }",
    "$state=Ensure-WeFlowReady 6>$null",
    "$value=[ordered]@{status=$state.Status;healthReady=$state.HealthReady;functionalReady=$state.FunctionalReady;degraded=$state.Degraded;reason=$state.Reason;stopCalls=$global:stopCalls;startCalls=$global:startCalls}",
    "$value|ConvertTo-Json -Compress",
  ].join("; ");
  const result = JSON.parse(run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source]));
  assert.deepEqual(result, {
    status: "degraded",
    healthReady: true,
    functionalReady: false,
    degraded: true,
    reason: "weflow_message_query_unavailable",
    stopCalls: 0,
    startCalls: 0,
  });
});

test("partial recovery starts the core stack and returns degraded without rollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-partial-start-"));
  try {
    const escapedPath = serviceScript.replaceAll("'", "''");
    const escapedTemp = tempDir.replaceAll("'", "''");
    const source = [
      "$ErrorActionPreference='Stop'",
      "$env:CYBERBOSS_SERVICE_LIBRARY_ONLY='1'",
      `. '${escapedPath}'`,
      `$global:StateDir='${escapedTemp}';$global:LogDir=Join-Path $global:StateDir 'logs'`,
      "$global:BridgePidFile=Join-Path $global:LogDir 'bridge.pid';$global:AppServerPidFile=Join-Path $global:LogDir 'app.pid';$global:WeFlowUiaBridgePidFile=Join-Path $global:LogDir 'uia.pid'",
      "$global:WeFlowEndpoint=[pscustomobject]@{IsLoopback=$true;Host='127.0.0.1';Port=5031};$global:WeFlowUiaEndpoint=[pscustomobject]@{IsLoopback=$true;Host='127.0.0.1';Port=8766}",
      "$global:fixtureLaunched=$false;$global:rollbackCalls=0",
      "function global:Repair-ManagedPidFiles {}",
      "function global:Assert-ServiceStartPrerequisites {}",
      "function global:Ensure-WeixinStarted {}",
      "function global:Ensure-WeFlowReady { return New-WeFlowStartupState -Status 'degraded' -HealthReady $true -FunctionalReady $false -Reason 'weflow_message_query_unavailable' }",
      "function global:Read-PidFile { param([string]$Path);if($Path -eq $global:BridgePidFile){return 101};if($Path -eq $global:AppServerPidFile){return 102};return 103 }",
      "function global:Test-PidAlive { param([int]$PidValue);return $global:fixtureLaunched -and $PidValue -eq 4444 }",
      "function global:Test-VerifiedPidAlive { param([int]$PidValue,[string]$CommandPattern);return $true }",
      "function global:Get-VerifiedManagedPid { param([string]$PidFile,[string]$CommandPattern);return 0 }",
      "function global:Test-ProjectEnvFlag { param([string]$Name);return $true }",
      "function global:Test-Ready { return $true }",
      "function global:Test-WeFlowUiaReady { return $true }",
      "function global:Test-WeFlowUiaHealthReady { return $true }",
      "function global:Test-WeFlowFunctionalReady { return $false }",
      "function global:Test-WeFlowHealthReady { return $true }",
      "function global:Start-Sleep { param([int]$Milliseconds,[int]$Seconds) }",
      "function global:Assert-CommandAvailable { param([string]$Command,[string]$Label);return 'Invoke-FixtureLauncher' }",
      "function global:Invoke-FixtureLauncher { param([Parameter(ValueFromRemainingArguments=$true)]$Remaining);$global:fixtureLaunched=$true;$global:LASTEXITCODE=0;return '4444' }",
      "function global:Stop-NewCyberbossComponents { param($Baseline,[int]$LauncherPid);$global:rollbackCalls+=1 }",
      "$outcome=Start-CyberbossService 6>$null",
      "$value=[ordered]@{launched=$global:fixtureLaunched;rollbackCalls=$global:rollbackCalls;healthy=$outcome.Healthy;degraded=$outcome.Degraded;reason=$outcome.Reason}",
      "$value|ConvertTo-Json -Compress",
    ].join("; ");
    const result = JSON.parse(run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source]));
    assert.deepEqual(result, {
      launched: true,
      rollbackCalls: 0,
      healthy: false,
      degraded: true,
      reason: "weflow_message_query_unavailable",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("degraded startup remains visibly unhealthy and controller outcome is non-success", () => {
  const escapedPath = serviceScript.replaceAll("'", "''");
  const source = [
    "$ErrorActionPreference='Stop'",
    "$env:CYBERBOSS_SERVICE_LIBRARY_ONLY='1'",
    `. '${escapedPath}'`,
    "$global:WeFlowEndpoint=[pscustomobject]@{IsLoopback=$true};$global:WeFlowUiaEndpoint=[pscustomobject]@{IsLoopback=$true}",
    "function global:Read-PidFile { param([string]$Path);return 123 }",
    "function global:Test-PidAlive { param([int]$PidValue);return $true }",
    "function global:Test-VerifiedPidAlive { param([int]$PidValue,[string]$CommandPattern);return $true }",
    "function global:Test-Ready { return $true }",
    "function global:Test-ProjectEnvFlag { param([string]$Name);return $true }",
    "function global:Test-WeFlowUiaReady { return $true }",
    "function global:Test-WeFlowFunctionalReady { return $false }",
    "function global:Test-WeFlowHealthReady { return $true }",
    "$statusOutput=@(Show-ServiceStatus 6>&1);$status=[bool]($statusOutput|Where-Object { $_ -is [bool] }|Select-Object -Last 1);$statusMessages=@($statusOutput|Where-Object { $_ -isnot [bool] })",
    "$degradedRejected=$false;$errorText=''",
    "try { Assert-ServiceStartOutcome -Outcome ([pscustomobject]@{Healthy=$false;Degraded=$true;Reason='weflow_message_query_unavailable'}) } catch { $degradedRejected=$true;$errorText=$_.Exception.Message }",
    "Assert-ServiceStartOutcome -Outcome ([pscustomobject]@{Healthy=$true;Degraded=$false;Reason=''})",
    "$uiaDeferred=$false;try { Assert-ServiceStartOutcome -Outcome ([pscustomobject]@{Healthy=$false;Degraded=$true;Reason='weflow_uia_not_ready'}) 6>$null;$uiaDeferred=$true } catch {}",
    "$value=[ordered]@{status=$status;text=(($statusMessages|ForEach-Object { [string]$_ }) -join [Environment]::NewLine);degradedRejected=$degradedRejected;uiaDeferred=$uiaDeferred;errorText=$errorText;dispositions=@((Get-ServiceStartupDisposition -CoreReady $true -WeFlowFunctionalReady $true -WeFlowHealthReady $true),(Get-ServiceStartupDisposition -CoreReady $true -WeFlowFunctionalReady $false -WeFlowHealthReady $true),(Get-ServiceStartupDisposition -CoreReady $true -WeFlowFunctionalReady $false -WeFlowHealthReady $false),(Get-ServiceStartupDisposition -CoreReady $true -WeFlowFunctionalReady $true -WeFlowHealthReady $true -UiaReady $false))}",
    "$value|ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");
  const result = JSON.parse(run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source]));
  assert.equal(result.status, false);
  assert.match(result.text, /WeFlow API: DEGRADED \(health OK, message query DOWN\)/u);
  assert.equal(result.degradedRejected, true);
  assert.equal(result.uiaDeferred, true);
  assert.match(result.errorText, /overall service health remains DOWN/u);
  assert.deepEqual(result.dispositions, ["healthy", "degraded", "waiting", "uia_degraded"]);
});

test("controller reports degraded only after core startup returns, outside rollback scope", () => {
  const source = fs.readFileSync(serviceScript, "utf8");
  const startFunction = source.slice(
    source.indexOf("function Start-CyberbossService"),
    source.indexOf("function Assert-ServiceStartOutcome"),
  );
  const degradedBranch = startFunction.slice(
    startFunction.indexOf('if ($startupDisposition -eq "degraded")'),
    startFunction.indexOf("if (-not (Test-PidAlive", startFunction.indexOf('if ($startupDisposition -eq "degraded")')),
  );
  assert.match(degradedBranch, /return \[pscustomobject\][\s\S]+?Healthy = \$false[\s\S]+?Degraded = \$true/u);
  assert.doesNotMatch(degradedBranch, /throw/u);

  const controller = source.slice(source.indexOf("function Invoke-ServiceControllerMode"));
  for (const marker of ['"Restart"', '"FullRestart"', "default"]) {
    const begin = controller.indexOf(marker);
    const nextMarkers = ['"Restart"', '"FullRestart"', "default"]
      .map((candidate) => controller.indexOf(candidate, begin + marker.length))
      .filter((index) => index >= 0);
    const end = nextMarkers.length > 0 ? Math.min(...nextMarkers) : controller.length;
    const block = controller.slice(begin, end);
    assert.ok(block.indexOf("$startResult = Start-CyberbossService") >= 0, `${marker} must capture startup outcome`);
    assert.ok(
      block.indexOf("Assert-ServiceStartOutcome -Outcome $startResult") > block.indexOf("$startResult = Start-CyberbossService"),
      `${marker} must report degradation after startup returns`,
    );
  }
  assert.match(source, /if \(-not \$WeFlowEndpoint\.IsLoopback\) \{[\s\S]+?Test-WeFlowHealthReady/u);
});

test("taskkill diagnostics stay out of PowerShell's terminating error stream", {
  skip: process.platform !== "win32",
}, () => {
  const escapedPath = serviceScript.replaceAll("'", "''");
  const source = [
    "$ErrorActionPreference='Stop'",
    "$env:CYBERBOSS_SERVICE_LIBRARY_ONLY='1'",
    `. '${escapedPath}'`,
    "$result=Invoke-TaskkillProcessTree -PidValue 2147483647",
    "$value=[ordered]@{exitCode=$result.ExitCode;hasError=(-not [string]::IsNullOrWhiteSpace($result.StandardError))}",
    "$value|ConvertTo-Json -Compress",
  ].join("; ");
  const result = JSON.parse(run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source]));
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.hasError, true);
});

test("process-tree shutdown accepts child taskkill errors once the verified root exits", {
  skip: process.platform !== "win32",
}, () => {
  const escapedPath = serviceScript.replaceAll("'", "''");
  const source = [
    "$ErrorActionPreference='Stop'",
    "$env:CYBERBOSS_SERVICE_LIBRARY_ONLY='1'",
    `. '${escapedPath}'`,
    "$global:fixtureAliveChecks=0;$global:fixtureKills=@();$global:fixtureRemoved=0",
    "function global:Test-PidAlive { param([int]$PidValue);$global:fixtureAliveChecks+=1;return $global:fixtureAliveChecks -lt 10 }",
    "function global:Get-ProcessCommandLine { param([int]$PidValue);return 'node D:\\Projects\\cyberboss\\bin\\cyberboss.js start' }",
    "function global:Invoke-TaskkillProcessTree { param([int]$PidValue,[switch]$Force);$global:fixtureKills += [pscustomobject]@{pid=$PidValue;force=[bool]$Force};return [pscustomobject]@{ExitCode=128;StandardOutput='';StandardError='a child process was already exiting'} }",
    "function global:Remove-PidFileIfMatches { param([string]$Path,[int]$PidValue);$global:fixtureRemoved+=1 }",
    "function global:Start-Sleep { param([int]$Milliseconds,[int]$Seconds) }",
    "Stop-VerifiedPidValue -Label 'fixture' -PidValue 4242 -PidFile 'fixture.pid' -CommandPattern 'cyberboss\\.js\\s+start' 6>$null",
    "$value=[ordered]@{aliveChecks=$global:fixtureAliveChecks;kills=$global:fixtureKills;removed=$global:fixtureRemoved}",
    "$value|ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");
  const result = JSON.parse(run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source]));
  assert.equal(result.aliveChecks, 10);
  assert.deepEqual(result.kills.map(({ force }) => force), [false, true]);
  assert.equal(result.removed, 1);
});

test("watchdog reserves minimal local recovery for a sole desktop WeChat failure", () => {
  const escapedPath = watchdogScript.replaceAll("'", "''");
  const source = [
    `$path = '${escapedPath}'`,
    "$tokens = $null; $errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)",
    "$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-LocalWeixinRecoveryEligible' }, $true)",
    "Invoke-Expression $function.Extent.Text",
    "if (Test-LocalWeixinRecoveryEligible -Failed @('uia')) { exit 2 }",
    "if (Test-LocalWeixinRecoveryEligible -Failed @('uia', 'weixin')) { exit 3 }",
    "if (-not (Test-LocalWeixinRecoveryEligible -Failed @('weixin'))) { exit 7 }",
    "if (Test-LocalWeixinRecoveryEligible -Failed @()) { exit 4 }",
    "if (Test-LocalWeixinRecoveryEligible -Failed @('uia', 'app-server')) { exit 5 }",
    "if (Test-LocalWeixinRecoveryEligible -Failed @('send-source')) { exit 6 }",
  ].join("; ");
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", source]);
});

test("watchdog marks an old UTF-8 WeFlow pending event stale without flagging a short media wait", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-queue-"));
  const staleCursor = path.join(tempDir, "stale.json");
  const freshCursor = path.join(tempDir, "fresh.json");
  try {
    fs.writeFileSync(staleCursor, `${JSON.stringify({
      version: 3,
      pendingEvents: [
        { key: "消息:旧视频", push: { timestamp: 1_799_999_600, content: "[视频]" } },
        { key: "message:newer", push: { timestamp: 1_799_999_900, content: "稍后消息" } },
      ],
      outgoingPollCursor: { polledThrough: 1_800_000_000, backfillActive: false },
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(freshCursor, `${JSON.stringify({
      version: 3,
      pendingEvents: [{
        key: "message:fresh-media",
        push: { timestamp: 1_799_999_880, content: "[图片]" },
        pairing: { status: "locked", anchorKey: "message:fresh-media" },
      }],
      outgoingPollCursor: { polledThrough: 1_800_000_000, backfillActive: false },
    }, null, 2)}\n`, "utf8");
    const fixtureNow = new Date(1_800_000_000 * 1000);
    fs.utimesSync(staleCursor, fixtureNow, fixtureNow);
    fs.utimesSync(freshCursor, fixtureNow, fixtureNow);

    const escapedScript = watchdogScript.replaceAll("'", "''");
    const escapedStale = staleCursor.replaceAll("'", "''");
    const escapedFresh = freshCursor.replaceAll("'", "''");
    const source = [
      `$path = '${escapedScript}'`,
      "$tokens = $null; $errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)",
      "$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-InboxQueueHealth' }, $true)",
      "Invoke-Expression $function.Extent.Text",
      "$OutgoingPollStaleSeconds = 30",
      "$now = [DateTimeOffset]::FromUnixTimeSeconds(1800000000)",
      `$stale = Get-InboxQueueHealth -Path '${escapedStale}' -StaleAfterSeconds 300 -Now $now`,
      "if ($stale.healthy) { exit 2 }",
      "if ($stale.pendingCount -ne 2) { exit 3 }",
      "if ($stale.oldestAgeSeconds -ne 400) { exit 4 }",
      "if ($stale.oldestAge -ne 400) { exit 10 }",
      "if ($stale.oldestKey -ne '消息:旧视频') { exit 5 }",
      "if ($stale.reason -ne 'stale_pending_event') { exit 6 }",
      `$fresh = Get-InboxQueueHealth -Path '${escapedFresh}' -StaleAfterSeconds 300 -Now $now`,
      "if (-not $fresh.healthy) { exit 7 }",
      "if ($fresh.pendingCount -ne 1) { exit 8 }",
      "if ($fresh.oldestAgeSeconds -ne 120) { exit 9 }",
    ].join("; ");
    run("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", source]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a confirmed stale inbox backlog uses guarded targeted Restart rather than FullRestart", () => {
  const escapedPath = watchdogScript.replaceAll("'", "''");
  const source = [
    `$path = '${escapedPath}'`,
    "$tokens = $null; $errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)",
    "$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Get-WatchdogFailureDisposition','Get-WatchdogRepairMode') }, $true)",
    "$functions | ForEach-Object { Invoke-Expression $_.Extent.Text }",
    "$first = Get-WatchdogFailureDisposition -Failed @('inboxQueue') -ConsecutiveFailures 1 -RequiredConfirmations 2",
    "if ($first.action -ne 'observing' -or $first.shouldRepair) { exit 2 }",
    "$confirmed = Get-WatchdogFailureDisposition -Failed @('inboxQueue') -ConsecutiveFailures 2 -RequiredConfirmations 2",
    "if ($confirmed.action -ne 'repair' -or -not $confirmed.shouldRepair) { exit 3 }",
    "if ((Get-WatchdogRepairMode -Failed @('inboxQueue')) -ne 'Restart') { exit 6 }",
    "$mixed = Get-WatchdogFailureDisposition -Failed @('inboxQueue', 'app-server') -ConsecutiveFailures 2 -RequiredConfirmations 2",
    "if ($mixed.action -ne 'repair' -or -not $mixed.shouldRepair) { exit 4 }",
    "if ((Get-WatchdogRepairMode -Failed @('inboxQueue','app-server')) -ne 'Restart') { exit 7 }",
    "if ((Get-WatchdogRepairMode -Failed @('inboxQueue','weflow')) -ne 'FullRestart') { exit 8 }",
  ].join("; ");
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", source]);

  const watchdogSource = fs.readFileSync(watchdogScript, "utf8");
  const mainRepairFlow = watchdogSource.indexOf("$preferredRepairMode =");
  const repairPlanSelection = watchdogSource.indexOf("Get-WatchdogRepairPlan", mainRepairFlow);
  const repairModeSelection = watchdogSource.indexOf("$repairMode = [string]$repairPlan.mode", repairPlanSelection);
  const repairBudgetMutation = watchdogSource.indexOf("$attemptAt =", repairModeSelection);
  const repairInvocation = watchdogSource.indexOf('"-Mode", $repairMode', repairBudgetMutation);
  assert.ok(mainRepairFlow >= 0);
  assert.ok(repairPlanSelection >= 0);
  assert.ok(repairBudgetMutation >= 0);
  assert.ok(repairModeSelection > repairPlanSelection);
  assert.ok(repairBudgetMutation > repairModeSelection);
  assert.ok(repairInvocation > repairBudgetMutation);
  assert.doesNotMatch(watchdogSource.slice(repairBudgetMutation, repairInvocation + 30), /Get-WatchdogRepairMode/u);
});
