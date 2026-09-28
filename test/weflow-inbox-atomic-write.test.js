// 离线行为验证：writeJsonAtomic 在目标文件被别的进程占住（Windows 上 rename -> EPERM）时
// 是否会退避重试、以及重试到顶后是否走原地拷贝兜底，并且不留 .tmp 垃圾。
// 用 vm 加载 src/integrations/weflow-inbox.js 里真实的 writeJsonAtomic 文本，不重写实现。
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const { spawn } = require("child_process");

const SRC = path.join(__dirname, "..", "src", "integrations", "weflow-inbox.js");
const src = fs.readFileSync(SRC, "utf8");
const start = src.indexOf("async function writeJsonAtomic");
const end = src.indexOf("function delay(ms)");
if (start < 0 || end < 0 || end < start) {
  console.error("FAILED 无法从源文件切出 writeJsonAtomic 区块");
  process.exit(1);
}
const block = src.slice(start, end);

function loadWriteJsonAtomic(dir) {
  const warnings = [];
  const errors = [];
  const ctx = {
    fsPromises: fs.promises,
    process,
    path,
    console: {
      log: (...a) => warnings.push(a.join(" ")),
      warn: (...a) => warnings.push(a.join(" ")),
      error: (...a) => errors.push(a.join(" ")),
    },
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  vm.createContext(ctx);
  vm.runInContext(`${block}\nthis.writeJsonAtomic = writeJsonAtomic;`, ctx);
  return { write: ctx.writeJsonAtomic, warnings, errors };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 霸占目标文件的子进程：打开后写 ready 标记，holdMs 后释放。
function spawnHolder(target, readyFile, holdMs) {
  const script = `
const fs = require("fs");
const fd = fs.openSync(${JSON.stringify(target)}, "r");
fs.writeFileSync(${JSON.stringify(readyFile)}, "held");
setTimeout(function () { try { fs.closeSync(fd); } catch (e) {} process.exit(0); }, ${holdMs});
`;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

async function scenario(name, holdMs, expectFallback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
  const target = path.join(dir, "cursor.json");
  const ready = path.join(dir, "ready");
  fs.writeFileSync(target, JSON.stringify({ v: 0 }));
  const holder = spawnHolder(target, ready, holdMs);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready)) {
    if (Date.now() > deadline) throw new Error("holder 未就绪");
    await sleep(20);
  }
  const { write, warnings, errors } = loadWriteJsonAtomic(dir);
  const t0 = Date.now();
  let failure = null;
  try {
    await write(target, { v: 1, at: Date.now(), pad: "x".repeat(2000) });
  } catch (e) {
    failure = e;
  }
  const elapsed = Date.now() - t0;
  const body = failure ? null : JSON.parse(fs.readFileSync(target, "utf8"));
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  const fellBack = warnings.some((w) => /in-place|fallback|fell back/i.test(w));
  holder.kill();

  const checks = [
    ["写入成功", !failure],
    ["内容已更新", !!body && body.v === 1],
    ["无 .tmp 残留", leftovers.length === 0],
    ["走兜底路径符合预期", fellBack === expectFallback],
    ["无 stderr 错误", errors.length === 0],
  ];
  const bad = checks.filter(([, ok]) => !ok);
  console.log(
    `${bad.length ? "FAIL" : "PASS"} ${name} 耗时=${elapsed}ms 兜底=${fellBack} tmp残留=${leftovers.length}` +
      (failure ? ` 异常=${failure.code || failure.message}` : ""),
  );
  for (const [label, ok] of checks) if (!ok) console.log(`      未通过: ${label}`);
  if (fallbackWarn(warnings) && !fellBack) console.log("      警告样本:", warnings.slice(0, 2).join(" | "));
  fs.rmSync(dir, { recursive: true, force: true });
  return bad.length === 0;
}
function fallbackWarn(warnings) {
  return warnings.some((w) => /atomic|rename|EPERM/i.test(w));
}

(async () => {
  const results = [];
  // 短占用：退避重试应当救回来，不该走兜底
  results.push(await scenario("短占用(400ms) -> rename 重试成功", 400, false));
  // 长占用：重试到顶，必须走原地拷贝兜底，且不丢数据
  results.push(await scenario("长占用(2500ms) -> 原地拷贝兜底", 2500, true));
  console.log(results.every(Boolean) ? "ALL PASS" : "SOME FAILED");
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error("FAILED", e && e.stack ? e.stack : e);
  process.exit(1);
});
