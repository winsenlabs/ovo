import type { ToolDefinition } from './agent.ts';
import type { SpeechKindV2 } from './voice/evidence.ts';
import type { PlaybackEvidence } from './voice/media.ts';

export interface CallEvent {
  id: string;
  sessionId: string;
  sequence: number;
  at: string;
  type: string;
  epoch: number;
  payload: Record<string, unknown>;
}

export interface SpeechReceipt {
  id: string;
  text: string;
  epoch: number;
  state: 'completed' | 'interrupted';
  evidence: 'simulated' | 'estimated' | 'confirmed';
  /** Set when weaker carrier evidence was accepted as confirmed by acknowledgement (§2.5). */
  evidenceSource?: PlaybackEvidence;
}

export interface Speech {
  speak(
    text: string,
    options?: { epoch?: number; kind?: 'acknowledgment' | 'response' | 'progress' },
  ): Promise<SpeechReceipt>;
  interrupt(): Promise<void>;
}

export interface InferenceRequest {
  history?: { role: 'user' | 'assistant'; content: string }[];
  input: string;
  context: string;
  uncertainty: string;
  tools: ToolDefinition[];
  results: OperationRecord[];
  signal: AbortSignal;
}

export type InferenceReply =
  | { kind: 'text'; text: string; usage?: Record<string, number> }
  | { kind: 'tool'; toolId: string; input: unknown; usage?: Record<string, number> };

export type InferenceStreamEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool'; toolId: string; input: unknown }
  | { kind: 'finish'; usage?: Record<string, number> };

export interface Inference {
  readonly provider?: string;
  readonly model?: string;
  generate(request: InferenceRequest): Promise<InferenceReply>;
  stream?(request: InferenceRequest): AsyncIterable<InferenceStreamEvent>;
}

export interface OperationRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  toolId: string;
  input: unknown;
  state: 'intent' | 'running' | 'succeeded' | 'failed' | 'unknown';
  result?: unknown;
  error?: string;
  createdAt: string;
}

export interface OperationStore {
  createIntent(record: OperationRecord): Promise<boolean>;
  get(workspaceId: string, id: string): Promise<OperationRecord | undefined>;
  settle(record: OperationRecord): Promise<void>;
}

export interface ToolConnector {
  invoke(
    tool: ToolDefinition,
    input: unknown,
    options: { signal: AbortSignal; operationId: string; workspaceId: string },
  ): Promise<unknown>;
}

export interface ExecutionRequest {
  id: string;
  workspaceId: string;
  sessionId: string;
  toolId: string;
  input: unknown;
  confirmed: boolean;
}

export interface Execution {
  execute(request: ExecutionRequest, options?: { signal?: AbortSignal }): Promise<OperationRecord>;
}

/** Tool and confirmation lifecycle, for turn-detector mute rules (§2.6). Optional for engines. */
export type BehaviorEvent =
  | { type: 'tool.started' | 'tool.settled'; toolId: string; operationId: string }
  | { type: 'confirmation.pending'; toolId: string; operationId: string }
  | {
      type: 'confirmation.resolved';
      toolId: string;
      operationId: string;
      result: 'confirmed' | 'declined' | 'expired';
    };

export interface Behavior {
  respond(input: string, variables?: Record<string, unknown>): Promise<string>;
  respondStream?(input: string, variables?: Record<string, unknown>): AsyncIterable<string>;
  cancel?(): void;
  onPlayback?(receipt: SpeechReceipt): void | Promise<void>;
  beginTurn?(epoch: number): void;
  isComplete?(): boolean;
  /** 'confirmation' for the pending confirmation prompt. */
  speechKind?(text: string): SpeechKindV2 | undefined;
  subscribe?(fn: (event: BehaviorEvent) => void): () => void;
}

export interface EventSink {
  append(type: string, payload: Record<string, unknown>): Promise<void>;
}

export interface SecretResolver {
  resolve(workspaceId: string, credentialId: string): Promise<string>;
}

export interface ToolConnection {
  id: string;
  workspaceId: string;
  label: string;
  endpoint: string;
  auth: 'none' | 'bearer';
  credentialId?: string;
}

/** Moved from `plugin-tools/src/native.ts`, which re-exports it. */
export interface NativeToolContext {
  signal: AbortSignal;
  operationId: string;
  workspaceId: string;
}

export type NativeToolHandler = (input: unknown, context: NativeToolContext) => Promise<unknown>;
