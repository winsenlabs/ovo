import type { Environment } from './profiles/types.ts';

const PLACEHOLDERS = new Set(['not-configured', 'disabled-local-account']);

/** Preserve explicit bindings; only translate a configured legacy Twilio pair. */
export function legacyEnvBindings(env: Environment): Environment {
  if (env.OVO_CARRIER_ENV_BINDINGS !== undefined) return { ...env };
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken || PLACEHOLDERS.has(accountSid) || PLACEHOLDERS.has(authToken))
    return { ...env };
  return {
    ...env,
    OVO_CARRIER_ENV_BINDINGS: JSON.stringify({
      twilio: { accountSid, authToken },
    }),
  };
}
