import type { ProfileRows } from './types.ts';
import { durableRows } from './worker.ts';

/** Durable dispatcher adapters; optional wave-2 tasks join from the loaded catalog. */
export const rows: ProfileRows = (profile, env) => {
  const signal = profile === 'fargate' ? 'cloudwatch' : 'log';
  if (env.OVO_CAPACITY_SIGNAL && env.OVO_CAPACITY_SIGNAL !== signal)
    throw new Error(`Capacity signal ${env.OVO_CAPACITY_SIGNAL} conflicts with ${profile} profile`);
  return [
    ...durableRows(profile, env),
    {
      id: `@winsendotai/ovo-plugin-orchestration/${signal}-capacity-signal`,
      config: signal === 'cloudwatch'
        ? { environment: required(env, 'OVO_ENVIRONMENT'), region: required(env, 'AWS_REGION') }
        : {},
    },
    { id: '@winsendotai/ovo-plugin-orchestration/job-hint-sweeper', config: {} },
    {
      id: '@winsendotai/ovo-plugin-orchestration/dlq-reconciler',
      config: {
        queueUrl: required(env, 'OVO_DLQ_URL'),
        region: required(env, 'AWS_REGION'),
        endpoint: env.OVO_SQS_ENDPOINT,
      },
    },
  ];
};

function required(env: Parameters<ProfileRows>[1], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
