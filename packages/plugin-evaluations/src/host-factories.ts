import type {
  AgentConfig,
  Behavior,
  Execution,
  Inference,
  OperationStore,
  Speech,
  ToolConnector,
} from '@winsendotai/ovo-contracts';

/** Host-owned behavior and tool construction for isolated evaluation cases. */
export interface EvaluationHostFactories {
  createBehavior(
    config: AgentConfig,
    deps: {
      inference: Inference;
      execution: Execution;
      workspaceId: string;
      sessionId: string;
    },
  ): Behavior;
  createExecution(
    config: AgentConfig,
    deps: {
      store: OperationStore;
      speech: Speech;
      connectors: { native: ToolConnector; http: ToolConnector; mcp: ToolConnector };
    },
  ): Execution;
}
