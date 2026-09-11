const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const launcherPath = path.join(projectRoot, "scripts", "cyberboss-watchdog-hidden.vbs");
const watchdogPath = path.join(projectRoot, "scripts", "cyberboss-watchdog.ps1");
const taskInstallerPath = path.join(projectRoot, "scripts", "install-cyberboss-watchdog-task.ps1");
const serviceLauncherPath = path.join(projectRoot, "scripts", "cyberboss-service-launcher.cmd");

test("hidden watchdog launcher resolves a non-interactive PowerShell command without running it", {
  skip: process.platform !== "win32",
}, () => {
  const result = spawnSync("cscript.exe", ["//NoLogo", launcherPath, "--print-command"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WindowsPowerShell\\v1\.0\\powershell\.exe"/iu);
  assert.match(result.stdout, /-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File/iu);
  assert.ok(result.stdout.includes(`"${watchdogPath}" -Mode Once`));
});

test("hidden watchdog launcher uses WScript Run window style zero and waits for completion", () => {
  const source = fs.readFileSync(launcherPath, "utf8");

  assert.match(source, /shell\.Run\(command,\s*0,\s*True\)/iu);
  assert.match(source, /shell\.CurrentDirectory\s*=\s*scriptDirectory/iu);
  assert.doesNotMatch(source, /WScript\.Shell\.Exec|cmd(?:\.exe)?\s+\/c/iu);
});

test("manual service BAT entry points are thin, mode-specific wrappers", () => {
  const entryPoints = new Map([
    ["Cyberboss-Full-Start.bat", "Start"],
    ["Cyberboss-Start.bat", "Start"],
    ["Cyberboss-Restart.bat", "Restart"],
    ["Cyberboss-Full-Restart.bat", "FullRestart"],
    ["Cyberboss-Stop.bat", "Stop"],
    ["Cyberboss-Status.bat", "Status"],
  ]);

  for (const [fileName, mode] of entryPoints) {
    const source = fs.readFileSync(path.join(projectRoot, fileName), "utf8");
    assert.match(source, /cyberboss-service-launcher\.cmd/iu, fileName);
    assert.ok(source.includes(`" ${mode}`), `${fileName} must delegate mode ${mode}`);
    assert.doesNotMatch(source, /powershell\.exe|wscript\.exe|cyberboss-watchdog-hidden\.vbs/iu, fileName);
    assert.doesNotMatch(source, /cmd(?:\.exe)?\s+\/k|\bstart\s+"/iu, fileName);
    assert.doesNotMatch(source, /Akasha-WeChat|wechat-weflow-bridge|WeFlow\.exe|Weixin\.exe|main\.py|127\.0\.0\.1|\b(?:5031|8765|8766)\b/iu, fileName);
  }
});

test("shared manual service launcher owns PowerShell policy without legacy component startup", () => {
  const source = fs.readFileSync(serviceLauncherPath, "utf8");

  for (const mode of ["Start", "Restart", "FullRestart", "Stop", "Status"]) {
    assert.match(source, new RegExp(`\\b${mode}\\b`, "u"));
  }
  assert.match(source, /powershell\.exe\s+-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File/iu);
  assert.match(source, /cyberboss-service\.ps1/iu);
  assert.match(source, /-Mode\s+"%CYBERBOSS_SERVICE_MODE%"/iu);
  assert.match(source, /CYBERBOSS_NO_PAUSE/iu);
  assert.doesNotMatch(source, /cmd(?:\.exe)?\s+\/k|\bstart\s+"/iu);
  assert.doesNotMatch(source, /Akasha-WeChat|wechat-weflow-bridge|WeFlow\.exe|Weixin\.exe|main\.py|127\.0\.0\.1|\b(?:5031|8765|8766)\b/iu);
});

test("manual watchdog entry stays visible and separate from the hidden scheduled launcher", () => {
  const source = fs.readFileSync(path.join(projectRoot, "Cyberboss-Watchdog-Run-Now.bat"), "utf8");
  assert.match(source, /powershell\.exe/iu);
  assert.match(source, /pause/iu);
  assert.doesNotMatch(source, /wscript\.exe|cyberboss-watchdog-hidden\.vbs/iu);
});

test("watchdog task installer fixes hidden interactive execution and bounded scheduling policy", {
  skip: process.platform !== "win32",
}, () => {
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    taskInstallerPath,
    "-PrintDefinition",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const definition = JSON.parse(result.stdout.trim());
  assert.equal(definition.taskName, "Cyberboss Heartbeat Watchdog");
  assert.match(definition.executable, /\\System32\\wscript\.exe$/iu);
  assert.ok(definition.arguments.includes("//B //NoLogo"));
  assert.ok(definition.arguments.includes("cyberboss-watchdog-hidden.vbs"));
  assert.equal(definition.logonType, "InteractiveToken");
  assert.equal(definition.runLevel, "Limited");
  assert.equal(definition.repetitionInterval, "PT2M");
  assert.equal(definition.multipleInstances, "IgnoreNew");
  assert.equal(definition.executionTimeLimit, "PT10M");

  const source = fs.readFileSync(taskInstallerPath, "utf8");
  assert.match(source, /New-ScheduledTaskAction[\s\S]+?-Execute \$WscriptPath/iu);
  assert.match(source, /New-ScheduledTaskTrigger[\s\S]+?-RepetitionInterval \$RepetitionInterval/iu);
  assert.match(source, /New-ScheduledTaskPrincipal[\s\S]+?-LogonType Interactive[\s\S]+?-RunLevel Limited/iu);
  assert.match(source, /New-ScheduledTaskSettingsSet[\s\S]+?-MultipleInstances IgnoreNew[\s\S]+?-ExecutionTimeLimit \$ExecutionTimeLimit/iu);
  assert.match(source, /ShouldProcess\(\$TaskName,[\s\S]+?Register-ScheduledTask/iu);
});
