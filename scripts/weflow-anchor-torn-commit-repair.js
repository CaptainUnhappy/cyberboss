#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCHEMA_VERSION = 1;
const REGISTRY_KEY = "HKCU\\Software\\WeFlow\\Runtime";
const REGISTRY_SUBKEY = "Software\\WeFlow\\Runtime";
const IDENTITY_PATTERN = /^[0-9a-f]{8,64}(?:-[0-9a-f]{8,64})+$/u;
const RUNTIME_NAME_PATTERN = /^anchor-v7-([0-9a-f]{8,64}(?:-[0-9a-f]{8,64})+)\.bin$/u;
const STATE_NAME_PATTERN = /^native-anchor-v7-([0-9a-f]{8,64}(?:-[0-9a-f]{8,64})+)\.bin$/u;
const REGISTRY_NAME_PATTERN = /^AnchorV7-([0-9a-f]{8,64}(?:-[0-9a-f]{8,64})+)$/u;
const MIN_ANCHOR_BYTES = 64;
const MAX_ANCHOR_BYTES = 8 * 1024;
const MIN_DEVICE_ROOT_BYTES = 64;
const MAX_DEVICE_ROOT_BYTES = 8 * 1024;
const BACKUP_FILE_NAMES = Object.freeze({
  deviceRoot: "device-root-v1.bin",
  runtime: "runtime-anchor.bin",
  state: "state-anchor.bin",
  registry: "registry-anchor.bin",
});

function analyzeWeFlowAnchor(options = {}, deps = {}) {
  return inspectWeFlowAnchor(options, deps).analysis;
}

function repairWeFlowAnchor(options = {}, deps = {}) {
  const initial = inspectWeFlowAnchor(options, deps);
  if (!initial.analysis.repairable || !initial.snapshot) {
    return {
      action: "Repair",
      status: "not_repairable",
      repaired: false,
      rollbackVerified: false,
      analysis: initial.analysis,
    };
  }

  let backup;
  try {
    backup = createAnchorBackup(initial.snapshot, options, deps);
  } catch (error) {
    return {
      action: "Repair",
      status: "backup_failed",
      repaired: false,
      rollbackVerified: false,
      analysis: initial.analysis,
      error: safeError(error),
    };
  }

  if (typeof deps.afterBackupVerified === "function") {
    deps.afterBackupVerified({
      backupDirectory: backup.directory,
      identity: initial.snapshot.identity,
    });
  }

  let immediatelyBeforeWrite;
  try {
    immediatelyBeforeWrite = inspectWeFlowAnchor(options, deps);
  } catch (error) {
    const result = {
      action: "Repair",
      status: "aborted_concurrent_change",
      repaired: false,
      rollbackVerified: false,
      backupDirectory: backup.directory,
      backupManifestSha256: backup.manifestSha256,
      analysis: initial.analysis,
      error: safeError(error),
    };
    writeRepairOutcomeBestEffort(backup.directory, result);
    return result;
  }

  if (!immediatelyBeforeWrite.analysis.repairable
      || !immediatelyBeforeWrite.snapshot
      || !snapshotsEqual(initial.snapshot, immediatelyBeforeWrite.snapshot)) {
    const result = {
      action: "Repair",
      status: "aborted_concurrent_change",
      repaired: false,
      rollbackVerified: false,
      backupDirectory: backup.directory,
      backupManifestSha256: backup.manifestSha256,
      analysis: immediatelyBeforeWrite.analysis,
    };
    writeRepairOutcomeBestEffort(backup.directory, result);
    return result;
  }

  const registry = resolveRegistryAdapter(options, deps);
  const desired = Buffer.from(initial.snapshot.runtime.data);
  const originalRegistry = Buffer.from(initial.snapshot.registry.data);
  let writeAttempted = false;
  try {
    writeAttempted = true;
    writeRegistryReplica(registry, initial.snapshot.registryName, desired);
    const verified = inspectWeFlowAnchor(options, deps);
    if (!verified.snapshot
        || verified.snapshot.identity !== initial.snapshot.identity
        || verified.analysis.status !== "consistent"
        || !verified.snapshot.runtime.data.equals(desired)
        || !verified.snapshot.state.data.equals(desired)
        || !verified.snapshot.registry.data.equals(desired)) {
      throw new Error("post-write three-replica verification failed");
    }

    const result = {
      action: "Repair",
      status: "repaired_verified",
      repaired: true,
      rollbackVerified: false,
      identity: initial.snapshot.identity,
      registryValueName: initial.snapshot.registryName,
      sourceSha256: sha256(desired),
      backupDirectory: backup.directory,
      backupManifestSha256: backup.manifestSha256,
      analysis: verified.analysis,
    };
    writeRepairOutcomeBestEffort(backup.directory, result);
    return result;
  } catch (repairError) {
    let rollbackVerified = false;
    let rollbackError = "";
    if (writeAttempted) {
      try {
        writeRegistryReplica(registry, initial.snapshot.registryName, originalRegistry);
        const restored = normalizeRegistryRead(
          registry.read(initial.snapshot.registryName),
          initial.snapshot.registryName,
        );
        rollbackVerified = restored.exists
          && restored.type === "REG_BINARY"
          && restored.data.equals(originalRegistry);
        if (!rollbackVerified) rollbackError = "registry rollback verification failed";
      } catch (error) {
        rollbackError = safeError(error);
      }
    }

    const result = {
      action: "Repair",
      status: rollbackVerified
        ? "repair_failed_registry_rolled_back"
        : "repair_failed_registry_rollback_unverified",
      repaired: false,
      rollbackVerified,
      identity: initial.snapshot.identity,
      registryValueName: initial.snapshot.registryName,
      backupDirectory: backup.directory,
      backupManifestSha256: backup.manifestSha256,
      error: safeError(repairError),
      rollbackError,
      analysis: initial.analysis,
    };
    writeRepairOutcomeBestEffort(backup.directory, result);
    return result;
  }
}

