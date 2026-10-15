import { describe, expect, it } from 'vitest';
import { violation } from '../lib/architecture-rules.mjs';

const kindOf = (dir: string) => (dir === 'packages/conformance' ? 'test-kit' : undefined);
const target = (subpath: string) => ({
  type: 'workspace',
  dir: 'packages/conformance',
  subpath,
});

// The conformance drivers entry loads no vitest (the architecture gate proves it), so the fakes
// in it (the media room among them) may serve app and vendor-plugin tests; the kit root may not.
describe('architecture rules: the conformance drivers entry', () => {
  for (const kind of ['app', 'vendor-plugin']) {
    it(`lets a ${kind} import only the drivers entry`, () => {
      const from = { kind, dir: `${kind}/x` };
      expect(violation(from, target('drivers'), kindOf)).toBeUndefined();
      expect(violation(from, target(''), kindOf)).toMatch(/drivers/);
    });
  }
});
