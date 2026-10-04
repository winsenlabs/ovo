import {
  meterKey,
  priceUsage,
  type PriceCard,
  type PricedUsage,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';

/** Price only covered fixture meters; leave uncovered/native-currency meters explicitly unpriced. */
export async function persistFixtureUsage(input: {
  workspaceId: string;
  callId: string;
  meters: readonly UsageMeter[];
  priceCards?: Readonly<Record<string, { id: string; version: string }>>;
  getPriceCard?: (id: string, version: string) => Promise<PriceCard | undefined>;
  writePriced: (usage: PricedUsage) => Promise<unknown>;
  writeMeter: (meter: UsageMeter, key: string, unpriced: boolean) => Promise<unknown>;
  createId: () => string;
}): Promise<void> {
  for (const meter of input.meters) {
    const key = meterKey(meter);
    const reference = input.priceCards?.[key];
    const card =
      reference && input.getPriceCard
        ? await input.getPriceCard(reference.id, reference.version)
        : undefined;
    const priced =
      card?.currency === 'INR' && card.provider === meter.provider && card.unit === meter.unit
        ? priceUsage(
            {
              id: input.createId(),
              workspaceId: input.workspaceId,
              sessionId: input.callId,
              provider: meter.provider,
              providerRequestId: meter.requestId,
              quantity: meter.quantity,
              unit: meter.unit,
              state: 'estimated',
            },
            card,
          )
        : undefined;
    if (priced) await input.writePriced(priced);
    await input.writeMeter(meter, key, priced === undefined);
  }
}
