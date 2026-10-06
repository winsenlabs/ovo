import { createHash, randomBytes } from 'node:crypto';
import type { BootstrapIdentity } from './types.ts';
import { z } from 'zod';

/** One installation organization, with separately revocable operator credentials. */
export function bootstrapIdentitiesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapIdentity[] {
  const admin = bootstrapIdentityFromEnv(env);
  if (env.NODE_ENV === 'production' && admin.token.length < 32)
    throw new Error('Production administrator token requires at least 32 characters');
  let metadata: unknown;
  try {
    metadata = JSON.parse(env.OVO_OPERATORS_JSON ?? '[]');
  } catch {
    throw new Error('OVO_OPERATORS_JSON must contain valid operator metadata');
  }
  const operators = z
    .array(
      z
        .object({
          id: z.string().min(1).max(100),
          label: z.string().min(1).max(120),
          role: z.enum(['viewer', 'editor', 'admin']),
          tokenEnv: z.string().regex(/^OVO_OPERATOR_[A-Z0-9_]+_TOKEN$/),
        })
        .strict(),
    )
    .max(100)
    .parse(metadata);
  const identities = [
    admin,
    ...operators.map((operator) => {
      const token = env[operator.tokenEnv];
      if (!token || token.length < 32)
        throw new Error(`Operator token requires at least 32 characters: ${operator.id}`);
      return {
        id: operator.id,
        label: operator.label,
        token,
        defaultWorkspaceId: admin.defaultWorkspaceId,
        workspaces: { [admin.defaultWorkspaceId]: operator.role },
      };
    }),
  ];
  if (new Set(identities.map((identity) => identity.id)).size !== identities.length)
    throw new Error('Operator identifiers must be unique');
  if (
    new Set(identities.map((identity) => createHash('sha256').update(identity.token).digest('hex')))
      .size !== identities.length
  )
    throw new Error('Operator credentials must be distinct');
  return identities;
}

export function bootstrapIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): BootstrapIdentity {
  if (!env.OVO_ADMIN_TOKEN && !env.OVO_SEED_ADMIN_EMAIL)
    throw new Error(
      'Seed administrator email/password or a legacy administrator token is required',
    );
  const workspaceId = env.OVO_ORGANIZATION_ID ?? env.OVO_ADMIN_WORKSPACE_ID ?? 'local';
  return {
    id: env.OVO_ADMIN_ID ?? 'local-admin',
    label: env.OVO_ADMIN_LABEL ?? 'Local administrator',
    token: env.OVO_ADMIN_TOKEN ?? randomBytes(32).toString('hex'),
    authenticationDisabled: !env.OVO_ADMIN_TOKEN,
    defaultWorkspaceId: workspaceId,
    workspaces: { [workspaceId]: 'admin' },
  };
}

let localSessionSecret: string | undefined;

export function sessionSecretFromEnv(
  _identity: BootstrapIdentity,
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured = env.OVO_SESSION_SECRET;
  if (
    env.NODE_ENV === 'production' &&
    (!configured?.trim() || Buffer.byteLength(configured.trim(), 'utf8') < 32)
  )
    throw new Error('Production OVO_SESSION_SECRET requires at least 32 bytes (UTF-8)');
  if (configured) return configured;
  if (!localSessionSecret) {
    localSessionSecret = randomBytes(32).toString('hex');
    console.warn(
      'OVO_SESSION_SECRET is unset; development sessions expire when this process restarts.',
    );
  }
  return localSessionSecret;
}

/** Session lifetimes (OPS-15), in seconds: the default, and the shortest and longest allowed. */
export const SESSION_TTL = { default: 28_800, min: 300, max: 86_400 } as const;
/** A session signed in only to change its password lasts this long. */
export const PASSWORD_CHANGE_SESSION_SECONDS = 900;

/**
 * `OVO_SESSION_TTL_SECONDS`: how long a console session lasts after sign-in, 5 minutes to 24 hours
 * (default 8 hours). Sessions never slide: a longer working day signs in again.
 */
export function sessionTtlSecondsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OVO_SESSION_TTL_SECONDS?.trim();
  if (!raw) return SESSION_TTL.default;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < SESSION_TTL.min || value > SESSION_TTL.max)
    throw new Error(
      `OVO_SESSION_TTL_SECONDS must be an integer from ${SESSION_TTL.min} to ${SESSION_TTL.max}`,
    );
  return value;
}
