// Shared plumbing for the code-hygiene gates (§13): argument parsing, repository walking,
// --only scoping, baseline + pending-baseline loading, and reporting.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import prettier from 'prettier';

/** Path segments no gate ever scans when walking the repository. */
export const SKIP_SEGMENTS = new Set([
  'fixtures',
  '__fixtures__',
  'node_modules',
  'dist',
  '.next',
  'upstream',
  'vendor',
]);

const posix = (value) => value.split(path.sep).join('/');

export function normalizePrefix(value) {
  return posix(value)
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

/**
 * --only <prefix>...   report only files under these prefixes
 * --root <dir>         scan this folder instead of the repository (gate tests)
 * --baseline-dir <dir> read baselines here instead of scripts/baselines
 * --kinds <file>       package-kinds.json override
 * --write-baseline     regenerate the top-level baseline from the current state
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    only: [],
    root: undefined,
    baselineDir: undefined,
    kinds: undefined,
    writeBaseline: false,
    extra: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') {
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--'))
        args.only.push(normalizePrefix(argv[++i]));
    } else if (arg === '--root') args.root = argv[++i];
    else if (arg === '--baseline-dir') args.baselineDir = argv[++i];
    else if (arg === '--kinds') args.kinds = argv[++i];
    else if (arg === '--write-baseline') args.writeBaseline = true;
    else args.extra.push(arg);
  }
  return args;
}

/** Whether a repo-relative file is inside the --only scope (everything when no prefix is given). */
export function inScope(file, only) {
  if (!only.length) return true;
  return only.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

/**
 * Repo-relative posix paths under `root` whose name passes `accept`. Skip segments apply only
 * below `root`, so a gate test can point at scripts/tests/fixtures/<gate> explicitly.
 */
export async function walkFiles(root, accept, { skip = SKIP_SEGMENTS, extraSkip = [] } = {}) {
  const out = [];
  const skipped = new Set([...skip, ...extraSkip]);
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipped.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && accept(posix(full)))
        out.push(posix(path.relative(process.cwd(), full)));
    }
  }
  await visit(root);
  return out.sort();
}

export const isTestFile = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * The gate's top-level baseline plus every pending/*.json list under `key`. Pending entries must
 * carry `reason` and `removeBy: "I1"` (§13.9); malformed ones become errors.
 */
export async function loadBaselines(args, fileName, key) {
  const dir = args.baselineDir ?? 'scripts/baselines';
  const file = path.join(dir, fileName);
  const top = existsSync(file) ? await readJson(file) : undefined;
  const pending = [];
  const errors = [];
  const pendingDir = path.join(dir, 'pending');
  if (existsSync(pendingDir)) {
    for (const name of (await readdir(pendingDir)).filter((n) => n.endsWith('.json')).sort()) {
      const content = await readJson(path.join(pendingDir, name));
      for (const entry of content[key] ?? []) {
        if (typeof entry.reason !== 'string' || !entry.reason.trim() || entry.removeBy !== 'I1')
          errors.push(
            `${posix(path.join(pendingDir, name))}: ${key} entry needs a reason and removeBy "I1": ${JSON.stringify(entry)}`,
          );
        else pending.push({ ...entry, unit: name.replace(/\.json$/, '') });
      }
    }
  }
  return { file: posix(file), top, pending, errors };
}

/** Writes JSON formatted exactly as `prettier --check` expects. */
export async function writeJson(file, value) {
  const options = (await prettier.resolveConfig(file)) ?? {};
  await writeFile(
    file,
    await prettier.format(JSON.stringify(value), { ...options, parser: 'json' }),
  );
}

/** Prints warnings, then errors (exit 1) or the summary (exit 0). */
export function finish(gate, { errors = [], warnings = [], summary }) {
  for (const warning of warnings) console.warn(`[${gate}] warning: ${warning}`);
  if (errors.length) {
    console.error(errors.map((error) => `[${gate}] ${error}`).join('\n'));
    process.exit(1);
  }
  console.log(`[${gate}] ${summary}`);
}

export function rootOf(args) {
  return args.root ? posix(path.relative(process.cwd(), path.resolve(args.root))) || '.' : '.';
}

/** Joins a root and a repo-style relative path ('.' keeps the path as is). */
export function under(root, relative) {
  return root === '.' ? relative : `${root}/${relative}`;
}
