import type { FastifyInstance } from 'fastify';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import type { AgentDraft, ReleaseRecord, Role } from '@winsendotai/ovo-plugin-storage';
import type { DefaultSessionOptions } from './session-factory.ts';
export interface BootstrapIdentity {
  id: string;
  label: string;
  token: string;
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
  sessionSecret: string;
  pluginCatalog?: readonly PluginDefinition[];
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
  sessionTtlSeconds?: number;
  logger?: boolean;
  trustedProxy?: string | string[];
}
export interface BuildApiOptions extends ManagementApiOptions {
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
