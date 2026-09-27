import type { ProfileRows } from './types.ts';

/**
 * loadDistribution selects installed vendor rows here. The host supplies the process-local
 * storage, secret and network definitions after loading, so it calls gatewayInfrastructureRows.
 */
export const rows: ProfileRows = () => [];

export const gatewayInfrastructureRows: ProfileRows = (profile, env) => {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the media gateway');
  return [
    {
      id: '@winsendotai/ovo-plugin-storage',
      config: { adapter: 'postgres', databaseUrl },
    },
    {
      id: '@winsendotai/ovo-plugin-secrets',
      config: {
        backend:
          env.OVO_SECRETS_BACKEND ??
          (profile === 'fargate' ? 'aws-secrets-manager' : 'encrypted-store'),
        masterKey: env.OVO_SECRETS_MASTER_KEY,
        region: env.AWS_REGION,
      },
    },
    { id: 'ovo.gateway.node-net' },
  ];
};
