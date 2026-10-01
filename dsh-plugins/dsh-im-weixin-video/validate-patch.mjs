// Validate and optionally apply a unified diff.
//
// Validation is what `git apply --check` does: for every hunk the declared line
// counts must match the body, and every context/removed line must match the
// target file at the declared position. Apply mode then writes the result, so a
// patch can be proven to reproduce an intended tree byte for byte.
//
// Usage:
//   node validate-patch.mjs <patch> <treeRoot>            # check only
//   node validate-patch.mjs <patch> <treeRoot> --apply    # check, then write
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [patchPath, treeRoot, ...flags] = process.argv.slice(2);
const shouldApply = flags.includes('--apply');
if (!patchPath || !treeRoot) {
  console.error('usage: validate-patch.mjs <patch> <treeRoot> [--apply]');
  process.exit(2);
}

const lines = readFileSync(patchPath, 'utf8').split('\n');
if (lines.at(-1) === '') lines.pop();

/** @type {Map<string, {from: number, to: number, text: string}[]>} */
const editsByFile = new Map();
let currentFile = null;
let failures = 0;
let hunks = 0;

const isHunkEnd = (body) => (
  body.startsWith('@@')
  || body.startsWith('diff --git ')
  || /^--- (a\/|\/dev\/null)/.test(body)
  || /^\+\+\+ (b\/|\/dev\/null)/.test(body)
);

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];

  if (line.startsWith('diff --git ')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    currentFile = m ? m[2] : null;
    continue;
  }
  if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('index ')) continue;
  if (!line.startsWith('@@')) continue;
  hunks += 1;

  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) {
    console.log(`FAIL  ${currentFile}: unparseable hunk header: ${line}`);
    failures += 1;
    continue;
  }
  const oldStart = Number(m[1]);
  const declaredOld = m[2] === undefined ? 1 : Number(m[2]);
  const declaredNew = m[4] === undefined ? 1 : Number(m[4]);

  let oldSeen = 0;
  let newSeen = 0;
  /** Replacement text for the old span: context lines plus added lines. */
  const replacement = [];
  let j = i + 1;
  for (; j < lines.length && !isHunkEnd(lines[j]); j += 1) {
    const body = lines[j];
    if (body.startsWith('+')) {
      newSeen += 1;
      replacement.push(body.slice(1));
    } else if (body.startsWith('-')) {
      oldSeen += 1;
    } else if (body.startsWith(' ')) {
      oldSeen += 1;
      newSeen += 1;
      replacement.push(body.slice(1));
    } else if (body === '') {
      oldSeen += 1;
      newSeen += 1;
      replacement.push('');
    } else {
      console.log(`FAIL  ${currentFile}: line ${j + 1} has no +/-/space prefix: ${JSON.stringify(body)}`);
      failures += 1;
    }
  }

  if (oldSeen !== declaredOld || newSeen !== declaredNew) {
    console.log(
      `FAIL  ${currentFile}: hunk @@ -${oldStart} @@ declares old=${declaredOld} `
      + `new=${declaredNew} but body has old=${oldSeen} new=${newSeen}`,
    );
    failures += 1;
    i = j - 1;
    continue;
  }

  const target = join(treeRoot, currentFile);
  if (!existsSync(target)) {
    console.log(`FAIL  ${currentFile}: target file missing under tree root`);
    failures += 1;
    i = j - 1;
    continue;
  }
  const original = readFileSync(target, 'utf8').split('\n');
  let cursor = oldStart - 1;
  let mismatched = 0;
  for (let k = i + 1; k < j; k += 1) {
    const body = lines[k];
    let expected = null;
    if (body.startsWith(' ') || body === '') expected = body === '' ? '' : body.slice(1);
    else if (body.startsWith('-')) expected = body.slice(1);
    if (expected === null) continue;
    if (original[cursor] !== expected) {
      if (mismatched < 3) {
        console.log(
          `FAIL  ${currentFile}:${cursor + 1} expected ${JSON.stringify(expected)} `
          + `but file has ${JSON.stringify(original[cursor])}`,
        );
      }
      mismatched += 1;
      failures += 1;
    }
    cursor += 1;
  }

  if (mismatched === 0) {
    console.log(`ok    ${currentFile}: @@ -${oldStart},${oldSeen} +${Number(m[3])},${newSeen} @@ matches file`);
    const list = editsByFile.get(currentFile) ?? [];
    list.push({ from: oldStart - 1, to: oldStart - 1 + oldSeen, text: replacement });
    editsByFile.set(currentFile, list);
  }
  i = j - 1;
}

if (failures === 0 && shouldApply) {
  for (const [rel, edits] of editsByFile) {
    const target = join(treeRoot, rel);
    const original = readFileSync(target, 'utf8').split('\n');
    // Apply from the bottom so earlier offsets stay valid.
    for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
      original.splice(edit.from, edit.to - edit.from, ...edit.text);
    }
    writeFileSync(target, original.join('\n'), 'utf8');
    console.log(`wrote ${rel}`);
  }
}

console.log(`\n${hunks} hunk(s), ${failures} failure(s)${shouldApply && failures === 0 ? ', applied' : ''}`);
process.exit(failures === 0 ? 0 : 1);