function inspectWeFlowAnchor(options = {}, deps = {}) {
  const layout = resolveLayout(options);
  const registry = resolveRegistryAdapter(options, deps);
  const base = {
    action: "Analyze",
    schemaVersion: SCHEMA_VERSION,
    healthy: false,
    repairable: false,
    status: "blocked",
    reason: "",
    identity: "",
    registryValueName: "",
    deviceRoot: { exists: false },
    replicas: {},
  };

  const deviceResult = tryReadStableRegularFile(layout.deviceRootPath);
  base.deviceRoot = publicFileMetadata(deviceResult);
  if (!deviceResult.exists) return blocked(base, "device_root_missing");
  if (!deviceResult.regular || deviceResult.symbolicLink) {
    return blocked(base, "device_root_not_regular_file");
  }
  if (!lengthInRange(deviceResult.data.length, MIN_DEVICE_ROOT_BYTES, MAX_DEVICE_ROOT_BYTES)) {
    return blocked(base, "device_root_length_invalid");
  }

  const runtimeScan = scanAnchorDirectory(layout.runtimeDir, "runtime");
  if (runtimeScan.error) return blocked(base, runtimeScan.error);
  const stateScan = scanAnchorDirectory(layout.stateDir, "state");
  if (stateScan.error) return blocked(base, stateScan.error);
  const registryScan = scanRegistryAnchors(registry);
  if (registryScan.error) return blocked(base, registryScan.error);

  if (runtimeScan.entries.length !== 1
      || stateScan.entries.length !== 1
      || registryScan.entries.length !== 1) {
    return blocked(base, "anchor_identity_cardinality_invalid", {
      identityCounts: {
        runtime: runtimeScan.entries.length,
        state: stateScan.entries.length,
        registry: registryScan.entries.length,
      },
    });
  }

  const identities = [
    runtimeScan.entries[0].identity,
    stateScan.entries[0].identity,
    registryScan.entries[0].identity,
  ];
  if (!identities.every((identity) => identity === identities[0])) {
    return blocked(base, "anchor_identity_mismatch");
  }
  const identity = identities[0];
  if (options.identity !== undefined && normalizeIdentity(options.identity) !== identity) {
    return blocked(base, "requested_identity_mismatch");
  }

  const runtime = tryReadStableRegularFile(runtimeScan.entries[0].path);
  const state = tryReadStableRegularFile(stateScan.entries[0].path);
  const registryName = registryScan.entries[0].name;
  const registryReplica = normalizeRegistryRead(registry.read(registryName), registryName);
  base.identity = identity;
  base.registryValueName = registryName;
  base.replicas = {
    runtime: publicFileMetadata(runtime),
    state: publicFileMetadata(state),
    registry: publicRegistryMetadata(registryReplica),
  };

  if (!runtime.exists || !state.exists || !registryReplica.exists) {
    return blocked(base, "replica_missing");
  }
  if (!runtime.regular || runtime.symbolicLink || !state.regular || state.symbolicLink) {
    return blocked(base, "anchor_file_not_regular");
  }
  if (registryReplica.type !== "REG_BINARY") {
    return blocked(base, "registry_value_type_invalid");
  }

  const replicas = [runtime.data, state.data, registryReplica.data];
  if (replicas.some((data) => !lengthInRange(data.length, MIN_ANCHOR_BYTES, MAX_ANCHOR_BYTES))) {
    return blocked(base, "anchor_length_invalid");
  }
  if (!replicas.every((data) => data.length === replicas[0].length)) {
    return blocked(base, "anchor_replica_lengths_differ");
  }

  const snapshot = {
    identity,
    registryName,
    deviceRoot: { path: layout.deviceRootPath, data: deviceResult.data },
    runtime: { path: runtimeScan.entries[0].path, data: runtime.data },
    state: { path: stateScan.entries[0].path, data: state.data },
    registry: { data: registryReplica.data },
  };

  if (runtime.data.equals(state.data) && runtime.data.equals(registryReplica.data)) {
    return {
      analysis: {
        ...base,
        healthy: true,
        status: "consistent",
        reason: "replicas_already_consistent",
      },
      snapshot,
    };
  }

  const runtimeEqualsState = runtime.data.equals(state.data);
  const runtimeEqualsRegistry = runtime.data.equals(registryReplica.data);
  const stateEqualsRegistry = state.data.equals(registryReplica.data);
  const hasExactlyOnePair = [runtimeEqualsState, runtimeEqualsRegistry, stateEqualsRegistry]
    .filter(Boolean).length === 1;
  if (!hasExactlyOnePair) return blocked(base, "no_unique_two_replica_majority");
  if (!runtimeEqualsState || runtimeEqualsRegistry || stateEqualsRegistry) {
    return blocked(base, "majority_is_not_two_anchor_files");
  }

  return {
    analysis: {
      ...base,
      repairable: true,
      status: "repairable_torn_commit",
      reason: "two_file_majority_registry_stale",
      plan: {
        sourceReplicas: ["runtime", "state"],
        targetReplica: "registry",
        sourceSha256: sha256(runtime.data),
        previousRegistrySha256: sha256(registryReplica.data),
        byteLength: runtime.data.length,
      },
    },
    snapshot,
  };
}

