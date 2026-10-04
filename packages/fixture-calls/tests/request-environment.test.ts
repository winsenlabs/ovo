import { describe, expect, it } from 'vitest';
import { fixtureCallsEnvironmentEnabled } from '../src/request.ts';

describe('fixture call environment switch', () => {
  it.each([
    [undefined, undefined],
    ['true', true],
    ['false', false],
  ] as const)('maps %s to %s', (value, expected) => {
    expect(fixtureCallsEnvironmentEnabled(value)).toBe(expected);
  });

  it.each(['', 'TRUE', '1', 'yes'])('rejects invalid value %s', (value) => {
    expect(() => fixtureCallsEnvironmentEnabled(value)).toThrow(
      'OVO_FIXTURE_TEST_CALLS must be true or false',
    );
  });
});
