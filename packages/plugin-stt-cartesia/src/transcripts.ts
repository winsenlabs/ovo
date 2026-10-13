import type { SttEvent, TranscriptSegment } from '@winsendotai/ovo-contracts';

type Extra = Pick<TranscriptSegment, 'words' | 'language' | 'startMs' | 'endMs'>;

/**
 * Segment ids and session-monotonic revisions. Interims of the open segment replace each other
 * (only changes are emitted); a final locks it and the next text opens a new one.
 */
export class Segments {
  private count = 0;
  private revision = 0;
  private open?: string;
  private shown = '';

  constructor(private readonly onEvent: (event: SttEvent) => void) {}

  /** A new turn: whatever comes next belongs to a fresh segment. */
  start(): void {
    this.open = `ink-${++this.count}`;
    this.shown = '';
  }

  interim(raw: string): void {
    const text = raw.trim();
    if (!text || text === this.shown) return;
    if (!this.open) this.start();
    this.shown = text;
    this.emit(text, 'interim');
  }

  /** Locks the open segment with `raw`; false (and nothing emitted) when it holds no words. */
  final(raw: string, extra: Extra = {}): boolean {
    const text = raw.trim();
    if (!text) {
      this.open = undefined;
      return false;
    }
    if (!this.open) this.start();
    this.emit(text, 'final', extra);
    this.open = undefined;
    this.shown = '';
    return true;
  }

  /** The open segment's last interim, locked as final (a turn the provider never ended). */
  promote(): boolean {
    return this.open !== undefined && this.final(this.shown);
  }

  private emit(text: string, stability: 'interim' | 'final', extra: Extra = {}): void {
    this.onEvent({
      type: 'transcript',
      segment: { segmentId: this.open!, revision: ++this.revision, text, stability, ...extra },
    });
  }
}

const text = (event: Record<string, unknown>, field: string) =>
  typeof event[field] === 'string' ? (event[field] as string) : '';

/**
 * `/stt/turns/websocket` events as OVO STT events. The `transcript` is cumulative within a turn
 * and never revised (https://docs.cartesia.ai/use-the-api/stt/turns.md, retrieved 2026-10-13):
 * - `turn.start` → `speech-start` and a new segment;
 * - `turn.update` → an interim revision;
 * - `turn.eager_end` → an interim revision and `end-of-turn {eager: true}`;
 * - `turn.resume` → `turn-resumed` (only ever after an eager end);
 * - `turn.end` → the final and `end-of-turn`. A turn that ends with no words ends silently.
 */
export class TurnEvents {
  private readonly segments: Segments;

  constructor(private readonly onEvent: (event: SttEvent) => void) {
    this.segments = new Segments(onEvent);
  }

  handle(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'turn.start':
        this.segments.start();
        return this.onEvent({ type: 'speech-start' });
      case 'turn.update':
        return this.segments.interim(text(event, 'transcript'));
      case 'turn.eager_end':
        this.segments.interim(text(event, 'transcript'));
        return this.onEvent({ type: 'end-of-turn', eager: true });
      case 'turn.resume':
        return this.onEvent({ type: 'turn-resumed' });
      case 'turn.end':
        if (this.segments.final(text(event, 'transcript'))) this.onEvent({ type: 'end-of-turn' });
        return;
    }
  }

  /**
   * The session ended gracefully inside a turn: its cumulative text is final by the provider's own
   * rule ("the model never revises text it has already sent"), so it is kept, not dropped.
   */
  flush(): void {
    this.segments.promote();
  }
}

interface Word {
  text: string;
  startMs: number;
  endMs: number;
  final: boolean;
}

function wordsOf(event: Record<string, unknown>): Word[] {
  if (!Array.isArray(event.words)) return [];
  return event.words.flatMap((entry: unknown) => {
    const word = entry as { word?: unknown; start?: unknown; end?: unknown };
    if (typeof word?.word !== 'string' || typeof word.start !== 'number') return [];
    const end = typeof word.end === 'number' ? word.end : word.start;
    // Seconds to whole milliseconds: 2.01 * 1000 is 2009.9999999999998 in floating point.
    const ms = (seconds: number) => Math.round(seconds * 1000);
    return [{ text: word.word, startMs: ms(word.start), endMs: ms(end), final: true }];
  });
}

/**
 * `/stt/websocket` transcripts. Each `is_final` text is "a delta from the last transcript chunk
 * with is_final: true", to be concatenated with no whitespace added or stripped
 * (https://docs.cartesia.ai/api-reference/stt/websocket.md). OVO joins finals with a space, so
 * the deltas of one finalize are held and emitted as ONE final when its `flush_done` (or the
 * session's `done`) arrives; meanwhile they show as interims, with any non-final delta appended.
 */
export class FinalizeEvents {
  private readonly segments: Segments;
  private held = '';
  private words: Word[] = [];
  private language?: string;

  constructor(onEvent: (event: SttEvent) => void) {
    this.segments = new Segments(onEvent);
  }

  transcript(event: Record<string, unknown>): void {
    const delta = text(event, 'text');
    if (event.is_final !== true) return this.segments.interim(this.held + delta);
    this.held += delta;
    this.words.push(...wordsOf(event));
    // UNCONFIRMED: the reference's example carries `language`; its property table does not.
    if (typeof event.language === 'string') this.language = event.language;
    this.segments.interim(this.held);
  }

  /** `flush_done` or `done`: everything held becomes one final segment. */
  settle(): void {
    const words = this.words;
    const extra: Extra = {
      ...(words.length ? { words, startMs: words[0]!.startMs, endMs: words.at(-1)!.endMs } : {}),
      ...(this.language ? { language: this.language } : {}),
    };
    this.segments.final(this.held, extra);
    this.held = '';
    this.words = [];
    this.language = undefined;
  }
}
