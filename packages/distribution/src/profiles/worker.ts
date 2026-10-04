import type { ProfileRows } from './types.ts';
import { rows as apiRows } from './api.ts';

function required(env: Parameters<ProfileRows>[1], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const durableRows: ProfileRows = (_profile, env) => [
  {
    id: '@winsendotai/ovo-plugin-orchestration/postgres',
    config: { connectionString: required(env, 'DATABASE_URL') },
  },
  {
    id: '@winsendotai/ovo-plugin-orchestration/sqs',
    config: {
      queueUrl: required(env, 'OVO_QUEUE_URL'),
      region: required(env, 'AWS_REGION'),
      endpoint: env.OVO_SQS_ENDPOINT,
    },
  },
];

export const rows: ProfileRows = (profile, env) => [
  ...apiRows(profile, { ...env, DATABASE_URL: required(env, 'DATABASE_URL') }),
  ...durableRows(profile, env),
];
