import { format } from 'prettier';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const input = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--json'], { encoding: 'utf8' }),
);
const dependencies = Object.entries(input)
  .flatMap(([license, rows]) =>
    rows.map((row) => ({ name: row.name, versions: row.versions, license })),
  )
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  'docs/research/dependency-licenses.json',
  await format(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString().slice(0, 10),
        command: 'pnpm licenses list --json',
        lockfileSha256: createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex'),
        dependencies,
      },
      null,
      2,
    ),
    { parser: 'json' },
  ),
);
console.log(
  `Recorded ${dependencies.length} dependency-license entries without machine-specific paths.`,
);
