import type { CredentialMetadata, ProviderBinding } from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { humaniseEnum } from '../../lib/status';

/** Vendor display name sourced from the installed plugin manifest, never a hardcoded map
 * (brief §2 provider-names gate — `plugin.ui.vendor`, falling back to the raw provider id only
 * when no installed plugin advertises it). */
export function vendorLabel(provider: string, plugins: readonly PluginOption[]): string {
  return plugins.find((plugin) => plugin.provider === provider)?.ui?.vendor ?? provider;
}

/** Credential label for a stored `credentialId` reference, falling back to the raw id when the
 * credential list hasn't loaded or no longer has it. */
export function credentialLabel(
  credentialId: string | undefined,
  credentials: readonly CredentialMetadata[],
): string {
  if (!credentialId) return 'No credential';
  return credentials.find((credential) => credential.id === credentialId)?.label ?? credentialId;
}

const DAY_MS = 86_400_000;

/** Credential/plugin "kind" and credential "type" values are short domain abbreviations
 * (`stt`, `tts`, `llm`...) or auth-method names (`api_key`, `bearer`...) that the shared generic
 * `humaniseEnum` can't expand on its own — it would read back `stt` as "Stt". These map the known
 * values, falling back to the generic humaniser for anything else. */
const KIND_LABELS: Record<string, string> = {
  stt: 'Speech to text',
  tts: 'Text to speech',
  llm: 'LLM',
  carrier: 'Carrier',
  decision: 'Decision',
  tool: 'Tool API',
};
const CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  ...KIND_LABELS,
  api_key: 'API key',
  bearer: 'Bearer token',
  basic: 'Basic auth',
};

export function humaniseKind(kind?: string | null): string {
  if (!kind) return 'Unknown';
  return KIND_LABELS[kind.toLowerCase()] ?? humaniseEnum(kind);
}

export function humaniseCredentialType(type?: string | null): string {
  if (!type) return 'Unknown';
  return CREDENTIAL_TYPE_LABELS[type.toLowerCase()] ?? humaniseEnum(type);
}

/** Days until `expiresAt`; negative once it is in the past. `null` when there is no expiry. */
export function daysUntilExpiry(
  expiresAt?: string | null,
  now: number = Date.now(),
): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.ceil((at - now) / DAY_MS);
}

/** Badge tone for an expiry: past -> danger, within 14 days -> warn, otherwise no special tone. */
export function expiryTone(
  expiresAt?: string | null,
  now: number = Date.now(),
): 'danger' | 'warn' | undefined {
  const days = daysUntilExpiry(expiresAt, now);
  if (days == null) return undefined;
  if (days < 0) return 'danger';
  if (days <= 14) return 'warn';
  return undefined;
}

export function isExpiringSoon(expiresAt?: string | null, now: number = Date.now()): boolean {
  const days = daysUntilExpiry(expiresAt, now);
  return days != null && days >= 0 && days <= 14;
}

/** Counts credentials by their reported `status`, defaulting an unset status to "unknown". */
export function countByStatus(credentials: readonly CredentialMetadata[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const credential of credentials) {
    const key = credential.status ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Bindings grouped by `environment`, in first-seen order, for the KPI strip. */
export function countByEnvironment(
  bindings: readonly ProviderBinding[],
): { environment: string; count: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const binding of bindings) {
    const key = binding.environment || 'unknown';
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order.map((environment) => ({ environment, count: counts.get(environment) ?? 0 }));
}

/** How many bindings reference a credential, for the Credentials table's "Used by" column. */
export function usedByCount(credentialId: string, bindings: readonly ProviderBinding[]): number {
  return bindings.filter((binding) => binding.credentialId === credentialId).length;
}

/** Bindings that would be orphaned (readiness-breaking) if this credential were retired. */
export function bindingsUsing(
  credentialId: string,
  bindings: readonly ProviderBinding[],
): ProviderBinding[] {
  return bindings.filter((binding) => binding.credentialId === credentialId);
}
