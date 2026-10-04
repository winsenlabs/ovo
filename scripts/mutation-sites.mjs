import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function files(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .flatMap((entry) => {
      const name = path.join(directory, entry.name);
      return entry.isDirectory() ? files(name) : [name];
    });
}

const defaultPaths = () => [
  ...files('packages/plugin-operations/src'),
  ...files('packages/plugin-ledger/src'),
  ...files('apps/worker/src').filter((file) => /\/cost-[^/]+\.ts$/.test(file)),
];
const pathsArg = process.argv.find((arg) => arg.startsWith('--paths='))?.slice('--paths='.length);
const requestedPaths = pathsArg?.split(',').map((value) => value.trim());
if (requestedPaths?.some((value) => !value))
  throw new Error('Use --paths=path[,path...] with nonempty files or directories');
export const sourceFiles = [
  ...new Set(
    (requestedPaths ?? defaultPaths()).flatMap((entry) => {
      if (!fs.existsSync(entry)) throw new Error(`Mutation path does not exist: ${entry}`);
      return fs.statSync(entry).isDirectory() ? files(entry) : [entry];
    }),
  ),
].filter((file) => file.endsWith('.ts'));

function site(file, ast, start, end, replacement, kind, source) {
  return {
    file,
    line: ast.getLineAndCharacterOfPosition(start).line + 1,
    start,
    end,
    replacement,
    kind,
    original: source.slice(start, end),
  };
}

function tsSites(file, ast, source) {
  const sites = [];
  function walk(node) {
    let target;
    let replacement;
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      target = ts.isConditionalExpression(node) ? node.condition : node.expression;
      replacement = `!(${source.slice(target.getStart(ast), target.end)})`;
    } else if (
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      (ts.isForStatement(node) && node.condition)
    ) {
      target = ts.isForStatement(node) ? node.condition : node.expression;
      replacement = 'false';
    } else if (ts.isBinaryExpression(node)) {
      target = node.operatorToken;
      if (target.kind === ts.SyntaxKind.AmpersandAmpersandToken) replacement = '||';
      if (target.kind === ts.SyntaxKind.BarBarToken) replacement = '&&';
      if (target.kind === ts.SyntaxKind.QuestionQuestionToken) {
        target = node;
        replacement = `((${source.slice(node.left.getStart(ast), node.left.end)}) || (${source.slice(node.right.getStart(ast), node.right.end)}))`;
      }
    }
    if (target && replacement !== undefined)
      sites.push(
        site(
          file,
          ast,
          target.getStart(ast),
          target.end,
          replacement,
          `ts:${ts.SyntaxKind[target.kind]}`,
          source,
        ),
      );
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return sites;
}

function maskSql(value) {
  return value
    .replace(/'(?:''|[^'])*'/gs, (match) => ' '.repeat(match.length))
    .replace(/"(?:""|[^"])*"/gs, (match) => ' '.repeat(match.length))
    .replace(/--[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/\$\{[^}]*\}/gs, (match) => ' '.repeat(match.length));
}

function sqlReplacement(kind, suffix) {
  if (kind === 'WHERE') return { width: 5, replacement: 'WHERE TRUE OR' };
  if (kind === 'AND') return { width: 3, replacement: 'OR' };
  if (kind === 'OR') return { width: 2, replacement: 'AND' };
  if (kind === 'NOT EXISTS') return { width: 10, replacement: 'EXISTS' };
  if (kind === 'SKIP LOCKED') return { width: 11, replacement: '' };
  if (kind === 'FOR UPDATE') {
    const match = suffix.match(
      /^FOR\s+UPDATE(?:\s+OF\s+[\w.,\s]+?)?(?:\s+SKIP\s+LOCKED)?(?=\s+LIMIT\b|\s*$|\s*;)/i,
    );
    return match ? { width: match[0].length, replacement: '' } : undefined;
  }
  if (kind === 'ON CONFLICT') {
    const match = suffix.match(/^ON\s+CONFLICT\b[\s\S]*?\bDO\s+NOTHING\b/i);
    return match ? { width: match[0].length, replacement: '' } : undefined;
  }
  if (kind === 'CASE') {
    const match = suffix.match(/^CASE\s+WHEN\s+([\s\S]*?)\s+THEN\b/i);
    return match && !/\bCASE\b/i.test(match[1])
      ? { width: match[0].length, replacement: 'CASE WHEN TRUE THEN' }
      : undefined;
  }
}

function sqlSites(file, ast, source) {
  const sites = [];
  function walk(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query' &&
      node.arguments.length
    ) {
      const first = node.arguments[0];
      if (
        ts.isStringLiteral(first) ||
        ts.isNoSubstitutionTemplateLiteral(first) ||
        ts.isTemplateExpression(first)
      ) {
        const offset = first.getStart(ast) + 1;
        const value = source.slice(offset, first.end - 1);
        if (/\b(SELECT|UPDATE|INSERT|DELETE|WITH|CREATE|ALTER|DROP)\b/i.test(value)) {
          const masked = maskSql(value);
          const keyword =
            /\bNOT\s+EXISTS\b|\bON\s+CONFLICT\b|\bFOR\s+UPDATE\b|\bSKIP\s+LOCKED\b|\bWHERE\b|\bAND\b|\bOR\b|\bCASE\b/gi;
          for (const match of masked.matchAll(keyword)) {
            const kind = match[0].replace(/\s+/g, ' ').toUpperCase();
            const mutation = sqlReplacement(kind, masked.slice(match.index));
            if (!mutation) continue;
            const start = offset + match.index;
            sites.push(
              site(
                file,
                ast,
                start,
                start + mutation.width,
                mutation.replacement,
                `sql:${kind}`,
                source,
              ),
            );
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return sites;
}

export function enumerateSites(kind = 'all') {
  return sourceFiles.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    return [
      ...(kind === 'sql' ? [] : tsSites(file, ast, source)),
      ...(kind === 'ts' ? [] : sqlSites(file, ast, source)),
    ];
  });
}