function scanAnchorDirectory(directory, kind) {
  if (!fs.existsSync(directory)) return { entries: [], error: `${kind}_anchor_directory_missing` };
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { entries: [], error: `${kind}_anchor_directory_invalid` };
  }
  const pattern = kind === "runtime" ? RUNTIME_NAME_PATTERN : STATE_NAME_PATTERN;
  const prefix = kind === "runtime" ? "anchor-v7-" : "native-anchor-v7-";
  const entries = [];
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!dirent.name.toLowerCase().startsWith(prefix)) continue;
    const match = pattern.exec(dirent.name);
    if (!match || !dirent.isFile() || dirent.isSymbolicLink()) {
      return { entries: [], error: `${kind}_anchor_name_or_type_invalid` };
    }
    entries.push({ identity: match[1], name: dirent.name, path: path.join(directory, dirent.name) });
  }
  return { entries, error: "" };
}

function scanRegistryAnchors(registry) {
  const listed = registry.list();
  if (!Array.isArray(listed)) return { entries: [], error: "registry_adapter_list_invalid" };
  const entries = [];
  for (const raw of listed) {
    const name = typeof raw === "string" ? raw : String(raw?.name || "");
    if (!name.toLowerCase().startsWith("anchorv7-")) continue;
    const match = REGISTRY_NAME_PATTERN.exec(name);
    if (!match) return { entries: [], error: "registry_anchor_name_invalid" };
    entries.push({ identity: match[1], name });
  }
  return { entries, error: "" };
}

