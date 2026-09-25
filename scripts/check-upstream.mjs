// Upstream-provenance gate (§13; the second gate in scripts/lint.mjs): every file pinned in
// docs/research/deepseek-source-lock.json still hashes to the sha256 recorded for it, so an
// extracted DeepSeek source file cannot drift or be edited without the lock being updated.
//
// This gate is deliberately repository-wide and IGNORES --only. For the file-scanning gates --only
// narrows *reporting* during wave-2 scoped verification; provenance is a property of the whole
// checkout, and a scoped run that skipped the vendor/ hashes would let a tampered extraction
// through unnoticed. The flag is therefore accepted (scripts/lint.mjs forwards it to every gate)
// and explicitly reported as ignored rather than silently dropped.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { finish, parseArgs, rootOf, under } from './lib/gate-support.mjs';

const args = parseArgs();
const root = rootOf(args);
const lockFile = under(root, 'docs/research/deepseek-source-lock.json');
const lock = JSON.parse(await readFile(lockFile, 'utf8'));

const errors = [];
const warnings = [];
if (args.only.length)
  warnings.push(
    `--only ${args.only.join(' ')} ignored: upstream provenance is checked repository-wide.`,
  );

for (const file of lock.files) {
  const local = under(root, file.local);
  const expected = file.localSha256 ?? file.sha256;
  let hash;
  try {
    hash = createHash('sha256')
      .update(await readFile(local))
      .digest('hex');
  } catch {
    errors.push(`${local}: pinned upstream file is missing (${lockFile} expects ${expected})`);
    continue;
  }
  if (hash !== expected)
    errors.push(
      `Pinned upstream extraction changed: ${local} (expected ${expected}, found ${hash})`,
    );
}

finish('upstream', {
  errors,
  warnings,
  summary: `Verified ${lock.files.length} pinned DeepSeek source files at ${lock.commit}.`,
});
