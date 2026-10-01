const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");
const { resolveAttachmentLimitsPatchPath, resolveAcpModelPatchPath } = require("../src/adapters/runtime/dsh");

/**
 * DSH's shipped `maxImageDimension` is 8192, and the sdk profile composes
 * `@deepseek-ai/dsh-attachment-local` with no config, so a single image side over
 * that is refused outright:
 *
 *   Image exceeds the configured per-side pixel limit. (IMAGE_DIMENSION_TOO_LARGE)
 *
 * A real 1260x8318 WeChat long screenshot hit exactly that - refused for
 * exceeding a side limit by 126 px while using 10.5 MP of a 64 MP budget and
 * 1.2 MB of a 20 MB budget. A per-side limit is the wrong invariant for long
 * screenshots, so the overlay raises it out of the way and leaves the pixel
 * budget as the bound that actually protects memory.
 *
 * `--patch` merges by id and an id that does not exist is a silent no-op, so the
 * overlay text alone proves nothing: the composed config is asserted too.
 */
const projectRoot = path.resolve(__dirname, "..");
const overlays = [
  { label: "attachment limits", file: resolveAttachmentLimitsPatchPath() },
  { label: "acp model pin", file: resolveAcpModelPatchPath() },
  { label: "approval answerer", file: path.join(projectRoot, "dsh-plugins", "cyberboss-approval", "main.patch.yml") },
];

function dumpComposedConfig(patchPaths) {
  const dshBin = defaultDshBin();
  if (!dshBin || !fs.existsSync(dshBin)) return null;
  const args = [dshBin, "--profile", "sdk"];
  for (const patchPath of patchPaths) args.push("--patch", patchPath);
  args.push("--dump-config");
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
}

test("every overlay the adapter hands to DSH exists", () => {
  // A missing overlay is fatal, not degraded: cordis resolves an insert's name
  // relative to the profile directory, so DSH exits 5 and the runtime is gone.
  for (const overlay of overlays) {
    assert.equal(fs.existsSync(overlay.file), true, `${overlay.label} overlay is missing: ${overlay.file}`);
  }
});

test("the attachment overlay raises the side limit and keeps the pixel budget as the bound", () => {
  const source = fs.readFileSync(resolveAttachmentLimitsPatchPath(), "utf8");
  assert.match(source, /^- id: attachment-local$/mu, "the overlay must target the real composed id");
  const dimension = /^\s*maxImageDimension:\s*(\d+)\s*$/mu.exec(source);
  const pixels = /^\s*maxImagePixels:\s*(\d+)\s*$/mu.exec(source);
  assert.ok(dimension, "maxImageDimension must be set explicitly");
  assert.ok(pixels, "maxImagePixels must be stated so the effective bound is visible");
  assert.ok(Number(dimension[1]) >= 32768,
    `the side limit must clear ordinary long screenshots, got ${dimension[1]}`);
  assert.equal(Number(pixels[1]), 64 * 1024 * 1024,
    "the pixel budget is what protects memory and must stay at its default");
  // Admission may widen; the model must still receive a normalized image.
  assert.doesNotMatch(source, /normalizedImageMax/u,
    "widening admission must not also raise the normalization target");
});

test("the composed main-runtime config carries the raised limits", {
  skip: process.platform === "win32" ? false : "the overlay is validated on Windows",
}, () => {
  const result = dumpComposedConfig([resolveAttachmentLimitsPatchPath()]);
  assert.ok(result, "dsh must be resolvable: without it this limit is unverified");
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const composed = result.stdout;
  const block = /- id: attachment-local\r?\n([\s\S]*?)(?=\r?\n- id: |\r?\n# ==)/u.exec(composed);
  assert.ok(block, "attachment-local must be composed into the sdk profile");
  assert.match(block[1], /maxImageDimension:\s*32768/u,
    "the composed config did not take the raised side limit");
  assert.match(block[1], /maxImagePixels:\s*67108864/u);
});

test("the overlays do not collide and both compose together", () => {
  // The adapter always applies the attachment overlay and may add the approval
  // one; a bad merge would take the runtime down rather than degrade it.
  const present = overlays.filter((overlay) => fs.existsSync(overlay.file));
  const result = dumpComposedConfig(present.map((overlay) => overlay.file));
  assert.ok(result, "dsh must be resolvable");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /- id: attachment-local/u);
});
