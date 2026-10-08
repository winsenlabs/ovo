import type { Clock, SpeechToText } from '@winsendotai/ovo-contracts';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import { CommitConfidence } from './confidence.ts';
import { ScribeSegments } from './segments.ts';

const logger = createLogger({ service: 'stt-elevenlabs' });

/** What a session does with the provider's transcripts beyond relaying them (Wave 8). */
export interface ScribeTranscriptOptions {
  /** Hold each commit's final for the word-level message that gives its confidence. */
  confidence?: boolean;
  /** Rewrites each transcript as emitted (the agent's misheard name restored). */
  rewrite?: (text: string) => string;
}

/**
 * The transcript side of a session: partials and commits become segments (ScribeSegments), each
 * commit's final waiting for its word confidence when asked (CommitConfidence). `answered` runs
 * once per commit the provider has answered, so a finishing session knows when it is done.
 */
export class ScribeTranscripts {
  private readonly segments: ScribeSegments;
  private readonly commits: CommitConfidence;

  constructor(
    private readonly input: Parameters<SpeechToText['start']>[0],
    clock: Clock,
    options: ScribeTranscriptOptions,
    private readonly answered: () => void,
  ) {
    this.segments = new ScribeSegments(input.onEvent, () => clock.now(), options.rewrite);
    this.commits = new CommitConfidence(
      options.confidence === true,
      clock,
      (text, confidence) => {
        this.segments.onCommitted(text, confidence);
        this.answered();
      },
      (event, fields) => logger.info(event, { sessionId: input.sessionId, ...fields }),
    );
  }

  partial(text: string): void {
    this.segments.onPartial(text);
  }

  committed(text: string): void {
    this.commits.committed(text);
  }

  /** The word-level message after a commit: its detected language and word confidence. */
  words(message: { language?: string; confidence?: number }): void {
    if (message.language)
      logger.info('stt_language_detected', {
        sessionId: this.input.sessionId,
        language: message.language,
        expected: this.input.language,
      });
    this.commits.words(message.confidence);
  }

  /** A refused commit; an earlier commit still held for its confidence goes first. */
  throttled(): void {
    this.commits.flush();
    this.segments.onThrottled();
  }

  dispose(): void {
    this.commits.dispose();
  }
}
