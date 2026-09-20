export interface PriceCard {
  id: string;
  version: string;
  provider: string;
  unit: string;
  currency: string;
  minorUnitsPerBlock: string;
  blockQuantity: string;
}
export interface Usage {
  id: string;
  workspaceId: string;
  sessionId: string;
  provider: string;
  providerRequestId: string;
  quantity: string;
  unit: string;
  state: 'estimated' | 'reconciled';
}
export interface PricedUsage extends Usage {
  amountMinor: string;
  currency: string;
  priceCardId: string;
  priceCardVersion: string;
  rounding: 'half-up';
}
/** Decimal multiplication/division happens with integers. A row rounds once, to minor units. */
function rational(value: string): { numerator: bigint; denominator: bigint } {
  if (!/^(0|[1-9]\d{0,29})(\.\d{1,12})?$/.test(value))
    throw new Error('Invalid nonnegative decimal');
  const [whole, fraction = ''] = value.split('.');
  return { numerator: BigInt(whole! + fraction), denominator: 10n ** BigInt(fraction.length) };
}
export function priceUsage(usage: Usage, card: PriceCard): PricedUsage {
  if (usage.provider !== card.provider || usage.unit !== card.unit)
    throw new Error('Provider/native unit mismatch');
  if (
    !/^[A-Z]{3}$/.test(card.currency) ||
    !card.id ||
    !card.version ||
    !usage.id ||
    !usage.providerRequestId
  )
    throw new Error('Missing pricing provenance');
  const quantity = rational(usage.quantity),
    price = rational(card.minorUnitsPerBlock),
    block = rational(card.blockQuantity);
  if (block.numerator === 0n) throw new Error('Price block must be positive');
  const numerator = quantity.numerator * price.numerator * block.denominator;
  const denominator = quantity.denominator * price.denominator * block.numerator;
  const amount = (numerator * 2n + denominator) / (2n * denominator);
  return {
    ...usage,
    amountMinor: amount.toString(),
    currency: card.currency,
    priceCardId: card.id,
    priceCardVersion: card.version,
    rounding: 'half-up',
  };
}
export function summarizeUsage(
  rows: readonly PricedUsage[],
): Record<string, { estimatedMinor: string; reconciledMinor: string }> {
  const identities = new Map<string, PricedUsage>();
  for (const row of rows) {
    const key = JSON.stringify([row.workspaceId, row.sessionId, row.id]);
    const old = identities.get(key);
    if (old && JSON.stringify(old) !== JSON.stringify(row))
      throw new Error('Conflicting usage identity');
    identities.set(key, row);
  }
  const currencies: Record<string, { estimatedMinor: string; reconciledMinor: string }> = {};
  for (const row of identities.values()) {
    if (!/^\d+$/.test(row.amountMinor) || !/^[A-Z]{3}$/.test(row.currency))
      throw new Error('Invalid money amount or currency');
    const total = (currencies[row.currency] ??= { estimatedMinor: '0', reconciledMinor: '0' });
    const field = row.state === 'reconciled' ? 'reconciledMinor' : 'estimatedMinor';
    total[field] = (BigInt(total[field]) + BigInt(row.amountMinor)).toString();
  }
  return currencies;
}