function createAnchorBackup(snapshot, options = {}, deps = {}) {
  const backupRoot = resolveLayout(options).backupRoot;
  ensureSafeDirectory(backupRoot);
  const now = resolveNow(deps.now);
  const timestamp = now.toISOString().replace(/[-:.TZ]/gu, "");
  let directory = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const random = crypto.randomBytes(6).toString("hex");
    const candidate = path.join(backupRoot, `${timestamp}-${random}`);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      directory = candidate;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (!directory) throw new Error("could not allocate a unique backup directory");

  const sources = {
    deviceRoot: snapshot.deviceRoot.data,
    runtime: snapshot.runtime.data,
    state: snapshot.state.data,
    registry: snapshot.registry.data,
  };
  const fileMetadata = {};
  for (const [label, fileName] of Object.entries(BACKUP_FILE_NAMES)) {
    const data = Buffer.from(sources[label]);
    writeExclusiveDurable(path.join(directory, fileName), data);
    fileMetadata[label] = { file: fileName, byteLength: data.length, sha256: sha256(data) };
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "weflow-anchor-torn-commit-backup",
    createdAt: now.toISOString(),
    identity: snapshot.identity,
    registry: {
      key: REGISTRY_KEY,
      valueName: snapshot.registryName,
      type: "REG_BINARY",
    },
    repairPlan: {
      sourceReplicas: ["runtime", "state"],
      targetReplica: "registry",
      sourceSha256: sha256(snapshot.runtime.data),
      originalRegistrySha256: sha256(snapshot.registry.data),
    },
    files: fileMetadata,
  };
  const manifestRaw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestSha256 = sha256(manifestRaw);
  writeExclusiveDurable(path.join(directory, "manifest.json"), manifestRaw);
  writeExclusiveDurable(path.join(directory, "manifest.sha256"), Buffer.from(`${manifestSha256}\n`, "ascii"));
  fsyncDirectory(directory);

  const verification = verifyAnchorBackup(directory);
  if (!verification.verified || verification.manifestSha256 !== manifestSha256) {
    throw new Error("durable backup verification failed");
  }
  return { directory, manifestSha256 };
}

function verifyAnchorBackup(directory) {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("backup directory is not a regular directory");
  }
  const manifestResult = tryReadStableRegularFile(path.join(directory, "manifest.json"));
  const hashResult = tryReadStableRegularFile(path.join(directory, "manifest.sha256"));
  if (!manifestResult.exists || !manifestResult.regular || manifestResult.symbolicLink
      || !hashResult.exists || !hashResult.regular || hashResult.symbolicLink) {
    throw new Error("backup manifest or hash is missing");
  }
  const recordedHash = hashResult.data.toString("ascii").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(recordedHash) || sha256(manifestResult.data) !== recordedHash) {
    throw new Error("backup manifest hash mismatch");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestResult.data.toString("utf8"));
  } catch {
    throw new Error("backup manifest JSON is invalid");
  }
  validateBackupManifest(manifest);
  for (const [label, expectedFileName] of Object.entries(BACKUP_FILE_NAMES)) {
    const metadata = manifest.files[label];
    if (metadata.file !== expectedFileName) throw new Error("backup manifest file mapping is invalid");
    const file = tryReadStableRegularFile(path.join(directory, expectedFileName));
    if (!file.exists || !file.regular || file.symbolicLink
        || file.data.length !== metadata.byteLength
        || sha256(file.data) !== metadata.sha256) {
      throw new Error(`backup payload verification failed for ${label}`);
    }
  }
  return {
    verified: true,
    identity: manifest.identity,
    registryValueName: manifest.registry.valueName,
    manifestSha256: recordedHash,
  };
}

function validateBackupManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION
      || manifest.kind !== "weflow-anchor-torn-commit-backup"
      || !IDENTITY_PATTERN.test(String(manifest.identity || ""))
      || manifest.registry?.key !== REGISTRY_KEY
      || manifest.registry?.valueName !== `AnchorV7-${manifest.identity}`
      || manifest.registry?.type !== "REG_BINARY"
      || !manifest.files || typeof manifest.files !== "object") {
    throw new Error("backup manifest schema is invalid");
  }
  for (const label of Object.keys(BACKUP_FILE_NAMES)) {
    const metadata = manifest.files[label];
    if (!metadata || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1
        || !/^[0-9a-f]{64}$/u.test(String(metadata.sha256 || ""))) {
      throw new Error("backup manifest payload metadata is invalid");
    }
  }
  if (manifest.files.runtime.sha256 !== manifest.files.state.sha256
      || manifest.files.runtime.sha256 !== manifest.repairPlan?.sourceSha256
      || manifest.files.registry.sha256 !== manifest.repairPlan?.originalRegistrySha256
      || !Array.isArray(manifest.repairPlan?.sourceReplicas)
      || manifest.repairPlan.sourceReplicas.join(",") !== "runtime,state"
      || manifest.repairPlan.targetReplica !== "registry") {
    throw new Error("backup manifest repair plan is invalid");
  }
}

function createWindowsRegistryAdapter(options = {}) {
  const powershell = String(options.powershellPath || "powershell.exe");
  function invoke(script, invocationOptions = {}) {
    const result = spawnSync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      encoding: invocationOptions.binaryInput ? undefined : "utf8",
      input: invocationOptions.input,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(invocationOptions.env || {}) },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr.toString("utf8")
        : String(result.stderr || "");
      throw new Error(`registry adapter PowerShell failed (${result.status}): ${stderr.trim()}`);
    }
    return Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout || "");
  }

  return {
    list() {
      const script = [
        "$ErrorActionPreference='Stop'",
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${psSingleQuote(REGISTRY_SUBKEY)}',$false)`,
        "$items=@()",
        "if($null -ne $key){try{foreach($name in $key.GetValueNames()){$items += [ordered]@{name=$name;type=$key.GetValueKind($name).ToString()}}}finally{$key.Dispose()}}",
        "[Console]::Out.Write((ConvertTo-Json -InputObject @($items) -Compress))",
      ].join("; ");
      const raw = invoke(script).trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((entry) => ({
        name: String(entry.name || ""),
        type: normalizeRegistryType(entry.type),
      })) : [];
    },
    read(name) {
      assertRegistryValueName(name);
      const script = [
        "$ErrorActionPreference='Stop'",
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${psSingleQuote(REGISTRY_SUBKEY)}',$false)`,
        "$result=[ordered]@{exists=$false;type='';dataBase64=''}",
        "if($null -ne $key){try{$name=$env:CYBERBOSS_WEFLOW_ANCHOR_VALUE;if($key.GetValueNames() -contains $name){$kind=$key.GetValueKind($name);$value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$result.exists=$true;$result.type=$kind.ToString();if($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary){$result.dataBase64=[Convert]::ToBase64String([byte[]]$value)}}}finally{$key.Dispose()}}",
        "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
      ].join("; ");
      const parsed = JSON.parse(invoke(script, {
        env: { CYBERBOSS_WEFLOW_ANCHOR_VALUE: name },
      }).trim());
      return {
        exists: Boolean(parsed.exists),
        type: normalizeRegistryType(parsed.type),
        data: parsed.dataBase64 ? Buffer.from(String(parsed.dataBase64), "base64") : Buffer.alloc(0),
      };
    },
    write(name, data) {
      assertRegistryValueName(name);
      const bytes = toBuffer(data, "registry write data");
      if (!lengthInRange(bytes.length, MIN_ANCHOR_BYTES, MAX_ANCHOR_BYTES)) {
        throw new Error("registry write data length is invalid");
      }
      const script = [
        "$ErrorActionPreference='Stop'",
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${psSingleQuote(REGISTRY_SUBKEY)}',$true)`,
        "if($null -eq $key){throw 'WeFlow Runtime registry key is missing'}",
        "try{$name=$env:CYBERBOSS_WEFLOW_ANCHOR_VALUE;if(-not ($key.GetValueNames() -contains $name)){throw 'anchor registry value is missing'};if($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::Binary){throw 'anchor registry value is not REG_BINARY'};$stdin=[Console]::OpenStandardInput();$memory=New-Object System.IO.MemoryStream;$stdin.CopyTo($memory);$bytes=$memory.ToArray();$key.SetValue($name,$bytes,[Microsoft.Win32.RegistryValueKind]::Binary);$key.Flush()}finally{if($null -ne $memory){$memory.Dispose()};$key.Dispose()}",
      ].join("; ");
      invoke(script, {
        binaryInput: true,
        input: bytes,
        env: { CYBERBOSS_WEFLOW_ANCHOR_VALUE: name },
      });
    },
  };
}

