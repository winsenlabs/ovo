// Conformance gate (§13.6): every vendor-plugin package has tests/conformance.test.ts that imports
// @winsendotai/ovo-conformance and calls a describe* kit. `"ovo": {"skeleton": true}` packages are
// exempt until they are filled (I1 fails the build if any skeleton flag remains).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

const baselines = await loadBaselines(args, 'conformance.json', 'conformance');
const allowed = new Set([
  ...(baselines.top?.packages ?? []),
  ...baselines.pending.map((entry) => entry.package),
]);
const errors = [...baselines.errors];
const warnings = [];
const failing = [];
let checked = 0;
for (const [key, kind] of Object.entries(kinds)) {
  const dir = under(root, key);
  if (kind !== 'vendor-plugin' || !existsSync(`${dir}/package.json`)) continue;
  if (!inScope(dir, args.only) && !args.only.some((prefix) => prefix.startsWith(`${dir}/`)))
    continue;
  const manifest = await readJson(`${dir}/package.json`);
  if (manifest.ovo?.skeleton === true) continue;
  checked += 1;
  const test = `${dir}/tests/conformance.test.ts`;
  const problems = existsSync(test)
    ? problemsOf(test, await readFile(test, 'utf8'))
    : ['has no tests/conformance.test.ts'];
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

finish('conformance', {
  errors: args.writeBaseline ? baselines.errors : errors,
  warnings,
  summary: `checked ${checked} filled vendor-plugin packages.`,
});
