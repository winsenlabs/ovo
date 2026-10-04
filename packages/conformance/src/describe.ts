import { describe, expect, it } from 'vitest';
import { CARRIER_CHECKS, type CarrierFactory, type CarrierKitOptions } from './kit/carrier.ts';
import { ENGINE_CHECKS, type EngineKitOptions } from './kit/engine.ts';
import type { EngineFactory } from './kit/engine-ports.ts';
import {
  INFERENCE_CHECKS,
  type InferenceFactory,
  type InferenceKitOptions,
} from './kit/inference.ts';
import { runCheck, selectChecks, type KitCheck } from './kit/runner.ts';
import { STT_CHECKS, type SttFactory, type SttKitOptions } from './kit/stt.ts';
import { TTS_CHECKS, type TtsFactory, type TtsKitOptions } from './kit/tts.ts';
import { TURN_CHECKS, type TurnDetectorKitFactory } from './kit/turn.ts';
import { VAD_CHECKS, type VadFactory } from './kit/vad.ts';

export interface DescribeOptions {
  /** Run only checks whose name includes one of these substrings. */
  only?: readonly string[];
}

function describeKit<C>(
  kit: string,
  name: string,
  checks: readonly KitCheck<C>[],
  context: () => C,
  only?: readonly string[],
): void {
  describe(`${kit} conformance: ${name}`, () => {
    for (const check of selectChecks(checks, only)) {
      const timeout = (check.timeoutMs ?? 15_000) + 5_000;
      it(
        check.name,
        async () => {
          const failures = await runCheck(check, context, check.timeoutMs);
          expect(failures.map((failure) => failure.message)).toEqual([]);
        },
        timeout,
      );
    }
  });
}

export function describeSpeechToText(
  name: string,
  factory: SttFactory,
  options: SttKitOptions & DescribeOptions = {},
): void {
  describeKit('stt@1', name, STT_CHECKS, () => ({ factory, options }), options.only);
}

export function describeTextToSpeech(
  name: string,
  factory: TtsFactory,
  options: TtsKitOptions & DescribeOptions = {},
): void {
  describeKit('tts@1', name, TTS_CHECKS, () => ({ factory, options }), options.only);
}

export function describeInference(
  name: string,
  factory: InferenceFactory,
  options: InferenceKitOptions & DescribeOptions = {},
): void {
  describeKit('llm@1', name, INFERENCE_CHECKS, () => ({ factory, options }), options.only);
}

export function describeCarrier(
  name: string,
  factory: CarrierFactory,
  options: CarrierKitOptions & DescribeOptions,
): void {
  describeKit('carrier@1', name, CARRIER_CHECKS, () => ({ factory, options }), options.only);
}

export function describeEngine(
  name: string,
  factory: EngineFactory,
  options: EngineKitOptions & DescribeOptions = {},
): void {
  describeKit('engine@1', name, ENGINE_CHECKS, () => ({ factory, options }), options.only);
}

export function describeVad(
  name: string,
  factory: VadFactory,
  options: DescribeOptions = {},
): void {
  describeKit('vad@1', name, VAD_CHECKS, () => ({ factory }), options.only);
}

export function describeTurnDetector(
  name: string,
  factory: TurnDetectorKitFactory,
  options: DescribeOptions = {},
): void {
  describeKit('turn@1', name, TURN_CHECKS, () => ({ factory }), options.only);
}
