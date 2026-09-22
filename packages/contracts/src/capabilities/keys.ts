/** The only place capability strings are spelled. Existing names are kept (§0.3). */
export const Cap = {
  behavior: 'ovo.behavior',
  execution: 'ovo.execution',
  inference: 'ovo.inference',
  speech: 'ovo.speech',
  stt: 'ovo.stt',
  tts: 'ovo.tts-streaming',
  engine: 'ovo.voice-session-engine',
  scheduler: 'ovo.speech-scheduler',
  output: 'ovo.speech-output',
  media: 'ovo.media.duplex',
  turnDetector: 'ovo.turn-detector',
  vad: 'ovo.vad',
  textFilters: 'ovo.text-filter',
  audioFilter: 'ovo.audio-filter',
  operationStore: 'ovo.operation-store',
  secrets: 'ovo.secret-resolver',
  usage: 'ovo.usage-sink',
  transcripts: 'ovo.transcript-observer',
  clock: 'ovo.clock',
  net: 'ovo.net',
  carrierControl: 'ovo.carrier.control',
  carrierIngress: 'ovo.carrier.ingress',
  backgroundTask: 'ovo.background-task',
  capacitySignal: 'capacity.signal',
  operations: 'ovo.operations',
  costLedger: 'ovo.cost-ledger',
  orchestrationStore: 'orchestration.store',
  /** @deprecated v1 carrier control; removed in wave 3. */
  legacyTelephony: 'telephony.control',
  // Every other key provided or read today (packages/*/src, apps/*/src).
  toolNative: 'ovo.tool-connector.native',
  toolHttp: 'ovo.tool-connector.http',
  toolMcp: 'ovo.tool-connector.mcp',
  sttBatch: 'ovo.stt-batch',
  cachedTts: 'ovo.tts',
  audioPlayer: 'ovo.audio-player',
  cache: 'ovo.cache',
  costScenario: 'ovo.cost-scenario',
  evaluations: 'ovo.evaluations',
  infrastructure: 'ovo.infrastructure',
  observability: 'ovo.observability',
  telemetry: 'ovo.telemetry',
  telemetryStore: 'ovo.telemetry-store',
  users: 'ovo.users',
  recordings: 'ovo.recordings',
  recordingsLive: 'ovo.recordings-live',
  recordingRetention: 'ovo.recording-retention',
  recordingExports: 'ovo.recording-exports',
  recordingsProduction: 'ovo.recordings-production',
  recordingSession: 'ovo.recording-session',
  mediaGateway: 'ovo.media-gateway',
  mediaRouteResolver: 'ovo.media-route-resolver',
  consoleExtensions: 'ovo.console-extensions',
  orchestrationQueue: 'orchestration.queue',
  capacityWriter: 'capacity.writer',
  /** @deprecated v1 media protocol; removed with `telephony.control`. */
  legacyMediaProtocol: 'telephony.media-protocol',
  workerProtection: 'worker.protection',
  workerReadiness: 'worker.readiness',
  workerRunner: 'worker.runner',
  workerCallRecorder: 'worker.call-recorder',
  workerCostRuntime: 'worker.cost-runtime',
  dispatcherService: 'dispatcher.service',
  controlStore: 'controlStore',
  secretManager: 'secretManager',
  /** @deprecated alias of `ovo.secret-resolver` provided by the secrets plugin. */
  legacySecretResolver: 'secretResolver',
  managementApi: 'managementApi',
  exampleReminder: 'example.reminder',
} as const;
export type CapKey = (typeof Cap)[keyof typeof Cap];

/** Dynamic key families: `${prefix}${suffix}`. Their spec is derived by `capabilitySpec`. */
export const CAP_PREFIXES = {
  toolConnector: 'ovo.tool-connector.',
  consoleExtension: 'ovo.console-extension.',
  nativeHandlers: 'ovo.native-handlers:',
} as const;

export interface CapabilitySpec {
  major: number;
  cardinality: 'one' | 'many';
  /** Where a provider may live. Only 'process' and 'either' keys may be read from a parent (§3.5). */
  scope: 'process' | 'session' | 'either';
}

const SESSION = { major: 1, cardinality: 'one', scope: 'session' } as const;
const PROCESS = { major: 1, cardinality: 'one', scope: 'process' } as const;
const EITHER = { major: 1, cardinality: 'one', scope: 'either' } as const;
const V2_SESSION = { major: 2, cardinality: 'one', scope: 'session' } as const;
const MANY_PROCESS = { major: 1, cardinality: 'many', scope: 'process' } as const;

