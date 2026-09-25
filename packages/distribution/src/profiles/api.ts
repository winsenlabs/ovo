import type { ProfileRows } from './types.ts';
import { observabilityPlugin } from '@winsendotai/ovo-plugin-observability';
import { recordingRows } from './recordings.ts';

export const rows: ProfileRows = (profile, env) => [
  {
    id: '@winsendotai/ovo-plugin-storage',
    config: env.DATABASE_URL
      ? { adapter: 'postgres', databaseUrl: env.DATABASE_URL }
      : { adapter: 'sqlite', filename: env.OVO_SQLITE_FILE ?? './data/ovo.sqlite' },
  },
  {
    id: '@winsendotai/ovo-plugin-secrets',
    config: {
      backend:
        env.OVO_SECRETS_BACKEND ??
        (profile === 'fargate'
          ? 'aws-secrets-manager'
          : env.DATABASE_URL
            ? 'encrypted-store'
            : 'local'),
      ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
      ...(env.OVO_SECRETS_MASTER_KEY ? { masterKey: env.OVO_SECRETS_MASTER_KEY } : {}),
    },
  },
  { id: observabilityPlugin.manifest.id },
  ...recordingRows(profile, env),
];
