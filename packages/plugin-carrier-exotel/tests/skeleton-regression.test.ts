import { describe, expect, it } from 'vitest';
import { plugins } from '../src/index.ts';

describe('Exotel catalog entry', () => {
  it('loads one real v2 carrier plugin instead of a skeleton', () => {
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest).toMatchObject({
      id: '@winsendotai/ovo-carrier-exotel',
      contractVersion: 2,
      kind: 'carrier',
      provider: 'exotel',
      provides: ['ovo.carrier.control', 'ovo.carrier.ingress'],
    });
  });
});
