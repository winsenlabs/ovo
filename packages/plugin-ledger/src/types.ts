import type {
  FxVersion,
  PriceCardVersion as ContractPriceCardVersion,
} from '@winsendotai/ovo-contracts';
export type { FxVersion } from '@winsendotai/ovo-contracts';

/** A stored price card (OPS-13): the contract card plus the model it prices and its confidence. */
export interface PriceCardVersion extends ContractPriceCardVersion {
  /** The model or SKU the vendor price applies to; absent means any model (wildcard). */
  model?: string;
  /** True for a placeholder or unverified price; costs priced with it are labelled provisional. */
  provisional?: boolean;
}

export type UsageSourceKind =
  | 'carrier'
  | 'media'
  | 'stt'
  | 'tts-generation'
  | 'llm'
  | 'worker'
  | 'network'
  | 'recording'
  | 'shared';

export type UsageActivity = 'normal' | 'failed-attempt' | 'transfer' | 'retry' | 'startup' | 'idle';

export interface RecordUsageInput {
  idempotencyKey: string;
  usageId?: string;
  workspaceId: string;
  sessionId: string;
  callId?: string;
  attemptId?: string;
  provider: string;
  providerRequestId?: string;
  sourceKind: UsageSourceKind;
  sourceEventType: string;
  sourceEventId: string;
  activity: UsageActivity;
  cacheDisposition: 'none' | 'generation' | 'hit';
  quantity: string;
  unit: string;
  occurredAt: string;
  priceCard: { id: string; version: string };
  fx?: { id: string; version: string };
}

export interface RecordedUsage {
  usageId: string;
  chargeId: string;
  state: 'estimated' | 'reconciled';
  nativeQuantity: string;
  nativeUnit: string;
  nativeAmountMinor: string;
  nativeCurrency: string;
  amountPaise: string;
  priceCard: { id: string; version: string };
  fx?: { id: string; version: string };
}

export interface ReconcileUsageInput {
  idempotencyKey: string;
  workspaceId: string;
  usageId: string;
  providerInvoiceId: string;
  providerInvoiceLineId: string;
  actualAmountMinor: string;
  currency: string;
  fx?: { id: string; version: string };
  occurredAt: string;
}

export interface ReconciliationResult {
  usageId: string;
  correctionId: string;
  deltaPaise: string;
  effectiveAmountPaise: string;
  state: 'reconciled';
}

export type AllocationReason =
  'failed-attempt' | 'transfer' | 'retry' | 'worker-shared' | 'shared-service';

export interface AllocateChargeInput {
  idempotencyKey: string;
  chargeId: string;
  basis: string;
  targets: {
    id: string;
    weight: string;
    reason: AllocationReason;
    callId?: string;
    attemptId?: string;
  }[];
}

export interface AllocationResult {
  allocationId: string;
  chargeId: string;
  amountPaise: string;
  basis: string;
  targets: (AllocateChargeInput['targets'][number] & { amountPaise: string })[];
}

export interface BudgetPolicy {
  id: string;
  workspaceId: string;
  limitPaise: string;
  admissionOverspendPaise: string;
}

export interface BudgetSnapshot extends BudgetPolicy {
  spentPaise: string;
  reservedPaise: string;
  availableForAdmissionPaise: string;
  overLimit: boolean;
}

export interface BudgetReservationInput {
  budgetId: string;
  reservationId: string;
  amountPaise: string;
  sourceRef: string;
  /** Durable worker ownership. Legacy standalone reservations may omit these fields. */
  holder?: string;
  expiresAt?: Date;
  sessionId?: string;
  carrierUsage?: {
    meterKey: string;
    provider: string;
    priceCard: { id: string; version: string };
    fx?: { id: string; version: string };
  };
}

export interface ReservationResult {
  admitted: boolean;
  reservationId: string;
  state?: 'reserved' | 'settled' | 'released';
  reason?: 'budget-threshold' | 'reservation-not-active';
  budget: BudgetSnapshot;
}

export interface CostSummary {
  workspaceId: string;
  sessionId: string;
  currency: 'INR';
  estimatedPaise: string;
  reconciledPaise: string;
  totalPaise: string;
  /** True when any charge was priced with a provisional (placeholder) price card. */
  provisional: boolean;
  provisionalPriceCards: { id: string; version: string }[];
}

export interface LedgerPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface CostLedgerService {
  migrate(): Promise<void>;
  putPriceCard(card: PriceCardVersion): Promise<PriceCardVersion>;
  getPriceCard(id: string, version: string): Promise<PriceCardVersion | undefined>;
  listPriceCards(limit?: number, cursor?: string): Promise<LedgerPage<PriceCardVersion>>;
  putFxVersion(fx: FxVersion): Promise<FxVersion>;
  getFxVersion(id: string, version: string): Promise<FxVersion | undefined>;
  listFxVersions(limit?: number, cursor?: string): Promise<LedgerPage<FxVersion>>;
  recordUsage(input: RecordUsageInput): Promise<RecordedUsage>;
  reconcileUsage(input: ReconcileUsageInput): Promise<ReconciliationResult>;
  allocateCharge(input: AllocateChargeInput): Promise<AllocationResult>;
  createBudget(policy: BudgetPolicy): Promise<BudgetSnapshot>;
  reserveBudget(input: BudgetReservationInput): Promise<ReservationResult>;
  extendReservation(id: string, holder: string, until: Date): Promise<boolean>;
  settleReservation(reservationId: string, actualPaise: string): Promise<ReservationResult>;
  releaseReservation(reservationId: string): Promise<ReservationResult>;
  applyLateAdjustment(input: {
    budgetId: string;
    idempotencyKey: string;
    deltaPaise: string;
    sourceRef: string;
  }): Promise<BudgetSnapshot>;
  getSessionCost(workspaceId: string, sessionId: string): Promise<CostSummary>;
  getBudget(id: string): Promise<BudgetSnapshot | undefined>;
  listBudgets(
    workspaceId: string,
    limit?: number,
    cursor?: string,
  ): Promise<LedgerPage<BudgetSnapshot>>;
  close(): Promise<void>;
}

export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}