export const CAPABILITY_SPECS = {
  [Cap.behavior]: SESSION,
  [Cap.execution]: SESSION,
  [Cap.inference]: SESSION,
  [Cap.speech]: SESSION,
  [Cap.stt]: V2_SESSION,
  [Cap.tts]: V2_SESSION,
  [Cap.engine]: V2_SESSION,
  [Cap.scheduler]: SESSION,
  [Cap.output]: SESSION,
  [Cap.media]: SESSION,
  [Cap.turnDetector]: SESSION,
  [Cap.vad]: SESSION,
  [Cap.textFilters]: { major: 1, cardinality: 'many', scope: 'session' },
  [Cap.audioFilter]: SESSION,
  [Cap.operationStore]: EITHER,
  [Cap.secrets]: EITHER,
  [Cap.usage]: SESSION,
  [Cap.transcripts]: SESSION,
  [Cap.clock]: EITHER,
  [Cap.net]: EITHER,
  [Cap.carrierControl]: MANY_PROCESS,
  [Cap.carrierIngress]: MANY_PROCESS,
  [Cap.backgroundTask]: MANY_PROCESS,
  [Cap.capacitySignal]: PROCESS,
  [Cap.operations]: PROCESS,
  [Cap.costLedger]: PROCESS,
  [Cap.orchestrationStore]: PROCESS,
  [Cap.legacyTelephony]: PROCESS,
  [Cap.toolNative]: SESSION,
  [Cap.toolHttp]: SESSION,
  [Cap.toolMcp]: SESSION,
  [Cap.sttBatch]: EITHER,
  [Cap.cachedTts]: SESSION,
  [Cap.audioPlayer]: SESSION,
  [Cap.cache]: EITHER,
  [Cap.costScenario]: PROCESS,
  [Cap.evaluations]: PROCESS,
  [Cap.infrastructure]: PROCESS,
  [Cap.observability]: EITHER,
  [Cap.telemetry]: PROCESS,
  [Cap.telemetryStore]: PROCESS,
  [Cap.users]: PROCESS,
  [Cap.recordings]: PROCESS,
  [Cap.recordingsLive]: PROCESS,
  [Cap.recordingRetention]: PROCESS,
  [Cap.recordingExports]: PROCESS,
  [Cap.recordingsProduction]: PROCESS,
  [Cap.recordingSession]: SESSION,
  [Cap.mediaGateway]: PROCESS,
  [Cap.mediaRouteResolver]: PROCESS,
  [Cap.consoleExtensions]: PROCESS,
  [Cap.orchestrationQueue]: PROCESS,
  [Cap.capacityWriter]: PROCESS,
  [Cap.legacyMediaProtocol]: PROCESS,
  [Cap.workerProtection]: PROCESS,
  [Cap.workerReadiness]: PROCESS,
  [Cap.workerRunner]: PROCESS,
  [Cap.workerCallRecorder]: PROCESS,
  [Cap.workerCostRuntime]: PROCESS,
  [Cap.dispatcherService]: PROCESS,
  [Cap.controlStore]: PROCESS,
  [Cap.secretManager]: PROCESS,
  [Cap.legacySecretResolver]: PROCESS,
  [Cap.managementApi]: PROCESS,
  [Cap.exampleReminder]: EITHER,
} as const satisfies Record<CapKey, CapabilitySpec>;

/** Unknown keys (tests, third-party extensions). */
export const DEFAULT_SPEC: CapabilitySpec = Object.freeze({
  major: 1,
  cardinality: 'one',
  scope: 'either',
});

/** Keys the worker host provides to every session graph. Release validation treats them as satisfied (§3.5). */
export const HOST_SESSION_SERVICES = [
  Cap.media,
  Cap.operationStore,
  Cap.secrets,
  Cap.usage,
  Cap.transcripts,
  Cap.clock,
] as const;

const SPECS: Readonly<Record<string, CapabilitySpec>> = CAPABILITY_SPECS;

/** The spec for any key, including dynamic families (tool connectors are session-scoped). */
export function capabilitySpec(key: string): CapabilitySpec {
  if (Object.hasOwn(SPECS, key)) return SPECS[key]!;
  if (key.startsWith(CAP_PREFIXES.toolConnector)) return SESSION;
  if (key.startsWith(CAP_PREFIXES.nativeHandlers)) return SESSION;
  if (key.startsWith(CAP_PREFIXES.consoleExtension)) return PROCESS;
  return DEFAULT_SPEC;
}

/** Manifest entries may be `${key}@${major}`. */
export function parseCapabilityEntry(entry: string): { key: string; major?: number } {
  const match = /^(.+)@([1-9]\d*)$/.exec(entry);
  return match ? { key: match[1]!, major: Number(match[2]) } : { key: entry };
}

export function isCapKey(key: string): key is CapKey {
  return Object.hasOwn(SPECS, key);
}
