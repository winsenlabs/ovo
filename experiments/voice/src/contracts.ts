import type { PluginDefinition, PluginRow } from '@winsendotai/ovo-runtime';

export const VOICE_EXPERIMENT_SERVICE = 'ovo.experiment.voice-engine';

export type CandidateName = 'focused-ovo-ai-sdk' | 'livekit-agent-session';

export interface TraceEvent {
  sequence: number;
  type: string;
  elapsedMs: number;
  details?: Record<string, unknown>;
}

export interface ScenarioResult {
  candidate: CandidateName;
  scenario: 'no-llm-faq' | 'interrupt-before-tool-settles';
  trace: TraceEvent[];
  answer?: string;
  modelRequests: number;
  toolAttempts: number;
  toolOwner: 'none' | 'ovo-execution' | 'livekit-agent-session';
  stalePlaybackCount: number;
  operationState?: 'failed' | 'succeeded' | 'unknown';
}

export interface VoiceExperimentEngine {
  readonly candidate: CandidateName;
  runFaq(input?: string): Promise<ScenarioResult>;
  runInterruptToolScenario(): Promise<ScenarioResult>;
  dispose(): Promise<void>;
}

export function expectExperimentService(value: unknown): VoiceExperimentEngine {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('runFaq' in value) ||
    !('runInterruptToolScenario' in value)
  ) {
    throw new Error(`Missing ${VOICE_EXPERIMENT_SERVICE}`);
  }
  return value as VoiceExperimentEngine;
}

export type VoiceExperimentPlugin = PluginDefinition;

export interface ExperimentCompositionSpec {
  rows: PluginRow[];
  catalog: PluginDefinition[];
}
