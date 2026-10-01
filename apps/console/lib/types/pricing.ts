export type { PriceCardVersion, FxVersion } from '@winsendotai/ovo-contracts';
export interface ReconciliationResult {
  usageId: string;
  correctionId: string;
  deltaPaise: string;
  effectiveAmountPaise: string;
  state: 'reconciled';
}
