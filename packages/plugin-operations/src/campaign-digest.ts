import type { CampaignRow } from './campaign-model.ts';
import { inputDigest } from './identity.ts';
import type { CampaignConfig, CampaignContactInput } from './types.ts';

/**
 * The idempotency digest. The variables schema and the agent's side of the compliance policy follow
 * from the release id, and a campaign with no calling window or compliance block of its own digests
 * exactly as it did before they existed, so retries keep matching.
 */
export function digestConfig(config: CampaignConfig) {
  const { variablesSchema: _variablesSchema, callingWindow, compliance, ...rest } = config;
  const requested = Object.fromEntries(
    Object.entries(compliance ?? {}).filter(([key]) => CAMPAIGN_COMPLIANCE_KEYS.has(key)),
  );
  return {
    ...rest,
    ...(callingWindow ? { callingWindow } : {}),
    ...(Object.keys(requested).length ? { compliance: requested } : {}),
  };
}

const CAMPAIGN_COMPLIANCE_KEYS = new Set([
  'consentBasis',
  'consentScope',
  'caps',
  'scrubMaxAgeHours',
]);

export function matchesLegacyDigest(
  row: CampaignRow,
  config: CampaignConfig,
  contacts: readonly CampaignContactInput[],
): boolean {
  if (row.carrier_id !== null || row.max_concurrency !== 1 || (config.maxConcurrency ?? 1) !== 1)
    return false;
  if (
    config.carrierPluginId != null ||
    config.carrierId != null ||
    config.carrierBindingId != null ||
    config.bindingCps != null ||
    config.callingWindow ||
    Object.keys(digestConfig(config)).includes('compliance')
  )
    return false;
  const {
    maxConcurrency: _maxConcurrency,
    carrierPluginId: _carrierPluginId,
    carrierId: _carrierId,
    carrierBindingId: _carrierBindingId,
    bindingCps: _bindingCps,
    ...legacyConfig
  } = digestConfig(config);
  return row.input_digest === inputDigest({ config: legacyConfig, contacts });
}
