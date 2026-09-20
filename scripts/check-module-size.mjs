import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import prettier from 'prettier';
const errors = [];
const measured = [];
async function scan(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next', '.data', 'data'].includes(entry.name)) continue;
    const path = `${root}/${entry.name}`;
    // These exact source extractions retain upstream layout and are separately hash-checked.
    if (path === 'packages/runtime/src/upstream' || path === 'packages/runtime/tests/upstream')
      continue;
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!/\.(?:[cm]?[jt]sx?|css|sql|tf)$/.test(path) || path.endsWith('.d.ts')) continue;
    const source = await readFile(path, 'utf8');
    // Measure canonical formatting too; writing a whole module on one line cannot bypass this gate.
    const canonical = /\.(?:sql|tf)$/.test(path)
      ? source
      : await prettier.format(source, { filepath: path });
    const lines = canonical.split('\n').filter((line) => line.trim()).length;
    const limit = /\.(?:test|spec)\./.test(path) ? 500 : 400;
    measured.push({ path, lines, bytes: Buffer.byteLength(source) });
    if (lines > limit || Buffer.byteLength(source) > 24576)
      errors.push(
        `${path}: ${lines} canonical nonblank lines, ${Buffer.byteLength(source)} bytes; limit ${limit} lines / 24 KiB. Split by responsibility.`,
      );
  }
}
for (const root of ['packages', 'apps', 'experiments', 'scripts', 'infra'])
  if (existsSync(root)) await scan(root);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(
  `Module-size gate passed for ${measured.length} first-party code files. Largest: ${measured.sort((a, b) => b.lines - a.lines)[0]?.lines ?? 0} nonblank lines.`,
);
