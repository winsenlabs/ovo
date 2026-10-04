// Capability-key gate (§13.5): capability strings are spelled only in contracts/capabilities/keys.ts.
// Other string literals equal to a key (optionally `@major`) or starting with a key prefix ratchet.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ratchet } from './lib/count-gate.mjs';
import { finish, isTestFile, parseArgs, rootOf, under, walkFiles } from './lib/gate-support.mjs';

const args = parseArgs();
const root = rootOf(args);
const KEYS_FILE = existsSync(under(root, 'packages/contracts/src/capabilities/keys.ts'))
  ? under(root, 'packages/contracts/src/capabilities/keys.ts')
  : 'packages/contracts/src/capabilities/keys.ts';

/** The string values of the `Cap` and `CAP_PREFIXES` object literals in keys.ts. */
function declaredKeys(text) {
  const source = ts.createSourceFile(KEYS_FILE, text, ts.ScriptTarget.Latest, true);
  const keys = new Set();
  const prefixes = new Set();
  const collect = (declaration, into) => {
    let init = declaration.initializer;
    while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init)))
      init = init.expression;
    if (!init || !ts.isObjectLiteralExpression(init)) return;
    for (const property of init.properties)
      if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer))
        into.add(property.initializer.text);
  };
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(source) === 'Cap') collect(declaration, keys);
        if (declaration.name.getText(source) === 'CAP_PREFIXES') collect(declaration, prefixes);
      }
  return { keys, prefixes };
}

const { keys, prefixes } = declaredKeys(await readFile(KEYS_FILE, 'utf8'));
const matches = (text) =>
  keys.has(text) ||
  keys.has(text.replace(/@\d+$/, '')) ||
  [...prefixes].some((prefix) => text.startsWith(prefix));

async function scanRoots() {
  const roots = [];
  for (const group of ['apps', 'packages']) {
    const dir = under(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (group === 'apps' && entry.name === 'console')
        roots.push(
          ...['app', 'components', 'features', 'lib'].map((sub) => `${dir}/console/${sub}`),
        );
      else roots.push(`${dir}/${entry.name}/src`);
    }
  }
  return roots.filter((dir) => existsSync(dir));
}

/**
 * Every piece of literal text in a file: string literals, backtick literals without substitutions,
 * and each fixed chunk of a template expression — its head AND every span's middle or tail. A raw
 * token scan cannot see middles and tails (they only exist once a `}` is re-scanned as part of a
 * template), so `${prefix}ovo.stt` used to spell a capability key invisibly.
 */
function literals(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const found = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      found.push(node.head.text);
      for (const span of node.templateSpans) found.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const counts = new Map();
let scanned = 0;
for (const dir of await scanRoots()) {
  const files = await walkFiles(
    dir,
    (f) => /\.[cm]?tsx?$/.test(f) && !f.endsWith('.d.ts') && !isTestFile(f),
  );
  for (const file of files) {
    if (file === KEYS_FILE) continue;
    scanned += 1;
    const text = await readFile(file, 'utf8');
    counts.set(file, literals(file, text).filter(matches).length);
  }
}

const result = await ratchet(args, {
  fileName: 'capability-keys.json',
  key: 'capabilityKeys',
  counts,
  what: 'capability-key string literals',
});
finish('capability-keys', {
  ...result,
  summary: `scanned ${scanned} files against ${keys.size} keys and ${prefixes.size} prefixes.`,
});
