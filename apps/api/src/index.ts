import { seedAdminFromEnv } from './user-plugin.ts';
import { buildManagementApi, bootstrapIdentitiesFromEnv, sessionSecretFromEnv } from './server.ts';

import { loadInstalledSessionExtensions } from '@winsendotai/ovo-session-host';
import { productionRecordingsFromEnv } from '@winsendotai/ovo-plugin-recordings';
import { loadDistribution } from '@winsendotai/ovo-distribution';

const extensions = await loadInstalledSessionExtensions(process.env.OVO_PLUGIN_MODULES);
const distribution = await loadDistribution({
  role: 'api',
  profile: process.env.OVO_DEPLOYMENT_PROFILE === 'fargate' ? 'fargate' : 'compose',
  env: process.env,
});
const identities = bootstrapIdentitiesFromEnv();
const identity = identities[0]!;
const production = process.env.NODE_ENV === 'production';
const allowLocalHttp = process.env.OVO_ALLOW_LOCAL_HTTP === 'true';
const storageAdapter = production
  ? 'postgres'
  : process.env.OVO_STORAGE_ADAPTER === 'postgres'
    ? 'postgres'
    : 'sqlite';
const controlDatabaseUrl = process.env.OVO_CONTROL_DATABASE_URL ?? process.env.DATABASE_URL;
if (storageAdapter === 'postgres' && !controlDatabaseUrl)
  throw new Error('DATABASE_URL or OVO_CONTROL_DATABASE_URL is required for PostgreSQL storage');
const configuredSecretBackend = process.env.OVO_SECRETS_BACKEND;
if (
  configuredSecretBackend &&
  !['local', 'encrypted-store', 'aws-secrets-manager'].includes(configuredSecretBackend)
)
  throw new Error('OVO_SECRETS_BACKEND must be local, encrypted-store, or aws-secrets-manager');
const secretBackend = (configuredSecretBackend ?? (production ? 'encrypted-store' : 'local')) as
  'local' | 'encrypted-store' | 'aws-secrets-manager';
const trustedProxy = process.env.OVO_TRUSTED_PROXY_CIDRS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const { app, composition } = await buildManagementApi({
  identities,
  seedAdmin: seedAdminFromEnv(),
  pluginCatalog: extensions.plugins,
  loadedDistribution: distribution,
  defaultSession: {
    nativeHandlers: extensions.nativeHandlers,
    nativeHandlerPackages: extensions.nativeHandlerPackages,
  },
  sessionSecret: sessionSecretFromEnv(identity),
  storageAdapter,
  controlDatabaseUrl,
  productionRecordings: controlDatabaseUrl
    ? productionRecordingsFromEnv(controlDatabaseUrl)
    : undefined,
  storageMaxConnections: process.env.OVO_CONTROL_DB_POOL_MAX
    ? Number(process.env.OVO_CONTROL_DB_POOL_MAX)
    : undefined,
  databaseFile: process.env.OVO_DATABASE_FILE ?? './data/ovo.sqlite',
  secretBackend,
  secretsMasterKey: process.env.OVO_SECRETS_MASTER_KEY,
  awsRegion: process.env.AWS_REGION,
  requireTlsForSecrets: production && !allowLocalHttp,
  secureSessionCookies: production && !allowLocalHttp,
  trustedProxy: trustedProxy?.length ? trustedProxy : undefined,
  logger: true,
});

try {
  await app.listen({
    host: process.env.OVO_API_HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 4000),
  });
} catch (error) {
  await composition.dispose();
  throw error;
}

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 20_000);
  timeout.unref();
  void composition.dispose().then(
    () => {
      clearTimeout(timeout);
    },
    () => {
      console.error('Management API shutdown failed');
      process.exitCode = 1;
    },
  );
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
