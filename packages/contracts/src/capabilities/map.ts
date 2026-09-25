import type { CarrierControlFactory } from '../carrier/control.ts';
import type { CarrierIngress } from '../carrier/ingress.ts';
import type { Clock } from '../clock.ts';
import type { NetPort } from '../net.ts';
import type { BackgroundTask } from '../ops/background-task.ts';
import type { CapacitySignalPublisher } from '../ops/capacity-signal.ts';
import type {
  Behavior,
  Execution,
  Inference,
  OperationStore,
  SecretResolver,
  Speech,
  ToolConnector,
} from '../ports.ts';
import type { SpeechToText } from '../speech/stt.ts';
import type { TextToSpeech } from '../speech/tts.ts';
import type { UsageSink } from '../usage.ts';
import type { TranscriptObserver, VoiceSessionEngine } from '../voice/engine.ts';
import type { AudioFilter, TextFilter } from '../voice/filters.ts';
import type { MediaDuplex } from '../voice/media.ts';
import type { SpeechOutput } from '../voice/output.ts';
import type { TurnDetectorFactory } from '../voice/turn.ts';
import type { VadAnalyzerFactory } from '../voice/vad.ts';
import { Cap, type CapKey } from './keys.ts';

/** Keys whose interface lives in contracts. Keys of cardinality 'many' map to the per-provider value. */
interface TypedCapabilities {
  [Cap.behavior]: Behavior;
  [Cap.execution]: Execution;
  [Cap.inference]: Inference;
  [Cap.speech]: Speech;
  [Cap.stt]: SpeechToText;
  [Cap.tts]: TextToSpeech;
  [Cap.engine]: VoiceSessionEngine;
  [Cap.scheduler]: Speech;
  [Cap.output]: SpeechOutput;
  [Cap.media]: MediaDuplex;
  [Cap.turnDetector]: TurnDetectorFactory;
  [Cap.vad]: VadAnalyzerFactory;
  [Cap.textFilters]: TextFilter;
  [Cap.audioFilter]: AudioFilter;
  [Cap.operationStore]: OperationStore;
  [Cap.secrets]: SecretResolver;
  [Cap.usage]: UsageSink;
  [Cap.transcripts]: TranscriptObserver;
  [Cap.clock]: Clock;
  [Cap.net]: NetPort;
  [Cap.carrierControl]: CarrierControlFactory;
  [Cap.carrierIngress]: CarrierIngress;
  [Cap.backgroundTask]: BackgroundTask;
  [Cap.capacitySignal]: CapacitySignalPublisher;
  [Cap.toolNative]: ToolConnector;
  [Cap.toolHttp]: ToolConnector;
  [Cap.toolMcp]: ToolConnector;
  [Cap.legacySecretResolver]: SecretResolver;
}

/** Type-only map from every capability key to its interface; host-private services are `unknown`. */
export type CapabilityMap = {
  [K in CapKey]: K extends keyof TypedCapabilities ? TypedCapabilities[K] : unknown;
};
