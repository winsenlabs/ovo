import type { FastifyInstance } from 'fastify';
import type { PluginDefinition, UnavailablePlugin } from '@winsendotai/ovo-runtime';
import type { SessionDefaults } from '@winsendotai/ovo-session-host';
import type { LoadedDistribution } from '@winsendotai/ovo-distribution';
import type { AgentDraft, ReleaseRecord, Role } from '@winsendotai/ovo-plugin-storage';
import type { DefaultSessionOptions } from './session-factory.ts';
export interface BootstrapIdentity {
  id: string;
  label: string;
  token: string;
  authenticationDisabled?: boolean;
  workspaces: Record<string, Role>;
  defaultWorkspaceId: string;
}
export interface Principal {
  identityId: string;
  label: string;
  workspaceId: string;
  role: Role;
}
export interface ManagementApiService {
  app: FastifyInstance;
}
export interface ManagementApiOptions {
  identities: BootstrapIdentity[];
  usersEnabled?: boolean;
  seedAdmin?: import('./user-plugin.ts').SeedAdminInput;
  sessionSecret: string;
  /** Test-only executor seam; production constructs its bounded child runtime. */
  testCallRuntime?: import('@winsendotai/ovo-fixture-calls').TestCallRuntime;
  pluginCatalog?: readonly PluginDefinition[];
  distributionDefaults?: SessionDefaults;
  unavailable?: readonly UnavailablePlugin[];
  carrierPublicBaseUrl?: string;
  inboundRouteSecret?: string;
  defaultSession?: DefaultSessionOptions;
  costLedgerEnabled?: boolean;
  telemetryEnabled?: boolean;
  evaluationsEnabled?: boolean;
  fixtureRecordingsEnabled?: boolean;
  productionRecordingsEnabled?: boolean;
  operationsEnabled?: boolean;
  infrastructureEnabled?: boolean;
  /** `OVO_ROUTING_ENABLED`: `/v1/routing/*` and binding numbers to routing releases (off). */
  routingEnabled?: boolean;
  /** `OVO_ROUTING_EXTERNAL_ENABLED`, read by the worker; the API reports it and warns at publish. */
  routingExternalEnabled?: boolean;
  /** `OVO_ROUTING_TRANSFER_ENABLED`, read by the worker; the API reports it and warns at publish. */
  routingTransferEnabled?: boolean;
  /** `OVO_ROUTING_SIMULATE_LIVE_ENABLED`: an admin may run the simulator's decision and LLM engines for real (off). */
  routingSimulateLiveEnabled?: boolean;
  /** `OVO_ROUTING_SIMULATE_RATE_PER_MINUTE`: simulations and eval runs per identity per minute (30). */
  routingSimulateRatePerMinute?: number;
  /** `OVO_HUMAN_QUEUE_ENABLED`: `/v1/human-queues|desk|human-queue/*` and the operator desk (off). */
  humanQueueEnabled?: boolean;
  /** `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED`: webhook queues may post and `test-webhook` may run (off). */
  humanQueueWebhookEnabled?: boolean;
  /** A room server plugin is composed in this API (set by `buildManagementApi`, not by env). */
  roomEnabled?: boolean;
  /** `OVO_ROOM_TOKEN_TTL_SECONDS`: how long an operator's room grant lives (120). */
  roomTokenTtlSeconds?: number;
  /** `OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS`, reported to the desk (30). */
  humanQueuePresenceTtlSeconds?: number;
  /** `OVO_HUMAN_QUEUE_CALLBACK_BASE_URL`: the origin in a test request's links. */
  humanQueueCallbackBaseUrl?: string;
  /** Test seam: the signed webhook client and signature check (production: the session host's). */
  humanQueueEgress?: import('./human-queue-ports.ts').HumanQueueEgress;
  createReleasePlugins?: (input: {
    agent: AgentDraft;
    sessionId: string;
    release?: ReleaseRecord;
    fixtureBindings?: boolean;
  }) => readonly PluginDefinition[] | Promise<readonly PluginDefinition[]>;
  requireTlsForSecrets?: boolean;
  secureSessionCookies?: boolean;
  sessionTtlSeconds?: number;
  logger?: boolean;
  trustedProxy?: string | string[];
}
export interface BuildApiOptions extends ManagementApiOptions {
  loadedDistribution?: LoadedDistribution;
  databaseFile?: string;
  storageAdapter?: 'sqlite' | 'postgres';
  controlDatabaseUrl?: string;
  storageMaxConnections?: number;
  recordingDirectory?: string;
  productionRecordings?: import('./recording-runtime.ts').ApiProductionRecordingsOptions;
  operations?: Omit<
    import('./operations-runtime.ts').CreateOperationsRuntimeOptions,
    'databaseUrl' | 'organizationId'
  >;
  secretBackend?: 'local' | 'encrypted-store' | 'aws-secrets-manager';
  secretsMasterKey?: string;
  awsRegion?: string;
}
