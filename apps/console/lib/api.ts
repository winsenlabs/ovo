import type { AgentConfig, CallEvent, CompatIssue, Release } from '@winsendotai/ovo-contracts';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'empty'; data: T }
  | { status: 'blocked'; reason: string }
  | { status: 'error'; message: string }
  | { status: 'stale'; data: T; reason: string }
  | { status: 'permissionDenied' };

export interface SessionIdentity {
  id?: string;
  email?: string;
  name?: string;
  label?: string;
  role: 'viewer' | 'editor' | 'admin';
  workspaceId?: string;
  workspace?: { id?: string; name?: string };
}
export interface AgentDraft {
  id: string;
  draftVersion: string;
  config: AgentConfig;
  updatedAt?: string;
}
export interface CredentialMetadata {
  id: string;
  label: string;
  provider: string;
  type: string;
  environment: string;
  fingerprint?: string;
  createdAt?: string;
  rotatedAt?: string;
  expiresAt?: string;
  status?: string;
  permittedAgentIds?: string[];
  bindings?: unknown[];
}
export interface ProviderBinding {
  id: string;
  label: string;
  provider: string;
  pluginId?: string | null;
  kind?: string | null;
  environment: string;
  credentialId: string;
  config?: Record<string, unknown>;
}
export interface AgentReadiness {
  releaseReady: boolean;
  requiredPluginIds: string[];
  blockers: string[];
  details?: CompatIssue[];
  liveReady: boolean;
  liveBlockers?: string[];
}
export interface McpConnection {
  id: string;
  label: string;
  endpoint: string;
  auth: 'none' | 'bearer';
  credentialId?: string;
  status?: string;
  lastTestedAt?: string;
}
export interface ToolApproval {
  id?: string;
  toolId?: string;
  connectionId: string;
  remoteName: string;
  schemaDigest: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effect?: 'read' | 'write';
}
export interface DiscoveredTool {
  id: string;
  remoteName: string;
  description?: string;
  schemaDigest: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effect?: 'read' | 'write';
}
export interface CallSummary {
  id: string;
  agentId?: string;
  releaseId?: string;
  kind?: 'simulation' | 'live' | 'real';
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  direction?: string;
  recordingState?: string;
  completedAt?: string | null;
}
export interface RecordingMetadata {
  id: string;
  callId: string;
  source: 'fixture' | 'carrier';
  createdAt: string;
  expiresAt: string;
  bytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  format: 'pcm' | 'mulaw';
  durationMs: number;
}
export interface UsageItem {
  id?: string;
  provider?: string;
  quantity: string;
  unit: string;
  amountMinor?: string;
  currency?: string;
  state?: 'estimated' | 'reconciled';
  estimated?: boolean;
}
export interface Evaluation {
  id: string;
  releaseId?: string;
  status?: string;
  createdAt?: string;
  fixtures?: unknown[];
  outcomes?: unknown[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function decode(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(
      response.status,
      'invalid_response',
      'The API returned an unreadable response.',
    );
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; etag?: string }> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (response.status === 401 && typeof window !== 'undefined')
    window.dispatchEvent(new Event('ovo:session-ended'));
  const payload = (await decode(response)) as
    { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | T;
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? `Request failed (${response.status}).`,
      error?.details,
    );
  }
  return { data: payload as T, etag: response.headers.get('etag') ?? undefined };
}

export function items<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items))
    return (value as { items: T[] }).items;
  return [];
}

export function normalizeDraft(value: unknown, etag?: string): AgentDraft {
  const object = value as Record<string, unknown>;
  const nested =
    object.draft && typeof object.draft === 'object'
      ? (object.draft as Record<string, unknown>)
      : object;
  const version = String(nested.draftVersion ?? nested.version ?? etag?.replaceAll('"', '') ?? '1');
  return {
    id: String(nested.id ?? nested.agentId),
    draftVersion: version,
    config: nested.config as AgentConfig,
    updatedAt: nested.updatedAt as string | undefined,
  };
}

export const emptyAgentConfig = (): AgentConfig => ({
  name: 'Untitled agent',
  mode: 'announcement',
  language: 'en-IN',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  message: '',
  variables: { type: 'object', properties: {}, additionalProperties: false },
  faq: [],
  faqThreshold: 0.65,
  faqMargin: 0.15,
  clarification: 'Please clarify your question.',
  context: '',
  contextBudget: 12000,
  uncertainty: 'I do not have that information.',
  tools: [],
  allowedTools: [],
  processing: {
    initial: 'Please wait while I check that.',
    progressAfterMs: 5000,
    maxProgress: 1,
    failure: 'I could not complete that check.',
  },
  maxSteps: 5,
  providers: {},
  recording: false,
});

export function ifMatch(version: string): string {
  return `"${version.replaceAll('"', '')}"`;
}
export type { AgentConfig, CallEvent, Release };
