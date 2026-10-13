import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { createSipRequestVerifier } from '@winsendotai/ovo-sip-carrier-kit';

const MIN_KEY_BYTES = 32;
const BASE64 = /^(?:[A-Za-z0-9+/]+={0,2}|[A-Za-z0-9_-]+)$/;

const manifest = {
  id: 'ovo.gateway.sip-trunk-verifier',
  version: '1.0.0',
  contractVersion: 2,
  scope: 'process',
  kind: 'infra',
  provides: [Cap.sipTrunkVerifier],
  requires: [],
  configSchema: { type: 'object', additionalProperties: false },
  secretFields: [],
} as const;

/** An ovo-sip/1 HMAC key: base64 (or base64url) of at least 32 bytes, nothing else. */
export function sipGatewayKey(name: string, value: string): Uint8Array {
  const trimmed = value.trim();
  const key = BASE64.test(trimmed) ? Buffer.from(trimmed, 'base64') : Buffer.alloc(0);
  if (key.byteLength < MIN_KEY_BYTES)
    throw new Error(`${name} must be base64 of at least ${MIN_KEY_BYTES} bytes`);
  return new Uint8Array(key);
}

/**
 * Wave 11: the gateway's `Cap.sipTrunkVerifier`, which the SIP carrier routes and media upgrades
 * use to check the sip-gateway's ovo-sip/1 signatures. Composed only with `OVO_SIP_ENABLED=true`;
 * without it those routes answer 503. Enabled without a usable secret is a startup error. The
 * previous secret is accepted alongside the current one while it is being rotated.
 */
export function sipTrunkVerifierPlugins(
  env: Readonly<Record<string, string | undefined>>,
): PluginDefinition[] {
  if (env.OVO_SIP_ENABLED !== 'true') return [];
  if (!env.OVO_SIP_GATEWAY_SECRET)
    throw new Error('OVO_SIP_GATEWAY_SECRET is required when OVO_SIP_ENABLED=true');
  const keys = [sipGatewayKey('OVO_SIP_GATEWAY_SECRET', env.OVO_SIP_GATEWAY_SECRET)];
  if (env.OVO_SIP_GATEWAY_SECRET_PREVIOUS)
    keys.push(
      sipGatewayKey('OVO_SIP_GATEWAY_SECRET_PREVIOUS', env.OVO_SIP_GATEWAY_SECRET_PREVIOUS),
    );
  return [
    definePlugin(manifest, (ctx) => {
      ctx.provide(Cap.sipTrunkVerifier, createSipRequestVerifier({ keys }));
    }),
  ];
}
