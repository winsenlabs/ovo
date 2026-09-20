import { z } from 'zod';

export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;
export const Mode = z.enum(['announcement', 'faq', 'context', 'agent']);
export const ProcessingSpeech = z.object({
  initial: z.string().min(1).max(1000),
  progress: z.string().max(1000).optional(),
  progressAfterMs: z.number().int().positive().default(5000),
  maxProgress: z.number().int().min(0).max(3).default(1),
  failure: z.string().min(1).default('I could not complete that check.'),
});
export type ProcessingSpeech = z.infer<typeof ProcessingSpeech>;
export const ToolDefinition = z.object({
  id: z.string().min(1).max(120),
  description: z.string().max(2000),
  connector: z.enum(['native', 'http', 'mcp']),
  connectionId: z.string().optional(),
  remoteName: z.string().optional(),
  inputSchema: JsonSchema,
  outputSchema: JsonSchema.optional(),
  schemaDigest: z.string().optional(),
  effect: z.enum(['read', 'write']),
  confirmation: z.boolean().default(false),
  timeoutMs: z.number().int().min(1).max(120000).default(10000),
  processing: ProcessingSpeech.optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;
export const AgentConfig = z.object({
  name: z.string().min(1).max(120),
  mode: Mode,
  language: z.string().default('en-IN'),
  locale: z.string().default('en-IN'),
  timezone: z.string().default('Asia/Kolkata'),
  message: z.string().max(20000).default(''),
  variables: JsonSchema.default({ type: 'object', properties: {}, additionalProperties: false }),
  faq: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        aliases: z.array(z.string()).default([]),
        answer: z.string(),
        requiresTool: z.string().optional(),
      }),
    )
    .max(1000)
    .default([]),
  faqThreshold: z.number().min(0).max(1).default(0.65),
  faqMargin: z.number().min(0).max(1).default(0.15),
  clarification: z.string().default('Please clarify your question.'),
  context: z.string().max(100000).default(''),
  contextBudget: z.number().int().min(1).max(100000).default(12000),
  uncertainty: z.string().default('I do not have that information.'),
  tools: z.array(ToolDefinition).max(100).default([]),
  allowedTools: z.array(z.string()).default([]),
  processing: ProcessingSpeech.default({
    initial: 'Please wait while I check that.',
    progressAfterMs: 5000,
    maxProgress: 1,
    failure: 'I could not complete that check.',
  }),
  maxSteps: z.number().int().min(1).max(20).default(5),
  providers: z.record(z.string(), z.string()).default({}),
  recording: z.boolean().default(false),
});
export type AgentConfig = z.infer<typeof AgentConfig>;
export const Manifest = z.object({
  id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  contractVersion: z.literal(1),
  scope: z.enum(['process', 'session']),
  provides: z.array(z.string()),
  requires: z.array(z.string()).default([]),
  configSchema: JsonSchema.default({ type: 'object' }),
  secretFields: z.array(z.string()).default([]),
  ui: z.object({ label: z.string(), panel: z.string().optional() }).optional(),
});
export type Manifest = z.infer<typeof Manifest>;
export interface Release {
  id: string;
  workspaceId: string;
  agentId: string;
  config: AgentConfig;
  plugins: { id: string; version: string }[];
  createdAt: string;
}
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
}
export interface Speech {
  speak(
    text: string,
    options?: { epoch?: number; kind?: 'acknowledgment' | 'response' | 'progress' },
  ): Promise<SpeechReceipt>;
  interrupt(): Promise<void>;
}
export interface InferenceRequest {
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
export interface Inference {
  generate(request: InferenceRequest): Promise<InferenceReply>;
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
export interface Behavior {
  respond(input: string, variables?: Record<string, unknown>): Promise<string>;
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

export { DurableEvent, readDurableEvent } from './events.ts';
