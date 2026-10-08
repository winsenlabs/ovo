import { normalizeForMatch, type Clock, type SpeechToText } from '@winsendotai/ovo-contracts';
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

  /**
   * N5 while a commit is held: a late partial equal to it or a prefix of it is stale, as after the
   * commit is released. One with new words is the caller speaking again, so the held commit is
   * released without its confidence first and the partial opens the next segment.
   */
  partial(text: string): void {
    const held = this.commits.pending;
    if (held !== undefined) {
      const words = normalizeForMatch(text);
      if (!words || normalizeForMatch(held).startsWith(words)) return;
      this.commits.flush();
    }
    this.segments.onPartial(text);
  }

  /** `sentAtMs`: when the commit this answers was sent, if the session sent it. */
  committed(text: string, sentAtMs?: number): void {
    this.commits.committed(text, sentAtMs);
  }

  /** The word-level message after a commit: its detected language and word confidence. */
  words(message: { text?: string; language?: string; confidence?: number }): void {
    if (message.language)
      logger.info('stt_language_detected', {
        sessionId: this.input.sessionId,
        language: message.language,
        expected: this.input.language,
      });
    this.commits.words(message.text, message.confidence);
  }

  /** A refused commit; an earlier commit still held for its confidence goes first. */
  throttled(): void {
    this.commits.flush();
    this.segments.onThrottled();
  }

  /** The session ended: a commit still held for its confidence is delivered without it. */
  dispose(): void {
    this.commits.flush();
  }
}
