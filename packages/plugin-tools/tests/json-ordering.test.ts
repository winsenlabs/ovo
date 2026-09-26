import { expect, it } from 'vitest';
import { canonicalJson, schemaDigest } from '../src/json.ts';
import { canonicalJson as contractJson } from '@winsendotai/ovo-contracts';
import { createHash } from 'node:crypto';

it('uses code-unit key order for persisted operation and schema digests', () => {
  const input = { a: 1, A: 2, é: 3, z: 4 };
  const expected = '{"A":2,"a":1,"z":4,"é":3}';
  expect(canonicalJson(input)).toBe(expected);
  expect(canonicalJson(input)).toBe(contractJson(input));
  expect(schemaDigest(input)).toBe(createHash('sha256').update(expected).digest('hex'));
});
