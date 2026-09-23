// Architecture gate (§13.3): namespace + private packages, the contracts/runtime/behaviors import
// rules, private keys, PM acceptance (75), and the package-kind table from scripts/package-kinds.json.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { classifyImport, describeTarget, violation } from './lib/architecture-rules.mjs';
import {
  finish,
  inScope,
  isTestFile,
  loadBaselines,
  parseArgs,
  readJson,
  rootOf,
  under,
  walkFiles,
  writeJson,
} from './lib/gate-support.mjs';

const args = parseArgs();
const root = rootOf(args);
const kindsFile =
  args.kinds ?? (args.root ? under(root, 'package-kinds.json') : 'scripts/package-kinds.json');
const kinds = (await readJson(kindsFile)).kinds;
const errors = [];
const warnings = [];

function importsOf(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// Every workspace package (including vendor/*, which counts as third-party code).
const packages = [];
for (const group of ['packages', 'apps', 'experiments', 'vendor']) {
  const dir = under(root, group);
  if (!existsSync(dir)) continue;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const pkgDir = `${dir}/${entry.name}`;
    if (!entry.isDirectory() || !existsSync(`${pkgDir}/package.json`)) continue;
    const manifest = JSON.parse(await readFile(`${pkgDir}/package.json`, 'utf8'));
    const key = `${group}/${entry.name}`;
    packages.push({ key, pkgDir, manifest, kind: group === 'vendor' ? 'vendor' : kinds[key] });
  }
}
const byKey = new Map(packages.map((p) => [p.key, p]));
const packagesByName = new Map(packages.map((p) => [p.manifest.name, p.key]));
const kindOf = (key) => byKey.get(key)?.kind;
const packageOfPath = (absolute) => {
  const relative = path.relative(path.resolve(root), absolute).split(path.sep).join('/');
  return packages.find((p) => relative === p.key || relative.startsWith(`${p.key}/`))?.key;
};

const touches = (dir) =>
  !args.only.length ||
  args.only.some((o) => dir === o || dir.startsWith(`${o}/`) || o.startsWith(`${dir}/`));
const edges = new Map();
for (const pkg of packages.filter((p) => p.kind !== 'vendor')) {
  if (touches(pkg.pkgDir)) {
    if (!pkg.manifest.name?.startsWith('@winsendotai/ovo-') || pkg.manifest.private !== true)
      errors.push(`${pkg.pkgDir}: private @winsendotai/ovo-* package required`);
    if (!pkg.kind) errors.push(`${pkg.pkgDir}: no kind in ${kindsFile}; add the package there`);
  }
  if (!pkg.kind) continue;
  const files = await walkFiles(pkg.pkgDir, (f) => /\.[cm]?tsx?$/.test(f) && !isTestFile(f), {
    extraSkip: ['.data'],
  });
  for (const file of files) {
    if (!inScope(file, args.only)) continue;
    const text = await readFile(file, 'utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))
      errors.push(`${file}: private key detected`);
    for (const specifier of importsOf(file, text)) {
      const bare = !specifier.startsWith('.');
      if (pkg.key === 'packages/contracts' && bare && specifier !== 'zod')
        errors.push(`${file}: contracts cannot import ${specifier}`);
      if (
        pkg.key === 'packages/runtime' &&
        bare &&
        !['@deepseek-ai/cordis', '@winsendotai/ovo-contracts', 'ajv'].includes(specifier)
      )
        errors.push(`${file}: host cannot import capability ${specifier}`);
      if (
        pkg.key === 'packages/behaviors' &&
        bare &&
        ![
          '@winsendotai/ovo-contracts',
          '@winsendotai/ovo-runtime',
          'zod',
          'ajv',
          'ajv-formats',
        ].includes(specifier) &&
        !specifier.startsWith('node:')
      )
        errors.push(`${file}: behavior cannot import provider ${specifier}`);
      // Test support files (tests/*.ts) keep the rules above but are exempt from the kind table.
      if (file.slice(pkg.pkgDir.length).includes('/tests/')) continue;
      const target = classifyImport(specifier, {
        packagesByName,
        packageOfPath,
        resolveRelative: (s) => path.resolve(path.dirname(file), s),
      });
      const reason = violation({ kind: pkg.kind, dir: pkg.key }, target, kindOf);
      if (!reason) continue;
      const id = `${pkg.key} -> ${describeTarget(target)}`;
      const edge = edges.get(id) ?? {
        from: pkg.key,
        to: describeTarget(target),
        reason,
        files: new Set(),
      };
      edge.files.add(file);
      edges.set(id, edge);
    }
  }
}

// The drivers entry of the conformance kit must never load vitest, even transitively.
const conformance = packages.find((p) => p.kind === 'test-kit');
const driversEntry = conformance && conformance.manifest.exports?.['./drivers'];
if (driversEntry) {
  const seen = new Set();
  const visit = async (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    for (const specifier of importsOf(file, await readFile(file, 'utf8'))) {
      if (
        specifier === 'vitest' ||
        specifier.startsWith('vitest/') ||
        specifier.startsWith('@vitest/')
      )
        errors.push(
          `${path.relative(process.cwd(), file)}: reachable from ${conformance.pkgDir}/drivers but imports ${specifier}`,
        );
      if (specifier.startsWith('.')) await visit(path.resolve(path.dirname(file), specifier));
    }
  };
  await visit(path.resolve(conformance.pkgDir, driversEntry));
}

const pmFile = under(root, 'PM/acceptance.json');
if (existsSync(pmFile)) {
  const acceptance = await readJson(pmFile);
  if (acceptance.length !== 75 || new Set(acceptance.map((a) => a.id)).size !== 75)
    errors.push('PM must retain all 75 acceptance criteria');
}

const baselines = await loadBaselines(args, 'architecture.json', 'architecture');
errors.push(...baselines.errors);
const allowed = new Set(
  [...(baselines.top?.edges ?? []), ...baselines.pending].map((e) => `${e.from} -> ${e.to}`),
);
for (const [id, edge] of edges)
  if (!allowed.has(id))
    errors.push(
      `${[...edge.files][0]}: ${edge.reason} (${id})${edge.files.size > 1 ? ` and ${edge.files.size - 1} more files` : ''}`,
    );
for (const entry of baselines.top?.edges ?? [])
  if (touches(under(root, entry.from)) && !edges.has(`${entry.from} -> ${entry.to}`))
    warnings.push(`stale baseline edge ${entry.from} -> ${entry.to}`);

if (args.writeBaseline) {
  const pending = new Set(baselines.pending.map((e) => `${e.from} -> ${e.to}`));
  const list = [...edges.values()]
    .filter((e) => !pending.has(`${e.from} -> ${e.to}`))
    .map((e) => ({ from: e.from, to: e.to, reason: e.reason }));
  list.sort((a, b) => (`${a.from} ${a.to}` < `${b.from} ${b.to}` ? -1 : 1));
  await writeJson(baselines.file, { edges: list });
  console.log(`[architecture] wrote ${list.length} edges to ${baselines.file}`);
}

finish('architecture', {
  errors: args.writeBaseline ? errors.filter((e) => !/ \(.* -> .*\)/.test(e)) : errors,
  warnings,
  summary: `Architecture, namespace, private-package, package-kind and PM checks passed (${packages.length} packages, ${edges.size} baselined edges).`,
});
