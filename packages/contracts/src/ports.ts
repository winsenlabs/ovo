import type { ToolDefinition } from './agent.ts';
import type { SpeechKindV2 } from './voice/evidence.ts';
import type { PlaybackEvidence } from './voice/media.ts';
import type { SttConfigurationUpdate } from './speech/stt.ts';

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
  /**
   * How long the line played to the caller before it settled, in milliseconds: from when its audio
   * reached the carrier (or the line before it finished playing, if later) to its completion or
   * cut. 0 for a line that never played. Absent when the output does not report audio reaching
   * the carrier. A completed line's value is its length (plus the carrier's acknowledgement), so
   * comparing a cut line's value with it tells how much of the line the caller heard.
   */
  playedMs?: number;
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
  /** STT-4: the provider's endpointing for what the caller says next (e.g. per flow state). */
  | { type: 'stt.configure'; update: SttConfigurationUpdate }
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
  /**
   * Why the behaviour completed, read once `isComplete()` is true, for the call record (for example
   * `decision:intent=goodbye` or `llm:end_call`). The outcome is still `completed`.
   */
  completionReason?(): string | undefined;
  /**
   * True when the behaviour speaks before the caller does. The engine then runs one opening turn,
   * `respond('', { inputEvent: 'opening' })`, without waiting for speech recognition.
   */
  speaksFirst?(): boolean;
  /**
   * The carrier reported an answering machine. Returns the message to leave, or '' to end the call
   * without one. `undefined`, or no such method, leaves the call as it is: the engine only records
   * the verdict, and a held opening plays.
   */
  voicemail?(variables: Record<string, unknown>): string | undefined;
  /**
   * The caller-silence timeout when the behaviour handles silence itself (AGT-11). The engine then
   * times silence and runs `respond('', { inputEvent: 'idle' })`, ignoring the turn detector's own
   * idle prompts; an idle turn that completes the behaviour ends the call as `caller_idle`.
   */
  idleTimeoutMs?(): number | undefined;
  /** 'confirmation' for the pending confirmation prompt. */
  speechKind?(text: string): SpeechKindV2 | undefined;
  subscribe?(fn: (event: BehaviorEvent) => void): () => void;
}

/**
 * Where a session records what it decided (AGT-8): `turn.route`, `flow.state`, `disposition`,
 * `variables.captured`, `guardrail` and `call.outcome`, validated by `readSessionEvent`.
 *
 * `append` is called on the live turn path, so an implementation must never wait on storage or
 * throw into the call: it validates, queues and returns. A malformed event is reported by the sink
 * and dropped. Optional for behaviours; a session without a sink records nothing and runs the same.
 */
export interface EventSink {
  append(type: string, payload: Record<string, unknown>): Promise<void>;
  /** Writes what is queued, bounded by the sink's own deadline. Called once the call has ended. */
  flush?(): Promise<void>;
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
