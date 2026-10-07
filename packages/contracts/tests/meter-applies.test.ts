import { describe, expect, it } from 'vitest';
import { meterApplies } from '../src/index.ts';

describe('meterApplies', () => {
  it('applies a meter with no condition to any binding', () => {
    expect(meterApplies({}, undefined)).toBe(true);
    expect(meterApplies({}, { model: 'x' })).toBe(true);
  });

  it('compares a top-level field as a string, missing as empty', () => {
    const when = { field: 'model', in: ['tts-1'] };
    expect(meterApplies({ when }, { model: 'tts-1' })).toBe(true);
    expect(meterApplies({ when }, { model: 'gpt-4o-mini-tts' })).toBe(false);
    expect(meterApplies({ when }, {})).toBe(false);
  });

  it('follows a dotted path into a nested binding object', () => {
    const when = { field: 'webSearch.enabled', in: ['true'] };
    expect(meterApplies({ when }, { webSearch: { enabled: true } })).toBe(true);
    expect(meterApplies({ when }, { webSearch: { enabled: false } })).toBe(false);
    expect(meterApplies({ when }, { webSearch: true })).toBe(false);
    expect(meterApplies({ when }, {})).toBe(false);
    // Only own properties: an inherited name never switches a meter on.
    expect(meterApplies({ when: { field: 'constructor.name', in: ['Object'] } }, {})).toBe(false);
  });
});
