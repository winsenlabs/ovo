import type { DurableJob } from '@winsendotai/ovo-plugin-orchestration';
import { liveSessionRequiresInput } from './live-input-policy.ts';
import { deriveLegacySelections, type ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { ReleaseSelections } from '@winsendotai/ovo-contracts';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { metersFor, type SessionDefaults } from '@winsendotai/ovo-session-host';
import type { ProviderUsage } from './cost-policy-types.ts';
import { meterKey, type UsageMeter } from '@winsendotai/ovo-contracts';
import type {
  CostLedgerService,
  PriceCardVersion,
  RecordUsageInput,
  UsageSourceKind,
} from '@winsendotai/ovo-plugin-ledger';
import type { CostPolicy, WorkerCostPolicyOptions } from './cost-policy-types.ts';
import type { InferenceEvidenceSummary } from './cost-inference.ts';

export interface NormalizedUsage {
  meterKey: string;
  provider: string;
  providerRequestId?: string;
  sourceKind: UsageSourceKind;
  sourceEventType: string;
  sourceEventId: string;
  activity: RecordUsageInput['activity'];
  cacheDisposition: RecordUsageInput['cacheDisposition'];
  quantity: string;
  unit: string;
  occurredAt: string;
}

export function durableReservationFields(options: WorkerCostPolicyOptions, maxCallSeconds: number) {
  if (!options.reservationHolder) return {};
  return {
    holder: options.reservationHolder,
    expiresAt: new Date(Date.now() + (maxCallSeconds + 300) * 1000),
    sessionId: options.sessionId,
    carrierUsage: options.carrierUsage,
  };
}

export function accumulateInferenceEvidence(
  summary: InferenceEvidenceSummary,
  state: 'reported' | 'estimated' | 'unknown',
  reasons: readonly string[],
): void {
  if (state === 'reported') summary.reportedSteps += 1;
  if (state === 'estimated') summary.estimatedSteps += 1;
  if (state === 'unknown') summary.unknownSteps += 1;
  summary.reasons = [...new Set([...summary.reasons, ...reasons])].sort();
}

export function providerMeterKey(
  usage: Pick<ProviderUsage, 'provider' | 'operation' | 'unit'>,
): string {
  if (['carrier', 'stt', 'tts', 'inference'].includes(usage.operation))
    return meterKey(usage as Pick<UsageMeter, 'provider' | 'operation' | 'unit'>);
  return `${usage.provider}.${usage.operation}.${usage.unit}`;
}

export function providerSourceKind(operation: ProviderUsage['operation']): UsageSourceKind {
  if (operation === 'tts' || operation === 'streaming-tts') return 'tts-generation';
  if (operation === 'inference') return 'llm';
  if (operation === 'carrier') return 'carrier';
  return 'stt';
}

export function usageIdentity(sessionId: string, input: NormalizedUsage): string {
  return `usage:${sessionId}:${input.sourceKind}:${input.sourceEventId}:${input.unit}`;
}

export function millisecondsToSeconds(milliseconds: number): string {
  const whole = Math.floor(milliseconds / 1_000);
  const remainder = milliseconds % 1_000;
  if (!remainder) return String(whole);
  return `${whole}.${String(remainder).padStart(3, '0').replace(/0+$/, '')}`;
}

export function validatePolicy(policy: CostPolicy): void {
  if (!policy.budgetId || !/^[1-9]\d{0,59}$/.test(policy.reservationPaise))
    throw new TypeError('Cost policy budget and reservation are required');
  if (!Number.isSafeInteger(policy.maxCallSeconds) || policy.maxCallSeconds < 1)
    throw new TypeError('Cost policy maximum duration is invalid');
  const entries = Object.entries(policy.priceCards);
  if (!entries.length || entries.length > 100)
    throw new TypeError('Cost policy price map is invalid');
  for (const [key, reference] of entries)
    if (!key || !reference.id || !reference.version)
      throw new TypeError('Cost policy price reference is invalid');
}

export async function loadCostCatalog(
  ledger: CostLedgerService,
  policy: CostPolicy,
  requiredMeterKeys: readonly string[],
): Promise<Map<string, PriceCardVersion>> {
  const cards = new Map<string, PriceCardVersion>();
  for (const meterKey of new Set(requiredMeterKeys))
    if (!policy.priceCards[meterKey]) throw new Error(`Cost meter is not configured: ${meterKey}`);
  for (const [meterKey, reference] of Object.entries(policy.priceCards)) {
    const card = await ledger.getPriceCard(reference.id, reference.version);
    if (!card) throw new Error(`Cost price version is unavailable: ${meterKey}`);
    const hasFxId = reference.fxId !== undefined;
    const hasFxVersion = reference.fxVersion !== undefined;
    if (hasFxId !== hasFxVersion) throw new Error(`Cost FX reference is incomplete: ${meterKey}`);
    if (card.currency === 'INR' && hasFxId)
      throw new Error(`INR cost meter must not include FX: ${meterKey}`);
    if (card.currency !== 'INR') {
      if (!reference.fxId || !reference.fxVersion)
        throw new Error(`Cost meter requires immutable FX: ${meterKey}`);
      const fx = await ledger.getFxVersion(reference.fxId, reference.fxVersion);
      if (!fx || fx.baseCurrency !== card.currency || fx.quoteCurrency !== 'INR')
        throw new Error(`Cost FX version does not match price currency: ${meterKey}`);
    }
    cards.set(meterKey, card);
  }
  return cards;
}

export function requiredCostMeterKeys(
  release: Pick<ReleaseRecord, 'config'>,
  keys: {
    carrier: string;
    tts: string;
    stt: string;
    inference: {
      aggregateInput: string;
      uncachedInput: string;
      cacheReadInput: string;
      cacheWriteInput: string;
      output: string;
    };
  },
  selected?: { selections: ReleaseSelections; registry: PluginRegistry },
): readonly string[] {
  const policy = release.config.costPolicy;
  if (!policy) return [];
  if (selected)
    return metersFor(selected.selections, selected.registry, {
      requiresInput: liveSessionRequiresInput(release.config),
    }).map((row) => row.meter.key);
  const required: string[] = [keys.carrier, keys.tts];
  const requiresInput = liveSessionRequiresInput(release.config);
  if (requiresInput) required.push(keys.stt);
  if (release.config.mode === 'context' || release.config.mode === 'agent') {
    const detailedInput = [
      keys.inference.uncachedInput,
      keys.inference.cacheReadInput,
      keys.inference.cacheWriteInput,
    ];
    required.push(
      ...(detailedInput.every((meterKey) => policy.priceCards[meterKey])
        ? detailedInput
        : policy.priceCards[keys.inference.aggregateInput]
          ? [keys.inference.aggregateInput]
          : detailedInput),
      keys.inference.output,
    );
  }
  return required;
}

export async function extendHeldCostReservations(
  ledger: CostLedgerService,
  sessions: readonly {
    reservationId: string;
    holder: string;
    maxCallSeconds: number;
    job: DurableJob;
    extensionLost?: boolean;
  }[],
  terminate: (job: DurableJob, reason: string) => Promise<void>,
): Promise<void> {
  await Promise.all(
    sessions.map(async (session) => {
      if (!session.extensionLost) {
        try {
          const extended = await ledger.extendReservation(
            session.reservationId,
            session.holder,
            new Date(Date.now() + (session.maxCallSeconds + 300) * 1000),
          );
          if (extended) return;
        } catch {
          // A failed expiry write loses the admission guarantee just like a holder mismatch.
        }
        session.extensionLost = true;
      }
      try {
        await terminate(session.job, 'cost-reservation-lost');
      } catch {
        // Keep retrying termination on each heartbeat while this session remains active.
      }
    }),
  );
}

export function selectedReleaseSelections(
  release: ReleaseRecord,
  registry?: PluginRegistry,
  defaults?: SessionDefaults,
): ReleaseSelections | undefined {
  if (Object.keys(release.selections ?? {}).length) return release.selections as ReleaseSelections;
  if (!registry) return undefined;
  const legacy = deriveLegacySelections(release, registry, {
    engine: defaults?.engine ?? '@winsendotai/ovo-plugin-voice-session-engine',
    ...(defaults?.turnDetector ? { turnDetector: defaults.turnDetector } : {}),
  });
  return Object.fromEntries(
    Object.entries(legacy).map(([slot, selection]) => [
      slot,
      {
        ...selection,
        version: registry!.get(selection.pluginId)!.manifest.version,
      },
    ]),
  ) as ReleaseSelections;
}