function normalizeRegistryRead(raw, expectedName) {
  if (!raw || typeof raw !== "object") throw new Error("registry adapter read result is invalid");
  const exists = Boolean(raw.exists);
  const type = normalizeRegistryType(raw.type);
  const data = exists && type === "REG_BINARY" ? toBuffer(raw.data, "registry replica") : Buffer.alloc(0);
  if (exists && !type) throw new Error(`registry adapter omitted type for ${expectedName}`);
  return { exists, type, data };
}

function normalizeRegistryType(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "BINARY" || normalized === "REG_BINARY") return "REG_BINARY";
  return normalized ? `REG_${normalized.replace(/^REG_/u, "")}` : "";
}

function writeRegistryReplica(registry, name, data) {
  assertRegistryValueName(name);
  const before = normalizeRegistryRead(registry.read(name), name);
  if (!before.exists || before.type !== "REG_BINARY") {
    throw new Error("anchor registry value disappeared or changed type");
  }
  registry.write(name, Buffer.from(data), { type: "REG_BINARY" });
}

function resolveRegistryAdapter(options, deps) {
  const adapter = deps.registryAdapter || options.registryAdapter;
  if (adapter) {
    if (typeof adapter.list !== "function"
        || typeof adapter.read !== "function"
        || typeof adapter.write !== "function") {
      throw new Error("registry adapter must expose list, read, and write");
    }
    return adapter;
  }
  if (process.platform !== "win32") {
    throw new Error("the default WeFlow registry adapter requires Windows");
  }
  return createWindowsRegistryAdapter(options);
}

function resolveLayout(options = {}) {
  const localAppData = String(options.localAppData || process.env.LOCALAPPDATA || "").trim();
  const weflowRoot = options.weflowRoot
    ? path.resolve(String(options.weflowRoot))
    : localAppData
      ? path.resolve(localAppData, "WeFlow")
      : "";
  if (!weflowRoot) throw new Error("LOCALAPPDATA or weflowRoot is required");
  const securityDir = path.resolve(String(options.securityDir || path.join(weflowRoot, "Security")));
  const runtimeDir = path.resolve(String(options.runtimeDir || path.join(weflowRoot, "Runtime")));
  const stateDir = path.resolve(String(options.stateDir || path.join(weflowRoot, "State")));
  const backupRoot = path.resolve(String(options.backupRoot
    || path.join(os.homedir(), ".cyberboss", "weflow-anchor-recovery")));
  return {
    weflowRoot,
    deviceRootPath: path.resolve(String(options.deviceRootPath || path.join(securityDir, "device-root-v1.bin"))),
    runtimeDir,
    stateDir,
    backupRoot,
  };
}

function tryReadStableRegularFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, regular: false, symbolicLink: false, data: Buffer.alloc(0) };
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    return { exists: true, regular: before.isFile(), symbolicLink: before.isSymbolicLink(), data: Buffer.alloc(0) };
  }
  const descriptor = fs.openSync(filePath, "r");
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new Error("file changed type while opening");
    const data = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (opened.size !== after.size || data.length !== after.size
        || (opened.ino && after.ino && opened.ino !== after.ino)
        || (opened.dev && after.dev && opened.dev !== after.dev)) {
      throw new Error("file changed while it was read");
    }
    return { exists: true, regular: true, symbolicLink: false, data };
  } finally {
    fs.closeSync(descriptor);
  }
}

