import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';

/**
 * A cost policy names price cards as bare `{ id, version }`, which cannot say whether the price is
 * confirmed. Reads each card's `provisional` flag from the ledger so compat (the LAT-3
 * speculative-LLM warning) can tell a confirmed card from a placeholder. Without a ledger, or for
 * a card it does not hold, the reference is passed through unchanged (treated as provisional).
 */
export async function resolvePriceCards(
  references: Readonly<Record<string, { id: string; version: string }>> | undefined,
  ledger?: Pick<CostLedgerService, 'getPriceCard'>,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (!references || !ledger) return references;
  const entries = await Promise.all(
    Object.entries(references).map(async ([key, reference]) => {
      const card = await ledger
        .getPriceCard(reference.id, reference.version)
        .catch(() => undefined);
      return [key, card ? { ...reference, provisional: card.provisional === true } : reference];
    }),
  );
  return Object.fromEntries(entries);
}
