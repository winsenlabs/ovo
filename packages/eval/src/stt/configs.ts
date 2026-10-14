// The STT bake-off's contestants: each provider configuration built from OVO's production plugin,
// with the streaming options confirmed in the provider's own docs.
import type { ConfigStatus, KeyName, SttConfig } from './config-types.ts';
import { KEYED_CONFIGS } from './configs-keyed.ts';
import { PENDING_CONFIGS } from './configs-pending.ts';

export type { ConfigStatus, KeyName, Price, SttConfig } from './config-types.ts';
export { TRAVEL_KEYTERMS } from './configs-keyed.ts';

export const STT_CONFIGS: readonly SttConfig[] = [...KEYED_CONFIGS, ...PENDING_CONFIGS];

export function configById(id: string): SttConfig {
  const config = STT_CONFIGS.find((candidate) => candidate.id === id);
  if (!config) throw new Error(`unknown STT config ${id}`);
  return config;
}

export function configStatus(
  config: SttConfig,
  keys: Partial<Record<KeyName, string>>,
): ConfigStatus {
  if (!config.create) return 'pending plugin';
  return keys[config.key] ? 'ready' : 'pending key';
}
