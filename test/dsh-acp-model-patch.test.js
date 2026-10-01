const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");
const {
  resolveAcpModelPatchPath,
  resolveAttachmentLimitsPatchPath,
} = require("../src/adapters/runtime/dsh");

/**
 * The ACP profile composes `@deepseek-ai/dsh-acp` with `model: deepseek-v4-flash`,
 * whose catalog entry has no image input modality. `supportsAcpImagePrompts()` then
 * advertises `promptCapabilities.image: false`, so any inline image prompt is
 * rejected with "Invalid params: inline image prompts were not advertised by this
 * connection" and the whole turn fails (measured 2026-09-30).
 *
 * `deepseek-flash` is the catalog's image-capable flash model (display name
 * "DeepSeek-V41-Flash", `inputModalities: [text, image]`), and the live endpoint
 * confirmed it reads an image while `deepseek-v4-pro` answers "我无法查看图片内容".
 *
 * `--patch` merges by id and a wrong id is a silent no-op, so the composed config is
 * asserted rather than the overlay text alone.
 */
const projectRoot = path.resolve(__dirname, "..");

function dumpAcpConfig(patchPaths) {
  const dshBin = defaultDshBin();
  if (!dshBin || !fs.existsSync(dshBin)) return null;
  const args = [dshBin, "--profile", "acp"];
  for (const patchPath of patchPaths) args.push("--patch", patchPath);
  args.push("--dump-config");
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
}

test("the ACP model overlay exists and targets the composed acp plugin", () => {
  const overlayPath = resolveAcpModelPatchPath();
  assert.equal(fs.existsSync(overlayPath), true, `overlay is missing: ${overlayPath}`);
  const source = fs.readFileSync(overlayPath, "utf8");
  assert.match(source, /^- id: acp$/mu, "the overlay must target the real composed id");
  assert.match(source, /^\s{4}model:\s+deepseek-flash\s*$/mu,
    "the overlay must pin the image-capable flash model");
});

test("the composed ACP profile carries the image-capable model", {
  skip: process.platform === "win32" ? false : "the overlay is validated on Windows",
}, () => {
  const result = dumpAcpConfig([resolveAttachmentLimitsPatchPath(), resolveAcpModelPatchPath()]);
  assert.ok(result, "dsh must be resolvable: without it this model pin is unverified");
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const block = /- id: acp\r?\n([\s\S]*?)(?=\r?\n- id: |\r?\n# ==|$)/u.exec(result.stdout);
  assert.ok(block, "the acp plugin must be composed into the acp profile");
  assert.match(block[1], /model:\s+deepseek-flash/u,
    "the composed config still pins a model without image input");
  assert.doesNotMatch(block[1], /model:\s+deepseek-v4-flash\s*$/mu,
    "the text-only flash model must not survive composition");
});
