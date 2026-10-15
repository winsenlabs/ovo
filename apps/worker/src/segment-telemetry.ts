import type { ProviderUsage } from './cost-policy-types.ts';
import { providerMeterKey } from './cost-policy-support.ts';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';

/** At most this many meter keys are reported per segment (the `segment.ended` usage bound). */
const MAX_METERS = 24;

/** What one segment used and did, for its `segment.ended` event (transfer design 7.11). */
export class SegmentStats {
  readonly usage: Record<string, number> = {};
  turns = 0;
  startedAt?: number;

  constructor(
    readonly index: number,
    readonly language: string,
  ) {}

  /** Adds a provider usage report's quantity under its meter key. */
  meter(usage: ProviderUsage): void {
    if (usage.state === 'unavailable') return;
    const quantity = Number(usage.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) return;
    const key = providerMeterKey(usage);
    if (!(key in this.usage) && Object.keys(this.usage).length >= MAX_METERS) return;
    this.usage[key] = (this.usage[key] ?? 0) + quantity;
  }
}

/**
 * The call's telemetry session as one segment's graph sees it: every audit it writes carries
 * `segment: <index>` (the inspector's Events tab groups by it). Everything else is the call's own
 * session, unchanged: one telemetry session per call (telemetry-runtime refuses a second).
 */
export function segmentTelemetry(
  telemetry: WorkerSessionTelemetry,
  index: number,
): WorkerSessionTelemetry {
  const audit: WorkerSessionTelemetry['audit'] = (type, payload, epoch) =>
    telemetry.audit(type, { ...payload, segment: index }, epoch);
  return new Proxy(telemetry, {
    get(target, property) {
      if (property === 'audit') return audit;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
