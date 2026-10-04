import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_SPECS,
  CAP_PREFIXES,
  Cap,
  DEFAULT_SPEC,
  HOST_SESSION_SERVICES,
  capabilitySpec,
  parseCapabilityEntry,
} from '../src/index.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.next', 'upstream', 'tests', 'fixtures']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.|\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Every service key provided or read in packages/*\/src and apps/*\/src, resolving simple constants. */
function scanServiceKeys(): Map<string, string> {
  const files = ['packages', 'apps'].flatMap((top) =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = join(ROOT, top, entry.name, 'src');
        try {
          return sources(src);
        } catch {
          return [];
        }
      }),
  );
  const parsed = files.map((file) =>
    ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true),
  );
  const constants = new Map<string, string>();
  const record = (path: string, node: ts.Expression) => {
    const inner = unwrap(node);
    if (ts.isStringLiteralLike(inner)) constants.set(path, inner.text);
    else if (ts.isObjectLiteralExpression(inner))
      for (const property of inner.properties)
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))
          record(`${path}.${property.name.text}`, property.initializer);
  };
  for (const source of parsed)
    source.forEachChild(function walk(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        record(node.name.text, node.initializer);
      node.forEachChild(walk);
    });
  const keys = new Map<string, string>();
  const resolve = (node: ts.Expression, where: string) => {
    const inner = unwrap(node);
    const value = ts.isStringLiteralLike(inner) ? inner.text : constants.get(inner.getText());
    if (value !== undefined) keys.set(value, where);
    if (ts.isConditionalExpression(inner)) {
      addAll(inner.whenTrue, where);
      addAll(inner.whenFalse, where);
    }
  };
  const addAll = (node: ts.Expression, where: string) => {
    const inner = unwrap(node);
    if (ts.isArrayLiteralExpression(inner))
      for (const element of inner.elements)
        if (ts.isSpreadElement(element)) addAll(element.expression, where);
        else resolve(element, where);
    else if (ts.isConditionalExpression(inner)) resolve(inner, where);
  };
  for (const source of parsed) {
    const where = relative(ROOT, source.fileName);
    source.forEachChild(function walk(node) {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        ['provides', 'requires', 'optional'].includes(node.name.text)
      )
        addAll(node.initializer, where);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression.getText();
        if (/(^|\.)(ctx\.(provide|get)|reflect\.get)$/.test(callee) && node.arguments[0])
          resolve(node.arguments[0], where);
      }
      node.forEachChild(walk);
    });
  }
  return keys;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    (ts.isCallExpression(current) && current.expression.getText() === 'Object.freeze')
  )
    current = ts.isCallExpression(current) ? current.arguments[0]! : current.expression;
  return current;
}

describe('capability keys', () => {
  const known = new Set<string>(Object.values(Cap));
  const prefixes = Object.values(CAP_PREFIXES);

  it('covers every service key provided or read in packages/*/src and apps/*/src', () => {
    const scanned = scanServiceKeys();
    expect(scanned.size).toBeGreaterThan(50);
    const missing = [...scanned]
      .filter(([key]) => !known.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)))
      .map(([key, where]) => `${key} (${where})`);
    expect(missing).toEqual([]);
    for (const key of [
      Cap.speech,
      Cap.operations,
      Cap.costLedger,
      Cap.orchestrationStore,
      'orchestration.queue',
    ])
      expect(scanned.has(key), key).toBe(true);
  });

  it('gives every key a spec, with exactly four many-keys and three major-2 keys', () => {
    expect(Object.keys(CAPABILITY_SPECS).sort()).toEqual([...known].sort());
    const specs = Object.entries(CAPABILITY_SPECS);
    expect(
      specs
        .filter(([, spec]) => spec.cardinality === 'many')
        .map(([key]) => key)
        .sort(),
    ).toEqual([
      'ovo.background-task',
      'ovo.carrier.control',
      'ovo.carrier.ingress',
      'ovo.text-filter',
    ]);
    expect(
      specs
        .filter(([, spec]) => spec.major === 2)
        .map(([key]) => key)
        .sort(),
    ).toEqual(['ovo.stt', 'ovo.tts-streaming', 'ovo.voice-session-engine']);
    expect(specs.every(([, spec]) => spec.major === 1 || spec.major === 2)).toBe(true);
    expect(DEFAULT_SPEC).toEqual({ major: 1, cardinality: 'one', scope: 'either' });
  });

  it('includes the new v2 keys and host session services', () => {
    for (const key of [
      'ovo.turn-detector',
      'ovo.vad',
      'ovo.text-filter',
      'ovo.audio-filter',
      'ovo.usage-sink',
      'ovo.transcript-observer',
      'ovo.clock',
      'ovo.net',
      'ovo.carrier.control',
      'ovo.carrier.ingress',
      'ovo.background-task',
      'capacity.signal',
    ])
      expect(known.has(key), key).toBe(true);
    expect(HOST_SESSION_SERVICES).toEqual([
      'ovo.media.duplex',
      'ovo.operation-store',
      'ovo.secret-resolver',
      'ovo.usage-sink',
      'ovo.transcript-observer',
      'ovo.clock',
    ]);
  });

  it('derives specs for dynamic families and parses @major entries', () => {
    expect(capabilitySpec('ovo.tool-connector.custom').scope).toBe('session');
    expect(capabilitySpec('ovo.console-extension.x').scope).toBe('process');
    expect(capabilitySpec('something.else')).toBe(DEFAULT_SPEC);
    expect(capabilitySpec(Cap.carrierControl).scope).toBe('process');
    expect(parseCapabilityEntry('ovo.stt@2')).toEqual({ key: 'ovo.stt', major: 2 });
    expect(parseCapabilityEntry('ovo.native-handlers:pkg@1.2.3')).toEqual({
      key: 'ovo.native-handlers:pkg@1.2.3',
    });
  });
});
