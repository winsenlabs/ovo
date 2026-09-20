import { createHash } from 'node:crypto';
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
  if (!env.OVO_ADMIN_TOKEN) throw new Error('OVO_ADMIN_TOKEN is required');
  const workspaceId = env.OVO_ADMIN_WORKSPACE_ID ?? 'local';
  return {
    id: env.OVO_ADMIN_ID ?? 'local-admin',
    label: env.OVO_ADMIN_LABEL ?? 'Local administrator',
    token: env.OVO_ADMIN_TOKEN,
    defaultWorkspaceId: workspaceId,
    workspaces: { [workspaceId]: 'admin' },
  };
}

export function sessionSecretFromEnv(
  identity: BootstrapIdentity,
  env: NodeJS.ProcessEnv = process.env,
) {
  return (
    env.OVO_SESSION_SECRET ??
    createHash('sha256').update(`ovo-session:${identity.token}`).digest('hex')
  );
}
