import { randomBytes } from 'node:crypto';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * The Compose `.env` that scripts/bootstrap-compose.sh writes, with the go-live gates of
 * docs/runbooks/first-real-call.md applied: live dial, inbound and transport certification on,
 * local HTTP off, and TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN unset so no `env` Twilio binding exists.
 */
export function goLiveComposeVariables(databaseUrl: string): Record<string, string> {
  return {
    POSTGRES_PASSWORD: hex(24),
    DATABASE_URL: databaseUrl,
    OVO_ORGANIZATION_ID: 'ovo',
    OVO_ADMIN_ID: 'first-admin',
    OVO_ADMIN_LABEL: 'First-administrator',
    OVO_ALLOW_LOCAL_HTTP: 'false',
    OVO_SESSION_SECRET: hex(32),
    OVO_SEED_ADMIN_EMAIL: 'admin@ovo.local',
    OVO_SEED_ADMIN_PASSWORD: hex(24),
    OVO_SEED_ADMIN_LABEL: 'Administrator',
    OVO_RESTORE_ADMIN_RECOVERY: 'false',
    OVO_MEDIA_PUBLIC_BASE_URL: 'https://voice.invalid',
    OVO_MEDIA_WORKER_TOKEN: hex(32),
    OVO_SECRETS_MASTER_KEY: hex(32),
    OVO_SECRETS_BACKEND: 'encrypted-store',
    OVO_PLUGIN_MODULES: '[]',
    OVO_RECORDING_RETENTION_DAYS: '30',
    OVO_INBOUND_ENABLED: 'true',
    OVO_INBOUND_ROUTE_SECRET: hex(32),
    OVO_LIVE_DIAL_ENABLED: 'true',
    OVO_TRANSPORT_CERTIFIED: 'true',
    OVO_PROVIDER_EVALUATIONS_ENABLED: 'false',
    OVO_PERMITTED_FROM_NUMBERS: '',
    AWS_REGION: 'ap-south-1',
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
    OVO_SQS_ENDPOINT: 'http://queue:9324',
    OVO_QUEUE_URL: 'http://queue:9324/000000000000/ovo-jobs',
  };
}
