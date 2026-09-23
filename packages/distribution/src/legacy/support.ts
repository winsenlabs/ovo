import type { Context, PluginContext } from '@winsendotai/ovo-runtime';
import type { ProviderUsage, StoredProviderBinding } from '@winsendotai/ovo-plugin-providers';
import { Cap, type UsageSink } from '@winsendotai/ovo-contracts';

export const PROVIDER_CONFIG_SCHEMA = {
  type: 'object',
  required: ['binding', 'credentialRef'],
  properties: {
    binding: { type: 'object' },
    credentialRef: {
      type: 'object',
      required: ['credentialId'],
      properties: { credentialId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    workspaceId: { type: 'string' },
    bindingId: { type: 'string' },
    updatedAt: { type: 'string' },
    instructions: { type: 'string' },
    maxOutputTokens: { type: 'integer' },
  },
  additionalProperties: false,
} as const;

export const PROVIDER_MANIFEST_COMMON = {
  version: '0.1.0',
  contractVersion: 2,
  scope: 'session',
  requires: [Cap.usage],
  optional: [],
  configSchema: PROVIDER_CONFIG_SCHEMA,
  bindingSchema: { type: 'object' },
  secretFields: [''],
} as const;

export function storedBinding(
  config: Record<string, unknown>,
  provider: string,
): StoredProviderBinding {
  const binding = config.binding;
  const ref = config.credentialRef;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding))
    throw new TypeError('Provider binding snapshot is required');
  if (
    !ref ||
    typeof ref !== 'object' ||
    typeof (ref as { credentialId?: unknown }).credentialId !== 'string' ||
    !(ref as { credentialId: string }).credentialId.trim()
  )
    throw new TypeError('Provider credential reference is required');
  return {
    id: String(config.bindingId ?? 'release-snapshot'),
    workspaceId: String(config.workspaceId ?? 'release'),
    provider,
    credentialId: (ref as { credentialId: string }).credentialId,
    config: binding as Record<string, unknown>,
    updatedAt: String(config.updatedAt ?? '1970-01-01T00:00:00.000Z'),
  };
}

/** The old factory receives only its two used Cordis methods; secrets stay in the guarded v2 context. */
export function factoryContext(
  ctx: PluginContext,
  provide: (key: string, value: unknown) => void,
): Context {
  return {
    get(key: string) {
      if (key === Cap.secrets) return { resolve: () => ctx.secret('') };
      return ctx.get(key);
    },
    provide,
  } as unknown as Context;
}

export function providerUsage(ctx: PluginContext, operation: 'stt' | 'tts') {
  const sink = ctx.get(Cap.usage) as UsageSink;
  let next = 0;
  return (usage: ProviderUsage): void => {
    if (usage.state === 'unavailable' || usage.quantity === undefined) return;
    if (usage.unit === 'total_tokens') return;
    sink({
      provider: usage.provider,
      operation,
      unit: usage.unit,
      quantity: usage.quantity,
      state: usage.state,
      requestId: usage.requestId ?? `${usage.provider}:legacy:${++next}`,
      elapsedMs: usage.elapsedMs,
    });
  };
}
