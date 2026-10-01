// Keep the iLink end-to-end listener armed.
//
// The listener must be running *before* an inbound message arrives: `getupdates`
// does not replay history, so a message that lands while nothing is polling is
// gone for good. Any unhandled throw therefore costs the whole opportunity, so
// this wrapper restarts the listener on exit and keeps a durable trace.
//
// Usage: node weixin-listen-forever.mjs [--minutes N] [--gap-ms N]
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const E2E = 'D:\\Projects\\cyberboss\\scripts\\weixin-ilink-e2e.mjs';
const LOG = 'D:\\Projects\\cyberboss\\tmp\\weixin-listen-forever.log';
const E2E_LOG = 'D:\\Projects\\cyberboss\\tmp\\weixin-e2e.log';
const FILE = 'C:\\Users\\79388\\.cyberboss\\outbox\\xiaohongshu-6a90368b-wechat.mp4';

/** Did the child actually reach the matrix? The log is the only reliable tell. */
function logHas(marker) {
  try {
    return readFileSync(E2E_LOG, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try { appendFileSync(LOG, `${stamped}\n`); } catch { /* best effort */ }
}

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const minutes = argOf('--minutes', '180');
const gapMs = argOf('--gap-ms', '4000');

let run = 0;
for (;;) {
  run += 1;
  log(`--- listener run #${run} (window ${minutes}m, gap ${gapMs}ms)`);
  const child = spawn(process.execPath, [
    E2E,
    '--file', FILE,
    '--video', FILE,
    '--minutes', String(minutes),
    '--sequential',
    '--gap-ms', String(gapMs),
  ], { stdio: 'inherit', cwd: 'D:\\Projects\\cyberboss' });

  const code = await new Promise((resolve) => {
    child.on('error', (error) => {
      log(`spawn error: ${error?.message || error}`);
      resolve(-1);
    });
    child.on('exit', (c) => resolve(c ?? -1));
  });

  log(`--- listener run #${run} exited with code ${code}`);

  // Exit codes: 0 = the matrix ran and the decisive send was accepted,
  //             1 = the matrix ran but was rejected, 2 = session expired (-14),
  //             3 = window elapsed with no inbound.
  //
  // On Windows a force-killed process also settles as exit code 1, so code 1 is
  // ambiguous: it can mean "the matrix ran and failed" or "someone stopped us".
  // The log is the tiebreaker — a run that reached the matrix always prints the
  // MATRIX RESULT banner.
  const ran = logHas('MATRIX RESULT');
  if (ran || code === 0 || code === 2) {
    log(ran
      ? 'stopping: the matrix already ran; results are in weixin-e2e.log.'
      : code === 2
        ? 'stopping: the provider session is gone and needs a QR re-pair.'
        : 'stopping: the decisive send was accepted.');
    break;
  }

  log('re-arming in 5s…');
  await new Promise((r) => setTimeout(r, 5000));
}
