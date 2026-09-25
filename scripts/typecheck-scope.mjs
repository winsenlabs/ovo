// Scoped typecheck (§13.10): runs the root `tsc --noEmit -p tsconfig.json --pretty false` and fails
// only on diagnostics in files under the given prefixes; the rest are counted as warnings.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { inScope, normalizePrefix } from './lib/gate-support.mjs';

const prefixes = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--'))
  .map(normalizePrefix);
if (!prefixes.length) {
  console.error('usage: node scripts/typecheck-scope.mjs <path-prefix>...');
  process.exit(2);
}
const project = process.env.OVO_TYPECHECK_PROJECT ?? 'tsconfig.json';

if (
  !existsSync('vendor/cordis/dist/index.d.ts') ||
  !existsSync('vendor/cosmokit/dist/index.d.ts')
) {
  const vendor = spawnSync('pnpm', ['build:vendor'], { stdio: 'inherit' });
  if (vendor.status !== 0) process.exit(vendor.status ?? 1);
}

const tsc = spawnSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', project, '--pretty', 'false'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`;
const diagnostics = [];
for (const line of output.split('\n')) {
  const match = /^(.+?)\(\d+,\d+\): (error|warning) TS\d+: /.exec(line);
  if (match)
    diagnostics.push({
      file: path.relative(process.cwd(), path.resolve(match[1])).split(path.sep).join('/'),
      text: line,
    });
  else if (/^error TS\d+: /.test(line)) diagnostics.push({ file: undefined, text: line });
  else if (line.startsWith(' ') && diagnostics.length) diagnostics.at(-1).text += `\n${line}`;
}

// A diagnostic without a file (configuration error) blocks every scope.
const inside = diagnostics.filter((d) => d.file === undefined || inScope(d.file, prefixes));
const outside = diagnostics.length - inside.length;
if (outside)
  console.warn(
    `warning: ${outside} out-of-scope diagnostic(s) ignored (run pnpm typecheck for all).`,
  );
if (inside.length) {
  console.error(inside.map((d) => d.text).join('\n'));
  console.error(`typecheck-scope: ${inside.length} diagnostic(s) under ${prefixes.join(', ')}`);
  process.exit(1);
}
if (tsc.status !== 0 && diagnostics.length === 0) {
  console.error(output.trim() || `tsc exited with ${tsc.status}`);
  process.exit(1);
}
console.log(`typecheck-scope passed for ${prefixes.join(', ')}.`);
