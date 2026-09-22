/** Public, approved plugin-author surface. This module performs no dynamic loading. */
export {
  Context,
  compose,
  composeEntries,
  createScope,
  definePlugin,
  resolveGraph,
  validateGraph,
} from '@winsendotai/ovo-runtime';
export type {
  CapabilityOf,
  ComposeOptions,
  Composition,
  EntryOptions,
  ManifestV2Literal,
  PatchOptions,
  PluginContext,
  PluginDefinition,
  PluginRow,
} from '@winsendotai/ovo-runtime';
export { definePluginV2, jsonSchemaFor, type PluginSpecV2 } from './define-plugin-v2.ts';
export {
  AgentConfig,
  Cap,
  JsonSchema,
  Manifest,
  ManifestV2,
  Mode,
  PluginKind,
  ProcessingSpeech,
  ToolDefinition,
  normalizeManifest,
} from '@winsendotai/ovo-contracts';
export type {
  Behavior,
  CallEvent,
  CapabilityMap,
  CapKey,
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
