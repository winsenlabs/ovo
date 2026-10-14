import type { PluginOption } from './types';
import type { CredentialMetadata } from '../../lib/api';

export function fieldValue(value: Record<string, unknown>, key: string): string {
  return value[key] == null ? '' : String(value[key]);
}

export function storedCredentialId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('credentialRef' in value)) return undefined;
  const reference = value.credentialRef;
  return reference &&
    typeof reference === 'object' &&
    'credentialId' in reference &&
    typeof reference.credentialId === 'string'
    ? reference.credentialId
    : undefined;
}

export type FieldArgs = {
  plugin: PluginOption;
  value: Record<string, unknown>;
  patch: (key: string, next: unknown) => void;
  onSecret?: (pointer: string, secret: string) => void | Promise<void>;
  fingerprints: Record<string, string>;
  credentials?: readonly CredentialMetadata[];
  secretErrors: Record<string, string>;
  setSecretErrors: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  prefix: string;
  requiredKeys: ReadonlySet<string>;
};
