import type { PluginOption } from './types';
import type { CredentialMetadata } from '../../lib/api';
import { humaniseEnum } from '../../lib/status';

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

const PLUGIN_ID_ACRONYMS: ReadonlySet<string> = new Set([
  'vad',
  'stt',
  'tts',
  'llm',
  'asr',
  'sip',
  'dtmf',
  'amd',
]);

/** Last-resort label for a plugin whose catalog entry has no `ui.label` — several plugin kinds
 * (engine, VAD, turn detector in the manifests seen so far) ship with no `ui` metadata at all, so
 * every call site that previously fell back to the raw npm-style id directly (`plugin.ui?.label ??
 * plugin.id`) was showing e.g. `@winsendotai/ovo-vad-energy` as a card title or diagram node
 * (brief: never show a raw package id as a title). Strips the npm scope and the common
 * `ovo-`/`ovo-plugin-` prefix, then humanises the rest the same way every other enum/key is.
 */
export function humanisePluginId(id: string): string {
  const bare = id.split('/').pop() ?? id;
  const stripped = bare.replace(/^ovo-plugin-/, '').replace(/^ovo-/, '');
  const words = humaniseEnum(stripped || bare);
  return words
    .split(' ')
    .map((word) => (PLUGIN_ID_ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
    .join(' ');
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
