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
export interface ReconciliationResult {
  usageId: string;
  correctionId: string;
  deltaPaise: string;
  effectiveAmountPaise: string;
  state: 'reconciled';
}
