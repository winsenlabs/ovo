import { Pool, type PoolConfig } from 'pg';
import type {
  AllocateChargeInput,
  AllocationResult,
  BudgetPolicy,
  BudgetReservationInput,
  BudgetSnapshot,
  CostSummary,
  CostLedgerService,
  FxVersion,
  LedgerPage,
  PriceCardVersion,
  RecordedUsage,
  ReconcileUsageInput,
  ReconciliationResult,
  RecordUsageInput,
  ReservationResult,
} from './types.ts';
import { AllocationRepository } from './postgres/allocation.ts';
import { BudgetRepository } from './postgres/budgets.ts';
import { CostCatalogRepository } from './postgres/catalog.ts';
import { runCostMigrations } from './postgres/migrations.ts';
import { UsageRepository } from './postgres/usage.ts';

export class PostgresCostLedger implements CostLedgerService {
  readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly catalog: CostCatalogRepository;
  private readonly usage: UsageRepository;
  private readonly allocations: AllocationRepository;
  private readonly budgets: BudgetRepository;

  constructor(config: PoolConfig | Pool) {
    this.ownsPool = !(config instanceof Pool);
    this.pool = config instanceof Pool ? config : new Pool(config);
    this.catalog = new CostCatalogRepository(this.pool);
    this.usage = new UsageRepository(this.pool);
    this.allocations = new AllocationRepository(this.pool);
    this.budgets = new BudgetRepository(this.pool);
  }

  migrate(): Promise<void> {
    return runCostMigrations(this.pool);
  }

  putPriceCard(card: PriceCardVersion): Promise<PriceCardVersion> {
    return this.catalog.putPriceCard(card);
  }

  getPriceCard(id: string, version: string): Promise<PriceCardVersion | undefined> {
    return this.catalog.getPriceCard(id, version);
  }

  listPriceCards(limit?: number, cursor?: string): Promise<LedgerPage<PriceCardVersion>> {
    return this.catalog.listPriceCards(limit, cursor);
  }

  putFxVersion(fx: FxVersion): Promise<FxVersion> {
    return this.catalog.putFxVersion(fx);
  }

  getFxVersion(id: string, version: string): Promise<FxVersion | undefined> {
    return this.catalog.getFxVersion(id, version);
  }

  listFxVersions(limit?: number, cursor?: string): Promise<LedgerPage<FxVersion>> {
    return this.catalog.listFxVersions(limit, cursor);
  }

  recordUsage(input: RecordUsageInput): Promise<RecordedUsage> {
    return this.usage.record(input);
  }

  reconcileUsage(input: ReconcileUsageInput): Promise<ReconciliationResult> {
    return this.usage.reconcile(input);
  }

  allocateCharge(input: AllocateChargeInput): Promise<AllocationResult> {
    return this.allocations.allocate(input);
  }

  createBudget(policy: BudgetPolicy): Promise<BudgetSnapshot> {
    return this.budgets.create(policy);
  }

  reserveBudget(input: BudgetReservationInput): Promise<ReservationResult> {
    return this.budgets.reserve(input);
  }

  settleReservation(reservationId: string, actualPaise: string): Promise<ReservationResult> {
    return this.budgets.settle(reservationId, actualPaise);
  }

  releaseReservation(reservationId: string): Promise<ReservationResult> {
    return this.budgets.release(reservationId);
  }

  applyLateAdjustment(input: {
    budgetId: string;
    idempotencyKey: string;
    deltaPaise: string;
    sourceRef: string;
  }): Promise<BudgetSnapshot> {
    return this.budgets.adjust(input);
  }

  getSessionCost(workspaceId: string, sessionId: string): Promise<CostSummary> {
    return this.usage.summarizeSession(workspaceId, sessionId);
  }

  getBudget(id: string): Promise<BudgetSnapshot | undefined> {
    return this.budgets.get(id);
  }

  listBudgets(
    workspaceId: string,
    limit?: number,
    cursor?: string,
  ): Promise<LedgerPage<BudgetSnapshot>> {
    return this.budgets.list(workspaceId, limit, cursor);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
