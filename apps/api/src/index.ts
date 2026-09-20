import { buildManagementApi, bootstrapIdentityFromEnv, sessionSecretFromEnv } from './server.ts';

const identity = bootstrapIdentityFromEnv();
if (process.env.NODE_ENV === 'production')
  throw new Error(
    'The bundled node:sqlite adapter is single-process development only. Configure the production PostgreSQL ControlStore adapter before starting OVO API in Fargate.',
  );
const { app } = await buildManagementApi({
  identities: [identity],
  sessionSecret: sessionSecretFromEnv(identity),
  databaseFile: process.env.OVO_DATABASE_FILE ?? './data/ovo.sqlite',
  secretBackend:
    process.env.OVO_SECRETS_BACKEND === 'aws-secrets-manager' ? 'aws-secrets-manager' : 'local',
  secretsMasterKey: process.env.OVO_SECRETS_MASTER_KEY,
  awsRegion: process.env.AWS_REGION,
  requireTlsForSecrets: process.env.NODE_ENV === 'production',
  logger: true,
});

await app.listen({
  host: process.env.OVO_API_HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 4000),
});
