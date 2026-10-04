// Duplication gate (§13.2, in-house): TypeScript-scanner tokens (comments/whitespace dropped, string
// literals collapsed, import/export-from declarations skipped), rolling hashes over 60-token windows,
// and a per-file-pair ratchet on cross-file repeats.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import {
  finish,
  inScope,
  isTestFile,
  loadBaselines,
  parseArgs,
  rootOf,
  under,
  walkFiles,
  writeJson,
} from './lib/gate-support.mjs';

const WINDOW = 60;
const args = parseArgs();
const root = rootOf(args);

async function sourceRoots() {
  const roots = [];
  for (const group of ['apps', 'packages']) {
    const dir = under(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = `${dir}/${entry.name}`;
      if (group === 'apps' && entry.name === 'console')
        for (const sub of ['app', 'components', 'features', 'lib']) roots.push(`${base}/${sub}`);
      else roots.push(`${base}/src`);
    }
  }
  return roots.filter((dir) => existsSync(dir));
}

const STRINGY = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** Tokens of every top-level statement except imports and re-exports, with their lines. */
function tokenize(file, text) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  const tokens = [];
  const lines = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
    )
      continue;
    scanner.resetTokenState(statement.getStart(source));
    const end = statement.getEnd();
    for (
      let kind = scanner.scan();
      kind !== ts.SyntaxKind.EndOfFileToken && scanner.getTokenStart() < end;
      kind = scanner.scan()
    ) {
      tokens.push(STRINGY.has(kind) ? '"S"' : scanner.getTokenText());
      lines.push(source.getLineAndCharacterOfPosition(scanner.getTokenStart()).line + 1);
    }
  }
  return { tokens, lines };
}

const files = [];
for (const dir of await sourceRoots())
  files.push(
    ...(await walkFiles(
      dir,
      (f) => /\.[cm]?tsx?$/.test(f) && !f.endsWith('.d.ts') && !isTestFile(f),
    )),
  );

// Intern tokens, then hash every window with two independent 32-bit polynomial hashes.
const ids = new Map();
const B1 = 1000003;
const B2 = 916969;
let pow1 = 1;
let pow2 = 1;
for (let i = 0; i < WINDOW; i += 1) {
  pow1 = Math.imul(pow1, B1) >>> 0;
  pow2 = Math.imul(pow2, B2) >>> 0;
}
const firstSeen = new Map(); // key → file index
const shared = new Map(); // key → Map(file index → first line)
for (const [index, file] of files.entries()) {
  const { tokens, lines } = tokenize(file, await readFile(file, 'utf8'));
  if (tokens.length < WINDOW) continue;
  const seq = tokens.map((token) => {
    let id = ids.get(token);
    if (id === undefined) ids.set(token, (id = ids.size + 1));
    return id;
  });
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < seq.length; i += 1) {
    h1 = (Math.imul(h1, B1) + seq[i]) >>> 0;
    h2 = (Math.imul(h2, B2) + seq[i]) >>> 0;
    if (i >= WINDOW) {
      h1 = (h1 - Math.imul(seq[i - WINDOW], pow1)) >>> 0;
      h2 = (h2 - Math.imul(seq[i - WINDOW], pow2)) >>> 0;
    }
    if (i < WINDOW - 1) continue;
    const key = h1 * 2097152 + (h2 & 0x1fffff);
    const first = firstSeen.get(key);
    if (first === undefined) firstSeen.set(key, index);
    else if (first !== index) {
      const holders = shared.get(key) ?? new Map([[first, 0]]);
      if (!holders.has(index)) holders.set(index, lines[i - WINDOW + 1]);
      shared.set(key, holders);
    }
  }
}

// Aggregate to file pairs: how many 60-token windows the two files share.
const pairs = new Map();
for (const holders of shared.values()) {
  const members = [...holders.keys()].sort((a, b) => a - b);
  for (let a = 0; a < members.length; a += 1)
    for (let b = a + 1; b < members.length; b += 1) {
      const id = `${files[members[a]]}\n${files[members[b]]}`;
      const pair = pairs.get(id) ?? {
        files: [files[members[a]], files[members[b]]],
        windows: 0,
        line: holders.get(members[b]),
      };
      pair.windows += 1;
      pairs.set(id, pair);
    }
}

const baselines = await loadBaselines(args, 'duplication.json', 'duplication');
const allowed = new Map();
for (const entry of [...(baselines.top?.pairs ?? []), ...baselines.pending]) {
  const id = [...entry.files].sort().join('\n');
  allowed.set(id, Math.max(entry.windows, allowed.get(id) ?? 0));
}
const errors = [...baselines.errors];
const warnings = [];
const scoped = (pair) => pair.files.some((file) => inScope(file, args.only));
for (const [id, pair] of pairs) {
  if (!scoped(pair)) continue;
  const limit = allowed.get(id);
  if (limit === undefined)
    errors.push(
      `${pair.files[0]} and ${pair.files[1]} (near line ${pair.line}) share ${pair.windows} duplicated ${WINDOW}-token windows; extract the shared code into a kit or contracts helper`,
    );
  else if (pair.windows > limit)
    errors.push(
      `${pair.files[0]} and ${pair.files[1]} share ${pair.windows} duplicated windows, above the baselined ${limit}`,
    );
}
for (const [id, limit] of allowed) {
  const files = id.split('\n');
  if (!files.some((file) => inScope(file, args.only))) continue;
  const current = pairs.get(id)?.windows ?? 0;
  if (current === 0) warnings.push(`stale baseline pair ${files.join(' + ')}`);
  else if (current < limit)
    warnings.push(`baseline pair ${files.join(' + ')} can shrink to ${current}`);
}

if (args.writeBaseline) {
  const pending = new Set(baselines.pending.map((entry) => [...entry.files].sort().join('\n')));
  const list = [...pairs.entries()]
    .filter(([id]) => !pending.has(id))
    .map(([, pair]) => ({ files: pair.files, windows: pair.windows }));
  list.sort((a, b) => (a.files.join() < b.files.join() ? -1 : 1));
  await writeJson(baselines.file, { pairs: list });
  console.log(`[duplication] wrote ${list.length} pairs to ${baselines.file}`);
}

finish('duplication', {
  errors: args.writeBaseline ? baselines.errors : errors,
  warnings,
  summary: `scanned ${files.length} source files; ${pairs.size} baselined cross-file pairs.`,
});
