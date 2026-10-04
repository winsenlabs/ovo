import { SpeechQueueOverflowError, type SpeechSchedulerConfig } from './types.ts';

export interface ResolvedSpeechSchedulerConfig {
  maxQueuedSegments: number;
  maxQueuedCharacters: number;
  maxEvidenceEntries: number;
  playbackTimeoutMs: number;
}

const DEFAULTS: ResolvedSpeechSchedulerConfig = Object.freeze({
  maxQueuedSegments: 32,
  maxQueuedCharacters: 32_000,
  maxEvidenceEntries: 512,
  playbackTimeoutMs: 30_000,
});

export function resolveSpeechSchedulerConfig(
  config: SpeechSchedulerConfig,
): ResolvedSpeechSchedulerConfig {
  return {
    maxQueuedSegments: boundedInteger(
      config.maxQueuedSegments,
      DEFAULTS.maxQueuedSegments,
      1,
      1_000,
      'maxQueuedSegments',
    ),
    maxQueuedCharacters: boundedInteger(
      config.maxQueuedCharacters,
      DEFAULTS.maxQueuedCharacters,
      1,
      1_000_000,
      'maxQueuedCharacters',
    ),
    maxEvidenceEntries: boundedInteger(
      config.maxEvidenceEntries,
      DEFAULTS.maxEvidenceEntries,
      4,
      10_000,
      'maxEvidenceEntries',
    ),
    playbackTimeoutMs: boundedInteger(
      config.playbackTimeoutMs,
      DEFAULTS.playbackTimeoutMs,
      1,
      300_000,
      'playbackTimeoutMs',
    ),
  };
}

export class SpeechQueueBudget {
  private characters = 0;

  constructor(private readonly limits: ResolvedSpeechSchedulerConfig) {}

  overflow(pendingCount: number, text: string): SpeechQueueOverflowError | undefined {
    if (pendingCount >= this.limits.maxQueuedSegments) {
      return new SpeechQueueOverflowError(
        `Speech queue reached ${this.limits.maxQueuedSegments} segments`,
      );
    }
    if (this.characters + text.length > this.limits.maxQueuedCharacters) {
      return new SpeechQueueOverflowError(
        `Speech queue reached ${this.limits.maxQueuedCharacters} characters`,
      );
    }
  }

  add(text: string): void {
    this.characters += text.length;
  }

  remove(text: string): void {
    this.characters = Math.max(0, this.characters - text.length);
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < min || selected > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return selected;
}
