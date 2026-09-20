/** Public, approved plugin-author surface. This module performs no dynamic loading. */
export {
  Context,
  compose,
  composeEntries,
  createScope,
  definePlugin,
  resolveGraph,
} from '@winsendotai/ovo-runtime';
export type {
  Composition,
  EntryOptions,
  PatchOptions,
  PluginDefinition,
  PluginRow,
} from '@winsendotai/ovo-runtime';
export {
  AgentConfig,
  JsonSchema,
  Manifest,
  Mode,
  ProcessingSpeech,
  ToolDefinition,
} from '@winsendotai/ovo-contracts';
export type {
  Behavior,
  CallEvent,
  EventSink,
  Execution,
  ExecutionRequest,
  Inference,
  InferenceReply,
  InferenceRequest,
  OperationRecord,
  OperationStore,
  Release,
  SecretResolver,
  Speech,
  SpeechReceipt,
  ToolConnection,
  ToolConnector,
} from '@winsendotai/ovo-contracts';
