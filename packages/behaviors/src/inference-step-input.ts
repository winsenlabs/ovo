import type { ValidateFunction } from 'ajv';
import type {
  AgentConfig,
  Execution,
  Inference,
  InferenceRequest,
  OperationRecord,
  ToolDefinition,
} from '@winsendotai/ovo-contracts';
import type { AgentTurnLog } from './agent-turn-log.ts';
import type { TransferTool } from './agent-transfer.ts';
import type { ToolConfirmation } from './confirmation.ts';
import type { FlowSession } from './flow-session.ts';
import type { ToolEvents } from './tool-events.ts';

/** What one agent turn's inference steps are given (`runInferenceSteps`). */
export interface InferenceStepInput {
  config: AgentConfig;
  inference: Inference;
  execution: Execution;
  identity: { workspaceId: string; sessionId: string };
  tools: ToolDefinition[];
  validators: ReadonlyMap<string, ValidateFunction>;
  log: AgentTurnLog;
  confirmation: ToolConfirmation;
  events: ToolEvents;
  /** Records a line as generated and returns it for speaking. */
  publish: (text: string) => string;
  /** The LLM ended the call; its goodbye is this turn's reply. */
  endCall: (reason: string) => void;
  /** R2: the LLM's `transfer_to_agent` (offered only on a routed call that grants targets). */
  transferToAgent?: TransferTool;
  /** N1: why the LLM may not end the call on this turn (`EndCallGate`); undefined when it may. */
  endRefused?: () => string | undefined;
  /** Wave 10 (L2): "Shall I end the call?" was said for the model's `end_call` with `reason`. */
  askedToEnd?: (reason: string) => void;
  operationId: () => string;
  turn: number;
  /** False once a newer turn has superseded this one. */
  current: () => boolean;
  input: string;
  history: InferenceRequest['history'];
  context: string;
  /** Records settled this turn; appended to as tools run. */
  results: OperationRecord[];
  streaming: boolean;
  signal: AbortSignal;
  /** A previous write's outcome was never confirmed. */
  uncertainWrite: () => boolean;
  /** This turn already executed a confirmed write. */
  wrote: boolean;
  /** The session's flow, when the agent routes by one: the LLM may hand the call back to it. */
  flow?: FlowSession;
  /** The reply guardrail from the pre-reply step: the text to speak, or undefined to drop it. */
  guard?: (segment: string) => string | undefined;
  /** The caller cut off the agent's previous reply (P7); the LLM is told so in its instructions. */
  replyCut?: boolean;
  /** What the agent said in its previous turn, so the uncertainty line is not said twice (P10). */
  previous?: readonly string[];
  /** Wave 12 (F7): what it said in its last three turns, so it rarely offers more. */
  recentSaid?: readonly string[];
  /** Wave 10 (B1): the earlier words this turn's were said after, before their reply was heard. */
  saidBefore?: string;
  /**
   * Wave 12 (F1): whether a request goes with the provider's own tools (a web search), as the
   * session's limited port decides it (`Inference.sendsProviderTools`); absent, never known.
   */
  sendsProviderTools?: (request: Omit<InferenceRequest, 'signal'>) => boolean;
}
