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
