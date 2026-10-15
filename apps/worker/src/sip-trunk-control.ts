import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { createSipTrunkHttpClient } from '@winsendotai/ovo-sip-carrier-kit';

/** The compose bridge gateway, where the host-network sip-gateway serves its control API. */
export const DEFAULT_SIP_CONTROL_URL = 'http://172.29.240.1:5090';
const MIN_TOKEN_LENGTH = 16;

const manifest = {
  id: 'ovo.worker.sip-trunk-control',
  version: '1.0.0',
  contractVersion: 2,
  scope: 'process',
  kind: 'host',
  provides: [Cap.sipTrunkControl],
  requires: [],
  secretFields: [],
  configSchema: { type: 'object', additionalProperties: false },
} as const;

/**
 * Wave 11: the worker's `Cap.sipTrunkControl`, the only path from the SIP carrier plugins to
 * the sip-gateway's control API (`ctx.net` is https-only and refuses private addresses). Composed
 * only with `OVO_SIP_ENABLED=true`; without it those carriers refuse every dial. Enabled without a
 * token, or with a URL that is not plain http(s), is a startup error rather than a 401 on the first
 * call.
 */
export function sipTrunkControlPlugins(
  env: Readonly<Record<string, string | undefined>>,
): PluginDefinition[] {
  if (env.OVO_SIP_ENABLED !== 'true') return [];
  const token = env.OVO_SIP_CONTROL_TOKEN;
  if (!token) throw new Error('OVO_SIP_CONTROL_TOKEN is required when OVO_SIP_ENABLED=true');
  // The sip-gateway refuses a shorter token at boot; failing here names the worker's side too.
  if (token.length < MIN_TOKEN_LENGTH)
    throw new Error(`OVO_SIP_CONTROL_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  const baseUrl = env.OVO_SIP_CONTROL_URL || DEFAULT_SIP_CONTROL_URL;
  const url = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('OVO_SIP_CONTROL_URL must be an http(s) origin without credentials or path');
  const client = createSipTrunkHttpClient({ baseUrl: url.origin, token });
  return [
    definePlugin(manifest, (ctx) => {
      ctx.provide(Cap.sipTrunkControl, client);
    }),
  ];
}
