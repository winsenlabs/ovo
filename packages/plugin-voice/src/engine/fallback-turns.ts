import type {
  Mode,
  TurnDecision,
  UserTurnController,
  VoiceEvent,
} from '@winsendotai/ovo-contracts';

/** Small provider-signal fallback when no ovo.turn-detector is selected. */
export class FallbackTurns implements UserTurnController {
  private readonly listeners = new Set<(decision: TurnDecision) => void>();
  private finals = new Map<string, string>();
  private interim = '';
  private digits = '';
  private turn = 0;
  private bot?: { epoch: number; kind?: string };
  private buffered?: string;
  private interrupted = false;
  private disposed = false;

  constructor(private readonly mode: Mode) {}

  on(fn: (decision: TurnDecision) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  observe(event: VoiceEvent): void {
    if (this.disposed) return;
    if (event.type === 'bot.started') {
      this.bot = { epoch: event.epoch, kind: event.kind };
      this.interrupted = false;
      if (event.kind === 'disclosure') {
        this.finals.clear();
        this.interim = '';
        this.buffered = undefined;
      }
    } else if (event.type === 'bot.stopped') {
      if (this.bot?.epoch === event.epoch) this.bot = undefined;
      if (this.buffered) {
        const answer = this.buffered;
        this.buffered = undefined;
        this.stop(answer, 1);
      }
    } else if (event.type === 'dtmf') {
      if (event.digit.length > 1) {
        this.emit({
          type: 'turn.stopped',
          turnId: 'turn-' + ++this.turn,
          input: { kind: 'dtmf', digits: event.digit },
        });
        return;
      }
      if (!this.digits && this.bot && !this.interrupted) {
        this.interrupted = true;
        this.emit({ type: 'interrupt', reason: 'dtmf' });
      }
      if (event.digit === '#') {
        if (this.digits)
          this.emit({
            type: 'turn.stopped',
            turnId: 'turn-' + ++this.turn,
            input: { kind: 'dtmf', digits: this.digits },
          });
        this.digits = '';
      } else this.digits += event.digit;
    } else if (event.type === 'stt') {
      if (this.bot?.kind === 'disclosure') return;
      const stt = event.event;
      if (stt.type === 'transcript') {
        const text = stt.segment.text.trim();
        if (this.bot?.kind === 'confirmation') {
          if (stt.segment.stability === 'final' && /^(yes|no)$/i.test(text)) this.buffered = text;
          return;
        }
        if (this.bot && this.mode === 'announcement') return;
        if (stt.segment.stability === 'final') {
          this.finals.set(stt.segment.segmentId, text);
          this.interim = '';
        } else this.interim = text;
        if (this.bot && !this.interrupted && text.split(/\s+/).length >= 2) {
          this.interrupted = true;
          this.emit({ type: 'interrupt', reason: 'transcript' });
        }
      } else if ((stt.type === 'end-of-turn' && !stt.eager) || stt.type === 'utterance-end') {
        const text = [...this.finals.values(), this.interim].filter(Boolean).join(' ').trim();
        if (text) this.stop(text, this.finals.size);
        this.finals.clear();
        this.interim = '';
      }
    }
  }

  private stop(text: string, segments: number): void {
    const turnId = 'turn-' + ++this.turn;
    this.emit({ type: 'turn.started', turnId });
    this.emit({
      type: 'turn.stopped',
      turnId,
      input: { kind: 'speech', text, segments: Math.max(1, segments) },
    });
  }

  private emit(decision: TurnDecision): void {
    for (const listener of [...this.listeners]) listener(decision);
  }
}
