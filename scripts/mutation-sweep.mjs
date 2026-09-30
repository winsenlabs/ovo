import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { enumerateSites } from './mutation-sites.mjs';

const separator = process.argv.indexOf('--');
const ownArgs = separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
const command = separator < 0 ? [] : process.argv.slice(separator + 1);
const flag = (name, fallback) =>
  ownArgs.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const kind = flag('kind', 'all');
if (!['all', 'ts', 'sql'].includes(kind)) throw new Error('Use --kind=all|ts|sql');
const sites = enumerateSites(kind).map((site, index) => ({ index, ...site }));
const manifest = flag('manifest', '');
if (manifest) fs.writeFileSync(manifest, JSON.stringify(sites, null, 2));
const counts = Object.fromEntries(
  [...new Set(sites.map((site) => site.kind))].map((name) => [
    name,
    sites.filter((site) => site.kind === name).length,
  ]),
);
if (!command.length) {
  console.log(
    JSON.stringify({
      files: new Set(sites.map((site) => site.file)).size,
      sites: sites.length,
      counts,
    }),
  );
  process.exit(0);
}
const from = Number(flag('from', '0'));
const to = Math.min(sites.length, Number(flag('to', String(sites.length))));
const resultPath = flag('results', 'mutation-results.jsonl');
if (from === 0) fs.writeFileSync(resultPath, '');
const originals = new Map();
for (const site of sites.slice(from, to))
  if (!originals.has(site.file)) originals.set(site.file, fs.readFileSync(site.file, 'utf8'));
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
  for (let index = from; index < to; index += 1) {
    const site = sites[index];
    const source = originals.get(site.file);
    if (source.slice(site.start, site.end) !== site.original)
      throw new Error(`Source changed since enumeration: ${site.file}:${site.line}`);
    fs.writeFileSync(
      site.file,
      source.slice(0, site.start) + site.replacement + source.slice(site.end),
    );
    const start = Date.now();
    const run = spawnSync(command[0], command.slice(1), {
      encoding: 'utf8',
      env: process.env,
      timeout: Number(flag('timeout-ms', '300000')),
      maxBuffer: 2 * 1024 * 1024,
    });
    fs.writeFileSync(site.file, source);
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    const row = {
      ...site,
      exit: run.status,
      signal: run.signal,
      elapsedMs: Date.now() - start,
      summary: output.match(/Tests\s+[^\n]+/)?.[0] ?? '',
      failure:
        output.match(/AssertionError:[^\n]*/)?.[0] ?? output.match(/Error:[^\n]*/)?.[0] ?? '',
      invalidSql:
        /syntax error at or near|unterminated quoted string|missing FROM-clause entry/.test(output),
    };
    fs.appendFileSync(resultPath, JSON.stringify(row) + '\n');
    if ((index + 1) % 20 === 0 || index + 1 === to)
      console.log(JSON.stringify({ done: index + 1, total: sites.length, resultPath }));
  }
} finally {
  restore();
}