function publicFileMetadata(result) {
  const output = {
    exists: Boolean(result.exists),
    regularFile: Boolean(result.regular),
    symbolicLink: Boolean(result.symbolicLink),
  };
  if (result.exists && result.regular && !result.symbolicLink) {
    output.byteLength = result.data.length;
    output.sha256 = sha256(result.data);
  }
  return output;
}

function publicRegistryMetadata(result) {
  const output = { exists: Boolean(result.exists), type: result.type || "" };
  if (result.exists && result.type === "REG_BINARY") {
    output.byteLength = result.data.length;
    output.sha256 = sha256(result.data);
  }
  return output;
}

function blocked(base, reason, extra = {}) {
  return { analysis: { ...base, ...extra, status: "blocked", reason }, snapshot: null };
}

function snapshotsEqual(left, right) {
  return left.identity === right.identity
    && left.registryName === right.registryName
    && left.deviceRoot.data.equals(right.deviceRoot.data)
    && left.runtime.data.equals(right.runtime.data)
    && left.state.data.equals(right.state.data)
    && left.registry.data.equals(right.registry.data);
}

function ensureSafeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("backup root is not a regular directory");
  }
}

function writeExclusiveDurable(filePath, data) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeRepairOutcomeBestEffort(directory, result) {
  try {
    const publicResult = JSON.parse(JSON.stringify(result));
    const raw = Buffer.from(`${JSON.stringify(publicResult, null, 2)}\n`, "utf8");
    const resultPath = path.join(directory, "repair-result.json");
    if (!fs.existsSync(resultPath)) writeExclusiveDurable(resultPath, raw);
    const hashPath = path.join(directory, "repair-result.sha256");
    if (!fs.existsSync(hashPath)) {
      writeExclusiveDurable(hashPath, Buffer.from(`${sha256(raw)}\n`, "ascii"));
    }
    fsyncDirectory(directory);
  } catch {
    // The immutable verified backup is authoritative even if outcome recording fails.
  }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some filesystems do not expose directory fsync.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function lengthInRange(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function normalizeIdentity(value) {
  const identity = String(value || "").trim();
  if (!IDENTITY_PATTERN.test(identity)) throw new Error("anchor identity format is invalid");
  return identity;
}

function assertRegistryValueName(name) {
  const value = String(name || "");
  const match = REGISTRY_NAME_PATTERN.exec(value);
  if (!match || `AnchorV7-${normalizeIdentity(match[1])}` !== value) {
    throw new Error("anchor registry value name is invalid");
  }
}

function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`${label} must be binary data`);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  const parsed = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("current time is invalid");
  return parsed;
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error || "unknown error");
  return text.replace(/[\r\n]+/gu, " ").slice(0, 500);
}

function psSingleQuote(value) {
  return String(value).replaceAll("'", "''");
}

function parseArgs(argv) {
  const result = { action: "Analyze", requestFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--action") result.action = String(argv[++index] || "").trim();
    else if (token === "--request-file") result.requestFile = String(argv[++index] || "").trim();
  }
  return result;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const options = args.requestFile
    ? JSON.parse(fs.readFileSync(path.resolve(args.requestFile), "utf8"))
    : {};
  const action = args.action.toLowerCase();
  if (action === "analyze") return analyzeWeFlowAnchor(options);
  if (action === "repair") return repairWeFlowAnchor(options);
  throw new Error(`unsupported action: ${args.action}`);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(runCli())}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ action: "error", error: safeError(error) })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BACKUP_FILE_NAMES,
  MAX_ANCHOR_BYTES,
  MIN_ANCHOR_BYTES,
  analyzeWeFlowAnchor,
  createWindowsRegistryAdapter,
  repairWeFlowAnchor,
  verifyAnchorBackup,
};

