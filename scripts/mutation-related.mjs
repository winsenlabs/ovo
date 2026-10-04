import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isolatedPostgres } from './mutation-postgres.mjs';

const flag = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const input = flag('input', 'mutation-results.jsonl');
const output = flag('results', 'mutation-related-results.jsonl');
const all = fs.readFileSync(input, 'utf8').trim().split('\n').map(JSON.parse);
const survivors = all.filter((row) => row.exit === 0);
const from = Number(flag('from', '0'));
const to = Math.min(survivors.length, Number(flag('to', String(survivors.length))));
const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error('OVO_TEST_POSTGRES_URL is required for isolated related tests');
if (from === 0) fs.writeFileSync(output, '');

const excludes = [
  'packages/plugin-operations/**',
  'packages/plugin-ledger/**',
  'apps/worker/tests/cost-runtime.test.ts',
  'apps/worker/tests/cost-policy.test.ts',
  'apps/api/tests/cost.test.ts',
  'apps/api/tests/operations-runtime.test.ts',
];
const originals = new Map();
for (const row of survivors.slice(from, to))
  if (!originals.has(row.file)) originals.set(row.file, fs.readFileSync(row.file, 'utf8'));
function restore() {
  for (const [file, source] of originals)
    if (fs.readFileSync(file, 'utf8') !== source) fs.writeFileSync(file, source);
}
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});
process.on('SIGTERM', () => {
  restore();
  process.exit(143);
});

try {
  for (let position = from; position < to; position += 1) {
    const row = survivors[position];
    const source = originals.get(row.file);
    if (source.slice(row.start, row.end) !== row.original)
      throw new Error(`Source differs from first pass: ${row.file}:${row.line}`);
    const database = isolatedPostgres(postgresUrl, String(position));
    let result;
    try {
      fs.writeFileSync(
        row.file,
        source.slice(0, row.start) + row.replacement + source.slice(row.end),
      );
      const start = Date.now();
      const run = spawnSync(
        'pnpm',
        [
          'exec',
          'vitest',
          'related',
          row.file,
          '--no-file-parallelism',
          '--passWithNoTests',
          '--reporter=dot',
          ...excludes.flatMap((value) => ['--exclude', value]),
        ],
        {
          encoding: 'utf8',
          env: database.env,
          timeout: Number(flag('timeout-ms', '300000')),
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const text = `${run.stdout || ''}\n${run.stderr || ''}`;
      result = {
        position,
        index: row.index,
        file: row.file,
        line: row.line,
        exit: run.status,
        signal: run.signal,
        elapsedMs: Date.now() - start,
        summary: text.match(/Tests\s+[^\n]+/)?.[0] ?? '',
        failure: text.match(/AssertionError:[^\n]*/)?.[0] ?? text.match(/Error:[^\n]*/)?.[0] ?? '',
        noTests: text.includes('No test files found'),
      };
    } finally {
      fs.writeFileSync(row.file, source);
      database.close();
    }
    fs.appendFileSync(output, JSON.stringify(result) + '\n');
    if ((position + 1) % 10 === 0 || position + 1 === to)
      console.log(JSON.stringify({ done: position + 1, total: survivors.length, output }));
  }
} finally {
  restore();
}
