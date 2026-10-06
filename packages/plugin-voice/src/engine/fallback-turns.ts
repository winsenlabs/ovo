import {
  isBackchannel,
  TurnConfigSchema,
  type Mode,
  type TurnDecision,
  type UserTurnController,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';

/** The default backchannel words and minimum words while the agent speaks (AGT-9). */
const BACKCHANNELS = TurnConfigSchema.parse({});

/** Small provider-signal fallback when no ovo.turn-detector is selected. */
export class FallbackTurns implements UserTurnController {
  private readonly listeners = new Set<(decision: TurnDecision) => void>();
  private finals = new Map<string, string>();
  private interim = '';
  private digits = '';
  private turn = 0;
  /** The id of the utterance in progress, once it has been announced (LAT-4). */
  private open?: string;
  private bot?: { epoch: number; kind?: string; question?: boolean };
  private buffered?: string;
  private interrupted = false;
  private disposed = false;

  constructor(
    private readonly mode: Mode,
    private readonly language = 'en-US',
  ) {}

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
      // The same interval is announced again when a later line asks a question.
      if (this.bot?.epoch !== event.epoch) this.interrupted = false;
      this.bot = { epoch: event.epoch, kind: event.kind, question: event.question };
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
        const heard = this.heard();
        if (this.bot && !this.interrupted && !isBackchannel(heard, this.language, BACKCHANNELS)) {
          this.interrupted = true;
          this.emit({ type: 'interrupt', reason: 'transcript' });
        }
        if (heard && (!this.bot || this.interrupted)) {
          this.open ??= 'turn-' + ++this.turn;
          this.emit({
            type: 'turn.partial',
            turnId: this.open,
            text: heard,
            stable: !this.interim,
          });
        }
      } else if ((stt.type === 'end-of-turn' && !stt.eager) || stt.type === 'utterance-end') {
        const text = this.heard();
        const segments = this.finals.size;
        this.finals.clear();
        this.interim = '';
        if (!text) return;
        // AGT-9: a backchannel over the agent is no turn, unless the agent asked something.
        if (this.bot && !this.interrupted && isBackchannel(text, this.language, BACKCHANNELS)) {
          if (this.bot.question) this.buffered = text;
          else if (this.open) {
            this.emit({ type: 'turn.reset', turnId: this.open, reason: 'backchannel' });
            this.open = undefined;
          }
          return;
        }
        this.stop(text, segments);
      }
    }
  }

  private heard(): string {
    return [...this.finals.values(), this.interim].filter(Boolean).join(' ').trim();
  }

  private stop(text: string, segments: number): void {
    const turnId = this.open ?? 'turn-' + ++this.turn;
    this.open = undefined;
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
