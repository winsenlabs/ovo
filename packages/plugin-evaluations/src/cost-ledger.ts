import type { InferenceNormalizedUsage } from '@winsendotai/ovo-contracts';

/** Only the ledger operations needed by evaluation admission and metering. */
export interface EvaluationCostLedger {
  getBudget(id: string): Promise<{ workspaceId: string } | undefined>;
  getPriceCard(
    id: string,
    version: string,
  ): Promise<{ provider: string; unit: string; currency: string } | undefined>;
  getFxVersion(
    id: string,
    version: string,
  ): Promise<{ baseCurrency: string; quoteCurrency: string } | undefined>;
  reserveBudget(input: {
    budgetId: string;
    reservationId: string;
    amountPaise: string;
    sourceRef: string;
  }): Promise<{ admitted: boolean }>;
  getSessionCost(workspaceId: string, sessionId: string): Promise<{ totalPaise: string }>;
  settleReservation(reservationId: string, actualPaise: string): Promise<unknown>;
  recordUsage(
    input: Omit<InferenceNormalizedUsage, 'meterKey'> & {
      idempotencyKey: string;
      workspaceId: string;
      sessionId: string;
      attemptId: string;
      priceCard: { id: string; version: string };
      fx?: { id: string; version: string };
    },
  ): Promise<unknown>;
}
