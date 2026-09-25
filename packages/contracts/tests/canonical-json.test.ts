import { describe, expect, it } from 'vitest';
import { canonicalJson, compareCodeUnits } from '../src/index.ts';

describe('canonicalJson', () => {
  it('orders keys by UTF-16 code unit, never by locale', () => {
    const value = { b: 1, a: 2, B: 3, é: 4, '10': 5, '9': 6, _: 7 };
    expect(canonicalJson(value)).toBe('{"10":5,"9":6,"B":3,"_":7,"a":2,"b":1,"é":4}');
    // localeCompare would interleave cases ('a' < 'B'); code units put upper case first.
    expect(['b', 'a', 'B'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b']);
    expect(['b', 'a', 'B'].sort((x, y) => x.localeCompare(y))).not.toEqual(['B', 'a', 'b']);
  });

  it('is stable across key insertion order, recursively', () => {
    const left = { outer: { z: [1, { y: true, x: null }], a: 'text' }, list: [] };
    const right = { list: [], outer: { a: 'text', z: [1, { x: null, y: true }] } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe(
      '{"list":[],"outer":{"a":"text","z":[1,{"x":null,"y":true}]}}',
    );
  });

  it('keeps JSON.stringify value semantics', () => {
    const samples: unknown[] = [
      'text "quoted"',
      42,
      -0,
      NaN,
      Infinity,
      true,
      null,
      [undefined, () => 1, Symbol('s'), 1],
      { dropped: undefined, fn: () => 1, kept: 1 },
      new Date('2026-09-22T00:00:00.000Z'),
      { nested: { toJSON: (key: string) => `key:${key}` } },
      [new Number(3), new String('s'), new Boolean(false)],
    ];
    for (const sample of samples) expect(canonicalJson(sample)).toBe(JSON.stringify(sample));
    expect(canonicalJson(undefined)).toBe(JSON.stringify(undefined));
  });

  it('rejects cycles and bigint like JSON.stringify', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
    expect(() => canonicalJson({ big: 1n })).toThrow(TypeError);
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });
});
