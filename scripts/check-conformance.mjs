// Conformance gate (§13.6): every vendor-plugin package has tests/conformance.test.ts that imports
// @winsendotai/ovo-conformance and calls a describe* kit. `"ovo": {"skeleton": true}` packages are
// exempt until they are filled (I1 fails the build if any skeleton flag remains).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {
  finish,
  inScope,
  loadBaselines,
  parseArgs,
  readJson,
  rootOf,
  under,
  writeJson,
} from './lib/gate-support.mjs';

const KITS = new Set([
  'describeSpeechToText',
  'describeTextToSpeech',
  'describeInference',
  'describeCarrier',
  'describeEngine',
  'describeVad',
  'describeTurnDetector',
]);

const args = parseArgs();
const root = rootOf(args);
const kindsFile =
  args.kinds ?? (args.root ? under(root, 'package-kinds.json') : 'scripts/package-kinds.json');
const kinds = (await readJson(kindsFile)).kinds;

function problemsOf(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let imports = false;
  let calls = false;
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@winsendotai/ovo-conformance'
    )
      imports = true;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      KITS.has(node.expression.text)
    )
      calls = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [
    ...(imports ? [] : ['does not import @winsendotai/ovo-conformance']),
    ...(calls ? [] : ['does not call a describe* conformance kit']),
  ];
}

const unwrap = (node) =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;

function resolveRelative(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`])
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  return undefined;
}

/**
 * Whether the package really ships plugins: `export const plugins` with at least one entry, here
 * or in a module it re-exports. `ovo.skeleton` is a self-declared boolean, so a finished plugin
 * could keep the flag and skip conformance entirely (#F23).
 */
async function shipsPlugins(file, depth = 0) {
  if (depth > 3 || !file || !existsSync(file)) return false;
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const reexports = [];
  let ships = false;
  const visit = (node) => {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      for (const declaration of node.declarationList.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'plugins' &&
          declaration.initializer
        ) {
          const value = unwrap(declaration.initializer);
          if (ts.isArrayLiteralExpression(value)) ships ||= value.elements.length > 0;
          else if (ts.isObjectLiteralExpression(value)) ships ||= value.properties.length > 0;
          else ships = true;
        }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('.')
    )
      reexports.push(node.moduleSpecifier.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (ships) return true;
  for (const specifier of reexports)
    if (await shipsPlugins(resolveRelative(file, specifier), depth + 1)) return true;
  return false;
}

const baselines = await loadBaselines(args, 'conformance.json', 'conformance');
const allowed = new Set([
  ...(baselines.top?.packages ?? []),
  ...baselines.pending.map((entry) => entry.package),
]);
const errors = [...baselines.errors];
const warnings = [];
const failing = [];
const exemptions = [];
let checked = 0;
for (const [key, kind] of Object.entries(kinds)) {
  const dir = under(root, key);
  if (kind !== 'vendor-plugin' || !existsSync(`${dir}/package.json`)) continue;
  if (!inScope(dir, args.only) && !args.only.some((prefix) => prefix.startsWith(`${dir}/`)))
    continue;
  const manifest = await readJson(`${dir}/package.json`);
  const flagged = [];
  if (manifest.ovo?.skeleton === true) {
    if (!(await shipsPlugins(`${dir}/src/index.ts`))) {
      exemptions.push(dir);
      continue;
    }
    flagged.push('ovo.skeleton is true but src/index.ts exports a non-empty `plugins`');
  }
  checked += 1;
  const test = `${dir}/tests/conformance.test.ts`;
  const problems = [
    ...flagged,
    ...(existsSync(test)
      ? problemsOf(test, await readFile(test, 'utf8'))
      : ['has no tests/conformance.test.ts']),
  ];
  if (!problems.length) {
    if (allowed.has(key)) warnings.push(`stale baseline entry ${key} (it now passes conformance)`);
    continue;
  }
  failing.push(key);
  if (!allowed.has(key)) errors.push(`${dir}: ${problems.join('; ')}`);
}

if (args.writeBaseline) {
  const pending = new Set(baselines.pending.map((entry) => entry.package));
  await writeJson(baselines.file, { packages: failing.filter((key) => !pending.has(key)).sort() });
  console.log(`[conformance] wrote ${failing.length} packages to ${baselines.file}`);
}

// Every exemption is named, so a skeleton flag can never be quietly permanent.
for (const dir of exemptions) warnings.push(`skeleton exemption taken by ${dir}`);

finish('conformance', {
  errors: args.writeBaseline ? baselines.errors : errors,
  warnings,
  summary: `checked ${checked} filled vendor-plugin packages; ${exemptions.length} skeleton exemption(s).`,
});
