import { priceUsage, type PriceCard } from '@winsendotai/ovo-contracts';
import { expect, it, vi } from 'vitest';

it('imports preview data without seeding and labels priceable native-unit demo cards', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('No seed requests in tests'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const { demoPriceCards } = await import(
      new URL('../../../scripts/seed-demo-price-cards.mjs', import.meta.url).href
    );
    const cards = demoPriceCards() as Array<
      PriceCard & { effectiveAt: string; provenance: string }
    >;
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(cards).toHaveLength(8);
    expect(new Set(cards.map((card) => card.id)).size).toBe(cards.length);
    expect(cards.map((card) => [card.provider, card.unit])).toContainEqual([
      'deepgram',
      'audio_seconds',
    ]);
    expect(cards.map((card) => [card.provider, card.unit])).toContainEqual([
      'openai',
      'input_tokens',
    ]);
    for (const card of cards) {
      expect(card.id).toMatch(/^demo-illustrative-/);
      expect(card.version).toContain('ILLUSTRATIVE — NOT A QUOTE');
      expect(card.provenance).toContain('ILLUSTRATIVE — NOT A QUOTE');
      expect(card.effectiveAt).toBe('2026-01-01T00:00:00.000Z');
      expect(
        priceUsage(
          {
            id: 'usage',
            workspaceId: 'demo',
            sessionId: 'demo',
            provider: card.provider,
            providerRequestId: 'fixture-request',
            quantity: '1000',
            unit: card.unit,
            state: 'estimated',
          },
          card,
        ),
      ).toMatchObject({
        amountMinor: '100',
        currency: 'INR',
        priceCardId: card.id,
        priceCardVersion: card.version,
      });
    }
    cards[0]!.provenance = 'changed';
    expect(demoPriceCards()[0].provenance).toContain('ILLUSTRATIVE — NOT A QUOTE');
  } finally {
    fetch.mockRestore();
    log.mockRestore();
  }
});
