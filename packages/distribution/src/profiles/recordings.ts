import { recordingsPlugin } from '@winsendotai/ovo-plugin-recordings';
import type { PluginRow } from '@winsendotai/ovo-runtime';
import type { DeploymentProfile, Environment } from './types.ts';

/** The v1 archive is used for local fixtures or an explicitly configured S3 bucket. */
export function recordingRows(profile: DeploymentProfile, env: Environment): PluginRow[] {
  const bucket = env.OVO_RECORDINGS_BUCKET;
  if (bucket)
    return [
      {
        id: recordingsPlugin.manifest.id,
        config: { backend: 's3', bucket, ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}) },
      },
    ];
  // DB-backed production uses its separate recordings runtime rather than this fixture archive.
  if (env.NODE_ENV === 'production' || profile === 'fargate') return [];
  return [
    {
      id: recordingsPlugin.manifest.id,
      config: { backend: 'local', directory: env.OVO_RECORDINGS_DIRECTORY ?? './data/recordings' },
    },
  ];
}
