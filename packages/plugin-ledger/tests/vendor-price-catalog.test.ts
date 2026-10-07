import { describe, expect, it } from 'vitest';
import {
  bindingModel,
  diffVendorCatalog,
  parseDecimal,
  priceCardMatchesModel,
  VENDOR_PRICE_CATALOG,
  vendorPriceCard,
} from '../src/index.ts';

describe('price card model dimension (OPS-13)', () => {
  it('lets a wildcard card price any model and a model card only its own model', () => {
    expect(priceCardMatchesModel({}, 'gpt-6-luna')).toBe(true);
    expect(priceCardMatchesModel({}, undefined)).toBe(true);
    expect(priceCardMatchesModel({ model: 'gpt-6-luna' }, 'gpt-6-luna')).toBe(true);
    expect(priceCardMatchesModel({ model: 'GPT-6-Luna' }, ' gpt-6-luna ')).toBe(true);
    // The silent misprice this fixes: a gpt-4o-mini card on a binding switched to gpt-6-luna.
    expect(priceCardMatchesModel({ model: 'gpt-4o-mini' }, 'gpt-6-luna')).toBe(false);
    expect(priceCardMatchesModel({ model: 'gpt-6-luna' }, undefined)).toBe(false);
  });

  it('reads the binding’s model, else the default its binding schema runs', () => {
    const schema = { properties: { model: { type: 'string', default: 'eleven_flash_v2_5' } } };
    expect(bindingModel({ model: 'gpt-6-luna' })).toBe('gpt-6-luna');
    expect(bindingModel({}, schema)).toBe('eleven_flash_v2_5');
    expect(bindingModel({ model: '' }, schema)).toBe('eleven_flash_v2_5');
    expect(bindingModel(undefined)).toBeUndefined();
  });
});

describe('vendor price catalog (OPS-14)', () => {
  it('holds valid, uniquely identified cards whose provenance names a dated source', () => {
    const ids = VENDOR_PRICE_CATALOG.map((entry) => entry.card.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of VENDOR_PRICE_CATALOG) {
      const card = vendorPriceCard(entry);
      expect(card.currency).toMatch(/^[A-Z]{3}$/);
      expect(() => parseDecimal(card.minorUnitsPerBlock)).not.toThrow();
      expect(parseDecimal(card.blockQuantity).numerator > 0n).toBe(true);
      expect(entry.source.url).toMatch(/^https:\/\//);
      expect(entry.source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(card.provenance).toContain(entry.source.url);
      expect(card.provenance).toContain(`retrieved ${entry.source.retrievedAt}`);
      expect(entry.meterKeys.length).toBeGreaterThan(0);
      // The worker refuses usage whose provider or unit differs from its card's.
      for (const key of entry.meterKeys) {
        expect(key.startsWith(`${card.provider}.`)).toBe(true);
        expect(key.endsWith(`.${card.unit}`)).toBe(true);
      }
    }
  });

  it('prices gpt-6-luna as confirmed on the OpenAI pricing page', () => {
    const luna = VENDOR_PRICE_CATALOG.filter((entry) => entry.card.model === 'gpt-6-luna');
    expect(luna.map((entry) => entry.card.unit).sort()).toEqual([
      'cache_read_input_tokens',
      'cache_write_input_tokens',
      'input_tokens',
      'output_tokens',
      'uncached_input_tokens',
    ]);
    for (const entry of luna) {
      // A new version, so a ledger holding the old provisional 2026-10-06 card sees an update.
      expect(entry.card.version).toBe('2026-10-06-confirmed');
      expect(entry.card.provisional).toBeUndefined();
      expect(vendorPriceCard(entry).provenance).toContain(
        'https://developers.openai.com/api/docs/pricing (retrieved 2026-10-06)',
      );
      expect(vendorPriceCard(entry).provenance).not.toContain('PROVISIONAL');
    }
  });

  it('prices ElevenLabs Flash v2.5 at the published $0.04 per 1K characters', () => {
    const flash = VENDOR_PRICE_CATALOG.find(
      (entry) => entry.card.id === 'elevenlabs-tts-flash-v2-5',
    )!;
    expect(flash.card).toMatchObject({
      model: 'eleven_flash_v2_5',
      currency: 'USD',
      minorUnitsPerBlock: '4',
      blockQuantity: '1000',
    });
  });

  it('prices OpenAI web search at the confirmed $10 per 1K calls for any model', () => {
    const search = VENDOR_PRICE_CATALOG.find(
      (entry) => entry.card.id === 'openai-web-search-calls',
    )!;
    expect(search.meterKeys).toEqual(['openai.inference.web_search_calls']);
    expect(search.card).toMatchObject({
      provider: 'openai',
      unit: 'web_search_calls',
      currency: 'USD',
      minorUnitsPerBlock: '1000',
      blockQuantity: '1000',
    });
    // A wildcard card: the price is the same for every model, so a model swap stays priced.
    expect(search.card.model).toBeUndefined();
    expect(priceCardMatchesModel(search.card, 'gpt-6-luna')).toBe(true);
    expect(search.card.provisional).toBeUndefined();
    expect(vendorPriceCard(search).provenance).toContain(
      'https://developers.openai.com/api/docs/pricing (retrieved 2026-10-07)',
    );
  });

  it('diffs the catalog against stored cards: not imported, imported, or an update available', () => {
    const [first, second, third] = VENDOR_PRICE_CATALOG;
    const diff = diffVendorCatalog(
      [
        { id: first!.card.id, version: first!.card.version, effectiveAt: first!.card.effectiveAt },
        { id: second!.card.id, version: '2026-01-01', effectiveAt: '2026-01-01T00:00:00.000Z' },
        { id: second!.card.id, version: '2026-05-01', effectiveAt: '2026-05-01T00:00:00.000Z' },
      ],
      [first!, second!, third!],
    );
    expect(diff.map((entry) => entry.status)).toEqual([
      'imported',
      'update_available',
      'not_imported',
    ]);
    expect(diff[1]).toMatchObject({ storedVersion: '2026-05-01' });
    expect(diff[0]).not.toHaveProperty('storedVersion');
    expect(diff[2]!.priceCard).toEqual(vendorPriceCard(third!));
  });
});
