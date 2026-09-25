// Module-size gate (§13.1): source ≤300 canonical nonblank lines (301–400 only when baselined, and a
// baselined count may not grow), tests ≤500, every module ≤24 KiB, 400 a hard cap for everything.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import prettier from 'prettier';
import {
  GENERATED_SEGMENTS,
  finish,
  inScope,
  isTestFile,
  loadBaselines,
  parseArgs,
  rootOf,
  walkFiles,
  writeJson,
} from './lib/gate-support.mjs';

const TARGET = 300;
const HARD = 400;
const TEST_LIMIT = 500;
const MAX_BYTES = 24576;
const ROOTS = ['packages', 'apps', 'experiments', 'scripts', 'infra'];

const args = parseArgs();
const root = rootOf(args);
const accept = (file) => /\.(?:[cm]?[jt]sx?|css|sql|tf)$/.test(file) && !file.endsWith('.d.ts');
const files = [];
for (const start of args.root ? [root] : ROOTS)
  if (existsSync(start))
    files.push(...(await walkFiles(start, accept, { extraSkip: GENERATED_SEGMENTS })));

const baselines = await loadBaselines(args, 'module-size.json', 'moduleSize');
const allowed = new Map(Object.entries(baselines.top?.files ?? {}));
for (const entry of baselines.pending)
  allowed.set(entry.file, Math.max(entry.lines, allowed.get(entry.file) ?? 0));

const errors = [...baselines.errors];
const warnings = [];
const measured = [];
const oversized = {};
for (const file of files) {
  const source = await readFile(file, 'utf8');
  // Measure canonical formatting: writing a module on one line cannot bypass this gate.
  const canonical = /\.(?:sql|tf)$/.test(file)
    ? source
    : await prettier.format(source, { filepath: file });
  const lines = canonical.split('\n').filter((line) => line.trim()).length;
  const bytes = Buffer.byteLength(source);
  measured.push({ file, lines });
  const test = isTestFile(file);
  if (!test && lines > TARGET && lines <= HARD) oversized[file] = lines;
  if (!inScope(file, args.only)) continue;
  const tooBig = `${file}: ${lines} canonical nonblank lines, ${bytes} bytes`;
  if (bytes > MAX_BYTES) errors.push(`${tooBig}; limit 24 KiB. Split by responsibility.`);
  if (test) {
    if (lines > TEST_LIMIT)
      errors.push(`${tooBig}; test limit ${TEST_LIMIT} lines. Split by scenario.`);
  } else if (lines > HARD)
    errors.push(`${tooBig}; hard limit ${HARD} lines (baselines cannot raise it).`);
  else if (lines > TARGET) {
    const limit = allowed.get(file);
    if (limit === undefined)
      errors.push(
        `${tooBig}; source limit ${TARGET} lines. Split by responsibility (never add it to a baseline).`,
      );
    else if (lines > limit) errors.push(`${tooBig}; baselined at ${limit} lines and may not grow.`);
  }
}

for (const [file, limit] of allowed) {
  if (!inScope(file, args.only)) continue;
  const current = measured.find((m) => m.file === file);
  if (!current) warnings.push(`stale baseline entry ${file} (file is gone)`);
  else if (current.lines <= TARGET)
    warnings.push(`stale baseline entry ${file} (${current.lines} lines now; remove it)`);
  else if (current.lines < limit)
    warnings.push(`baseline entry ${file} can shrink to ${current.lines}`);
}

if (args.writeBaseline) {
  const pendingFiles = new Set(baselines.pending.map((entry) => entry.file));
  const keep = Object.fromEntries(
    Object.entries(oversized)
      .filter(([file]) => !pendingFiles.has(file))
      .sort(),
  );
  await writeJson(baselines.file, { files: keep });
  console.log(`[module-size] wrote ${Object.keys(keep).length} entries to ${baselines.file}`);
}

// The summary describes the same scope the errors do: under --only it must not credit, or quote a
// largest module from, files the run was never asked about.
const reported = measured.filter((m) => inScope(m.file, args.only));
const largest = reported.filter((m) => !isTestFile(m.file)).sort((a, b) => b.lines - a.lines)[0];
finish('module-size', {
  errors: args.writeBaseline ? errors.filter((e) => !/source limit|may not grow/.test(e)) : errors,
  warnings,
  summary: `passed for ${reported.length} files${args.only.length ? ` (${args.only.join(', ')})` : ''}; largest source module ${largest?.lines ?? 0} lines.`,
});
