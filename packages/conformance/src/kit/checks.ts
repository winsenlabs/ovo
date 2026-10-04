import { CARRIER_CHECKS, type CarrierFactory, type CarrierKitOptions } from './carrier.ts';
import { ENGINE_CHECKS, type EngineKitOptions } from './engine.ts';
import type { EngineFactory } from './engine-ports.ts';
import { INFERENCE_CHECKS, type InferenceFactory, type InferenceKitOptions } from './inference.ts';
import { runChecks, type KitFailure, type KitRunOptions } from './runner.ts';
import { STT_CHECKS, type SttFactory, type SttKitOptions } from './stt.ts';
import { TTS_CHECKS, type TtsFactory, type TtsKitOptions } from './tts.ts';
import { TURN_CHECKS, type TurnDetectorKitFactory } from './turn.ts';
import { VAD_CHECKS, type VadFactory } from './vad.ts';

/** `checkX` runs a kit without vitest and returns its failures, for meta-testing broken fakes. */
export const checkSpeechToText = (
  factory: SttFactory,
  options: SttKitOptions = {},
  run?: KitRunOptions,
): Promise<KitFailure[]> => runChecks(STT_CHECKS, () => ({ factory, options }), run);

export const checkTextToSpeech = (
  factory: TtsFactory,
  options: TtsKitOptions = {},
  run?: KitRunOptions,
): Promise<KitFailure[]> => runChecks(TTS_CHECKS, () => ({ factory, options }), run);

export const checkInference = (
  factory: InferenceFactory,
  options: InferenceKitOptions = {},
  run?: KitRunOptions,
): Promise<KitFailure[]> => runChecks(INFERENCE_CHECKS, () => ({ factory, options }), run);

export const checkCarrier = (
  factory: CarrierFactory,
  options: CarrierKitOptions,
  run?: KitRunOptions,
): Promise<KitFailure[]> => runChecks(CARRIER_CHECKS, () => ({ factory, options }), run);

export const checkEngine = (
  factory: EngineFactory,
  options: EngineKitOptions = {},
  run?: KitRunOptions,
): Promise<KitFailure[]> =>
  runChecks(ENGINE_CHECKS, () => ({ factory, options }), { timeoutMs: 30_000, ...run });

export const checkVad = (factory: VadFactory, run?: KitRunOptions): Promise<KitFailure[]> =>
  runChecks(VAD_CHECKS, () => ({ factory }), run);

export const checkTurnDetector = (
  factory: TurnDetectorKitFactory,
  run?: KitRunOptions,
): Promise<KitFailure[]> => runChecks(TURN_CHECKS, () => ({ factory }), run);
