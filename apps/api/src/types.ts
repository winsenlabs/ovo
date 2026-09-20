import type { FastifyInstance } from 'fastify';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import type { AgentDraft, Role } from '@winsendotai/ovo-plugin-storage';
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
  createReleasePlugins?: (input: {
    agent: AgentDraft;
    sessionId: string;
  }) => readonly PluginDefinition[];
  requireTlsForSecrets?: boolean;
  sessionTtlSeconds?: number;
  logger?: boolean;
}
export interface BuildApiOptions extends ManagementApiOptions {
  databaseFile: string;
  recordingDirectory?: string;
  secretBackend?: 'local' | 'aws-secrets-manager';
  secretsMasterKey?: string;
  awsRegion?: string;
}
