import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import ts from 'typescript';
const errors = [];
async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (['node_modules', 'dist', '.next', '.data'].includes(e.name)) continue;
    const p = `${path}/${e.name}`;
    if (e.isDirectory()) files.push(...(await walk(p)));
    else files.push(p);
  }
  return files;
}
for (const root of ['packages', 'apps', 'experiments']) {
  if (!existsSync(root)) continue;
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const path = `${root}/${dir.name}`;
    if (!existsSync(`${path}/package.json`)) continue;
    const manifest = JSON.parse(await readFile(`${path}/package.json`, 'utf8'));
    if (!manifest.name?.startsWith('@winsendotai/ovo-') || manifest.private !== true)
      errors.push(`${path}: private @winsendotai/ovo-* package required`);
    for (const file of await walk(path)) {
      if (!/\.[cm]?tsx?$/.test(file) || /\.(test|spec)\./.test(file) || file.includes('/upstream/'))
        continue;
      const source = ts.createSourceFile(
        file,
        await readFile(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const imports = [];
      function visit(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.push(node.moduleSpecifier.text);
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        )
          imports.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
      }
      visit(source);
      if (dir.name === 'contracts')
        for (const imp of imports)
          if (imp !== 'zod' && !imp.startsWith('.'))
            errors.push(`${file}: contracts cannot import ${imp}`);
      if (dir.name === 'runtime')
        for (const imp of imports)
          if (
            !imp.startsWith('.') &&
            !['@deepseek-ai/cordis', '@winsendotai/ovo-contracts', 'ajv'].includes(imp)
          )
            errors.push(`${file}: host cannot import capability ${imp}`);
      if (dir.name === 'behaviors')
        for (const imp of imports)
          if (
            !imp.startsWith('.') &&
            ![
              '@winsendotai/ovo-contracts',
              '@winsendotai/ovo-runtime',
              'zod',
              'ajv',
              'ajv-formats',
            ].includes(imp) &&
            !imp.startsWith('node:')
          )
            errors.push(`${file}: behavior cannot import provider ${imp}`);
      const text = source.text;
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))
        errors.push(`${file}: private key detected`);
    }
  }
}
const acceptance = JSON.parse(await readFile('PM/acceptance.json', 'utf8'));
if (acceptance.length !== 75 || new Set(acceptance.map((a) => a.id)).size !== 75)
  errors.push('PM must retain all 75 acceptance criteria');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Architecture, namespace, private-package and PM checks passed.');
