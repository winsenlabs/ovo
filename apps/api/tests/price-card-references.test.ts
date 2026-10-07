import { describe, expect, it } from 'vitest';
import { resolvePriceCards } from '../src/price-card-references.ts';

const references = {
  'openai.inference.input_tokens': {
    id: 'openai-gpt-6-luna-input',
    version: '2026-10-06-confirmed',
  },
  'openai.inference.output_tokens': { id: 'openai-gpt-6-luna-output', version: '2026-10-06' },
  'openai.inference.cache_read_input_tokens': { id: 'missing', version: '1' },
};

const ledger = {
  async getPriceCard(id: string, version: string) {
    if (id === 'openai-gpt-6-luna-input') return { id, version } as never;
    if (id === 'openai-gpt-6-luna-output') return { id, version, provisional: true } as never;
    return undefined;
  },
};

describe('resolvePriceCards', () => {
  it('marks each reference with the ledger card’s provisional flag', async () => {
    await expect(resolvePriceCards(references, ledger)).resolves.toEqual({
      'openai.inference.input_tokens': {
        ...references['openai.inference.input_tokens'],
        provisional: false,
      },
      'openai.inference.output_tokens': {
        ...references['openai.inference.output_tokens'],
        provisional: true,
      },
      // A card the ledger does not hold stays a bare reference, which compat treats as provisional.
      'openai.inference.cache_read_input_tokens':
        references['openai.inference.cache_read_input_tokens'],
    });
  });

  it('passes references through without a ledger or when the ledger fails', async () => {
    await expect(resolvePriceCards(references)).resolves.toBe(references);
    const failing = { getPriceCard: async () => Promise.reject(new Error('db down')) };
    await expect(resolvePriceCards(references, failing)).resolves.toEqual(references);
  });
});
