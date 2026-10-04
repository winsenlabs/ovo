import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inputDigest } from '../src/identity.ts';

describe('campaign input digest', () => {
  it('sorts mixed-case and non-ASCII keys by code unit for persisted identities', () => {
    const value = { a: 1, ø: 3, A: 2 };
    const expected = createHash('sha256').update('{"A":2,"a":1,"ø":3}').digest('hex');
    expect(inputDigest(value)).toBe(expected);
    expect(inputDigest({ ø: 3, A: 2, a: 1 })).toBe(expected);
  });
});
