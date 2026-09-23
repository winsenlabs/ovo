import type { AgentConfig } from '@winsendotai/ovo-contracts';

export type Role = 'viewer' | 'editor' | 'admin';
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface AgentDraft {
  id: string;
  workspaceId: string;
  config: AgentConfig;
  draftVersion: number;
  createdAt: string;
  updatedAt: string;
}
export interface ReleaseRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  draftVersion: number;
  config: AgentConfig;
  plugins: { id: string; version: string }[];
  /** Older in-memory release values may omit this; stores always hydrate an object. */
  selections?: Record<string, ReleaseSelection>;
  providerBindings: Record<string, ProviderBinding>;
  mcpTools: Record<string, ReleaseMcpToolSnapshot>;
  createdAt: string;
  createdBy: string;
}
export interface ReleaseSelection {
  pluginId: string;
  version: string;
  bindingId?: string;
  binding?: {
    provider: string;
    config: Record<string, unknown>;
    credentialId: string;
    fingerprint: string;
    updatedAt: string;
  };
  config: Record<string, unknown>;
}
export interface ReleaseMcpToolSnapshot {
  approval: McpToolApproval;
  connection: McpConnection;
  discoveredTool: McpDiscoveredTool;
}
export interface CredentialMetadata {
  id: string;
  workspaceId: string;
  label: string;
  provider: string;
  type: string;
  environment: string;
  backend: 'local' | 'encrypted-store' | 'aws-secrets-manager';
  currentVersion: number;
  status: 'active' | 'retired';
  permittedAgentIds: string[];
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  rotatedAt: string | null;
  retiredAt: string | null;
  fingerprint: string;
}
export interface SecretBlob {
  credentialId: string;
  version: number;
  backend: CredentialMetadata['backend'];
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  authTag: Uint8Array | null;
  backendRef: string | null;
}
export interface ProviderBinding {
  id: string;
  workspaceId: string;
  label: string;
  provider: string;
  /** Older in-memory fixtures may omit these; stores hydrate nulls. */
  kind?: string | null;
  pluginId?: string | null;
  environment: string;
  credentialId: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface McpConnection {
  id: string;
  workspaceId: string;
  label: string;
  endpoint: string;
  auth: 'none' | 'bearer';
  credentialId: string | null;
  status: 'unverified' | 'ready' | 'error';
  createdAt: string;
  updatedAt: string;
}
export interface McpToolApproval {
  workspaceId: string;
  agentId: string;
  toolId: string;
  connectionId: string;
  remoteName: string;
  schemaDigest: string;
  createdAt: string;
  updatedAt: string;
}
export interface McpDiscoveredTool {
  connectionId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaDigest: string;
  discoveredAt: string;
  removedAt?: string | null;
}
export interface CallRecord {
  id: string;
  workspaceId: string;
  releaseId: string;
  kind: 'live' | 'simulation' | 'test';
  status: string;
  createdAt: string;
  completedAt: string | null;
}
export interface StoredCallEvent {
  id: string;
  callId: string;
  sequence: number;
  at: string;
  type: string;
  epoch: number;
  payload: Record<string, unknown>;
}
export interface EvaluationRecord {
  id: string;
  workspaceId: string;
  releaseId: string;
  status: 'passed' | 'failed';
  fixtures: unknown[];
  createdAt: string;
  createdBy: string;
}
export interface UsageEntry {
  id: string;
  workspaceId: string;
  callId: string;
  provider: string;
  requestId: string;
  quantity: string;
  unit: string;
  priceCardId: string;
  priceCardVersion: string;
  amountMinor: string;
  currency: string;
  state: 'estimated' | 'reconciled';
  createdAt: string;
}
export interface AuditEntry {
  id: string;
  workspaceId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface CredentialReferences {
  providerBindings: { total: number; ids: string[] };
  mcpConnections: { total: number; ids: string[] };
}

export class DraftConflictError extends Error {
  constructor(public readonly current: AgentDraft) {
    super('The agent draft was updated by another editor.');
    this.name = 'DraftConflictError';
  }
}
export class ReferencedResourceError extends Error {
  constructor(
    message: string,
    public readonly references: unknown,
  ) {
    super(message);
    this.name = 'ReferencedResourceError';
  }
}
