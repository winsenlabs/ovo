import {
  createMediaGatewayPlugin,
  createMediaRouteResolverPlugin,
  MEDIA_PLUGIN_IDS,
} from '@winsendotai/ovo-plugin-media';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { PostgresOperationsService } from '@winsendotai/ovo-plugin-operations';
import { compose } from '@winsendotai/ovo-runtime';
import { createTwilioInboundWebhookHandler } from './inbound-webhook.ts';
import { projectInboundTerminalStatus } from './inbound-status.ts';

async function main(): Promise<void> {
  const publicBaseUrl = required('OVO_MEDIA_PUBLIC_BASE_URL');
  const twilioAuthToken = required('TWILIO_AUTH_TOKEN');
  const workerToken = required('OVO_MEDIA_WORKER_TOKEN');
  const databaseUrl = required('DATABASE_URL');
  const store = new PostgresOrchestrationStore({ connectionString: databaseUrl });
  await store.migrate();
  const operations = new PostgresOperationsService({
    connectionString: databaseUrl,
    organizationId: required('OVO_ORGANIZATION_ID'),
    config: {
      liveEnabled: process.env.OVO_LIVE_DIAL_ENABLED === 'true',
      permittedFromNumbers: (process.env.OVO_PERMITTED_FROM_NUMBERS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    },
  });
  await operations.migrate();
  const resolver = {
    authenticateSessionRoute: store.authenticateSessionRoute.bind(store),
    resolveSessionRoute: store.resolveSessionRoute.bind(store),
    async applyCarrierCallback(input: Parameters<typeof store.applyCarrierCallback>[0]) {
      const result = await store.applyCarrierCallback(input);
      if (result.kind === 'unmatched' || result.kind === 'correlation_conflict') return result;
      const job = await store.get(result.route.jobId);
      if (
        (result.kind === 'applied' || result.kind === 'duplicate') &&
        job?.payload.kind === 'inbound_call'
      )
        await projectInboundTerminalStatus(operations, {
          carrierCallId: input.carrierCallId,
          status: input.status,
        });
      const attemptId = job?.payload.attemptId;
      if (typeof attemptId === 'string' && attemptId)
        await operations.campaigns.recordAttempt(
          attemptId,
          input.eventId,
          campaignAttemptStatus(input.status),
          input.occurredAt,
        );
      return result;
    },
  };
  const inbound =
    process.env.OVO_INBOUND_ENABLED === 'true'
      ? createInboundHandler(operations, publicBaseUrl, twilioAuthToken)
      : undefined;
  const catalog = [
    createMediaRouteResolverPlugin(resolver),
    createMediaGatewayPlugin({ twilioAuthToken, workerToken }, { httpHandler: inbound }),
  ];
  const composition = await compose(
    [
      { id: MEDIA_PLUGIN_IDS.routeResolver },
      {
        id: MEDIA_PLUGIN_IDS.gateway,
        config: {
          publicBaseUrl,
          host: process.env.OVO_MEDIA_HOST ?? '0.0.0.0',
          port: integer(process.env.OVO_MEDIA_PORT, 8080),
          maxMessageBytes: integer(process.env.OVO_MEDIA_MAX_MESSAGE_BYTES, 65_536),
          maxAudioFrameBytes: integer(process.env.OVO_MEDIA_MAX_AUDIO_FRAME_BYTES, 8_192),
          maxBufferedBytes: integer(process.env.OVO_MEDIA_MAX_BUFFERED_BYTES, 262_144),
          maxPendingFrames: integer(process.env.OVO_MEDIA_MAX_PENDING_FRAMES, 25),
          handshakeTimeoutMs: integer(process.env.OVO_MEDIA_HANDSHAKE_TIMEOUT_MS, 5_000),
          idleTimeoutMs: integer(process.env.OVO_MEDIA_IDLE_TIMEOUT_MS, 30_000),
          drainTimeoutMs: integer(process.env.OVO_MEDIA_DRAIN_TIMEOUT_MS, 30_000),
        },
      },
    ],
    catalog,
  );
  console.log(JSON.stringify({ service: 'media-gateway', ready: true }));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ service: 'media-gateway', draining: true, signal }));
    await composition.dispose();
    await operations.close();
    await store.close();
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

function createInboundHandler(
  operations: PostgresOperationsService,
  publicBaseUrl: string,
  twilioAuthToken: string,
) {
  const mediaStreamUrl = new URL('/twilio/media', publicBaseUrl);
  mediaStreamUrl.protocol = 'wss:';
  return createTwilioInboundWebhookHandler({
    operations,
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: twilioAuthToken,
    externalBaseUrl: publicBaseUrl,
    mediaStreamUrl: mediaStreamUrl.toString(),
    routeTokenSecret: required('OVO_INBOUND_ROUTE_SECRET'),
  });
}

function campaignAttemptStatus(
  status: Parameters<PostgresOrchestrationStore['applyCarrierCallback']>[0]['status'],
) {
  if (status === 'answered') return 'connected' as const;
  if (status === 'completed') return 'succeeded' as const;
  if (status === 'cancelled') return 'cancelled' as const;
  if (status === 'busy' || status === 'failed' || status === 'no_answer') return 'failed' as const;
  return 'dialing' as const;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function integer(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error('invalid positive integer environment value');
  return parsed;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
