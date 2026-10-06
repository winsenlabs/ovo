import {
  isPlaceholderCarrierBinding,
  isPlaceholderCredential,
} from '@winsendotai/ovo-session-host/carrier-bindings';
import type { Environment } from './profiles/types.ts';

export interface EnvCarrierBindings {
  env: Environment;
  /** Carrier ids that resolve as the reserved `env` binding. */
  active: string[];
  /** Carrier ids dropped because their account or token is a placeholder. */
  ignored: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Normalizes env carrier bindings for every consumer: an explicit `OVO_CARRIER_ENV_BINDINGS` loses
 * placeholder entries (a junk binding only earns silent carrier 403s), and a legacy Twilio pair is
 * translated only when both values are real. Malformed JSON is kept for the resolver to reject.
 */
export function envCarrierBindings(env: Environment): EnvCarrierBindings {
  const explicit = env.OVO_CARRIER_ENV_BINDINGS;
  if (explicit !== undefined) {
    if (!explicit.trim())
      return { env: { ...env, OVO_CARRIER_ENV_BINDINGS: '{}' }, active: [], ignored: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(explicit);
    } catch {
      return { env: { ...env }, active: [], ignored: [] };
    }
    if (!isRecord(parsed)) return { env: { ...env }, active: [], ignored: [] };
    const ignored = Object.keys(parsed).filter((id) => {
      const entry = parsed[id];
      return isRecord(entry) && isPlaceholderCarrierBinding(entry);
    });
    const active = Object.keys(parsed).filter((id) => !ignored.includes(id));
    return {
      env: ignored.length
        ? {
            ...env,
            OVO_CARRIER_ENV_BINDINGS: JSON.stringify(
              Object.fromEntries(active.map((id) => [id, parsed[id]])),
            ),
          }
        : { ...env },
      active,
      ignored,
    };
  }
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid && !authToken) return { env: { ...env }, active: [], ignored: [] };
  if (isPlaceholderCredential(accountSid) || isPlaceholderCredential(authToken))
    return { env: { ...env }, active: [], ignored: ['twilio'] };
  return {
    env: {
      ...env,
      OVO_CARRIER_ENV_BINDINGS: JSON.stringify({ twilio: { accountSid, authToken } }),
    },
    active: ['twilio'],
    ignored: [],
  };
}

/** Preserve explicit bindings; only translate a configured legacy Twilio pair. */
export function legacyEnvBindings(env: Environment): Environment {
  return envCarrierBindings(env).env;
}
