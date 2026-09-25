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

export interface PriceCardVersion {
  id: string;
  version: string;
  provider: string;
  unit: string;
  currency: string;
  minorUnitsPerBlock: string;
  blockQuantity: string;
  effectiveAt: string;
  provenance: string;
}

export interface FxVersion {
  id: string;
  version: string;
  baseCurrency: string;
  quoteCurrency: 'INR';
  rateNumerator: string;
  rateDenominator: string;
  effectiveAt: string;
  provenance: string;
}

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
}

export interface ReservationResult {
  admitted: boolean;
  reservationId: string;
  state?: 'reserved' | 'settled' | 'released';
  reason?: 'budget-threshold';
  budget: BudgetSnapshot;
}

export interface CostSummary {
  workspaceId: string;
  sessionId: string;
  currency: 'INR';
  estimatedPaise: string;
  reconciledPaise: string;
  totalPaise: string;
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
