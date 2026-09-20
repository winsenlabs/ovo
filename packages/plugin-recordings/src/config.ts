import { z } from 'zod';
import { isAbsolute } from 'node:path';

const PostgreSqlUrl = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => {
    try {
      return ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'databaseUrl must be a PostgreSQL URL');

const OperatorEndpoint = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  }, 'endpoint must be an HTTP(S) origin without credentials, path, query, or fragment');

export const PRODUCTION_RECORDINGS_CONFIG_SCHEMA = z
  .object({
    databaseUrl: PostgreSqlUrl,
    backend: z.enum(['s3', 'filesystem']),
    bucket: z.string().min(3).max(255).optional(),
    endpoint: OperatorEndpoint.optional(),
    forcePathStyle: z.boolean().optional(),
    directory: z
      .string()
      .min(1)
      .max(4_096)
      .refine(isAbsolute, 'directory must be absolute')
      .optional(),
    durableMounted: z.boolean().optional(),
    sharedAcrossWorkers: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.backend === 's3') {
      if (!value.bucket)
        context.addIssue({ code: 'custom', path: ['bucket'], message: 'S3 bucket is required' });
      for (const key of ['directory', 'durableMounted', 'sharedAcrossWorkers'] as const)
        if (value[key] !== undefined)
          context.addIssue({ code: 'custom', path: [key], message: `${key} is filesystem-only` });
    } else {
      if (!value.directory)
        context.addIssue({
          code: 'custom',
          path: ['directory'],
          message: 'Filesystem directory is required',
        });
      if (value.durableMounted !== true)
        context.addIssue({
          code: 'custom',
          path: ['durableMounted'],
          message: 'Production filesystem must be explicitly durable',
        });
      if (value.sharedAcrossWorkers !== true)
        context.addIssue({
          code: 'custom',
          path: ['sharedAcrossWorkers'],
          message: 'Production filesystem must be shared across workers',
        });
      for (const key of ['bucket', 'endpoint', 'forcePathStyle'] as const)
        if (value[key] !== undefined)
          context.addIssue({ code: 'custom', path: [key], message: `${key} is S3-only` });
    }
  });

export type ProductionRecordingsConfig = z.infer<typeof PRODUCTION_RECORDINGS_CONFIG_SCHEMA>;

export function productionRecordingsFromEnv(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): ProductionRecordingsConfig | undefined {
  if (!env.OVO_RECORDINGS_BACKEND) return undefined;
  return PRODUCTION_RECORDINGS_CONFIG_SCHEMA.parse({
    databaseUrl,
    backend: env.OVO_RECORDINGS_BACKEND,
    ...(env.OVO_RECORDINGS_BACKEND === 's3'
      ? {
          bucket: env.OVO_RECORDINGS_BUCKET,
          endpoint: env.OVO_RECORDINGS_ENDPOINT,
          forcePathStyle: env.OVO_RECORDINGS_FORCE_PATH_STYLE === 'true',
        }
      : {
          directory: env.OVO_RECORDINGS_DIRECTORY,
          durableMounted: env.OVO_RECORDINGS_DURABLE_MOUNTED === 'true',
          sharedAcrossWorkers: env.OVO_RECORDINGS_SHARED_ACROSS_WORKERS === 'true',
        }),
  });
}
