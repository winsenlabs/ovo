import type { AgentSession, voice } from '@livekit/agents';
import {
  TRANSFER_REASON_PREFIX,
  type EndReason,
  type Speech,
  type SpeechReceipt,
  type SpeechSegment,
} from '@winsendotai/ovo-contracts';
import type { CarrierAudioOutput } from './carrier-output.ts';
import type { Evidence } from './evidence.ts';
import type { SttGate } from './stt-gate.ts';
import type { LiveKitPorts } from './types.ts';

async function* single(value: Promise<string>) {
  yield await value;
}
export class TurnDriver implements Speech {
  private turns: Promise<void> = Promise.resolve();
  private playback: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private counter = 0;
  private stopped = false;
  private cancelled = false;
  /** Set once an answering machine took the call; no new turn starts. */
  private closing = false;
  private active?: { segment: SpeechSegment; handle: voice.SpeechHandle; confirmation: boolean };
  current?: SpeechSegment;
  /** Called after every turn that leaves the call open: the caller's silence starts now. */
  onSettled: () => void = () => {};
  /** Called when the caller says or keys anything. */
  onCaller: () => void = () => {};
  constructor(
    private readonly ports: LiveKitPorts,
    private readonly session: AgentSession,
    private readonly output: CarrierAudioOutput,
    private readonly evidence: Evidence,
    private readonly dispose: (reason: EndReason) => void,
    private readonly gate: SttGate,
  ) {}
  /**
   * One behaviour turn. `extra` carries an engine event (`opening`, `idle`) the way the native
   * engine passes it, so the behaviour cannot tell the engines apart.
   */
  enqueue(
    text: string,
    input: 'speech' | 'dtmf' = 'speech',
    extra: Record<string, unknown> = {},
  ): void {
    if (this.stopped || this.closing) return;
    if (!extra.inputEvent) this.onCaller();
    this.turns = this.turns
      .then(async () => {
        await this.playback;
        if (this.stopped || this.closing) return;
        const turnId = `turn-${++this.epoch}`;
        if (!extra.inputEvent) {
          this.evidence.emit({ type: 'user.turn', phase: 'started', turnId, input });
          this.evidence.emit({ type: 'user.turn', phase: 'stopped', turnId, input, text });
        }
        this.cancelled = false;
        const { behavior } = this.ports;
        behavior.beginTurn?.(this.epoch);
        const variables = {
          ...structuredClone(this.ports.session.variables),
          ...(input === 'dtmf' ? { inputEvent: 'dtmf', digits: text } : {}),
          ...extra,
        };
        const stream = behavior.respondStream
          ? behavior.respondStream(text, variables)
          : single(behavior.respond(text, variables));
        for await (const segment of stream) {
          if (this.stopped || this.cancelled) break;
          if (segment.trim()) {
            const receipt = await this.speak(segment, { epoch: this.epoch, kind: 'response' });
            if (receipt.state === 'interrupted') break;
          }
        }
        if (!behavior.isComplete?.()) return this.onSettled();
        // AGT-15: a transfer hands the carrier leg on; an idle turn that ends is the caller's silence.
        const reason = behavior.completionReason?.();
        this.dispose(
          reason?.startsWith(TRANSFER_REASON_PREFIX)
            ? 'transferred'
            : extra.inputEvent === 'idle'
              ? 'caller_idle'
              : 'behavior_completed',
        );
      })
      .catch(() => {
        if (!this.stopped && !this.cancelled) this.dispose('error:livekit-behavior');
      });
  }
  /**
   * An answering machine picked up: whatever is playing is cut, the message (if any) is left, and
   * the call ends as `voicemail`. False when the behaviour does not handle voicemail.
   */
  voicemail(): boolean {
    if (this.stopped || this.closing) return false;
    let message: string | undefined;
    try {
      message = this.ports.behavior.voicemail?.(structuredClone(this.ports.session.variables));
    } catch {
      // swallow-ok: a message that cannot render is not left; the machine still gets no call.
      message = '';
    }
    if (message === undefined) return false;
    this.closing = true;
    // Cuts a reply still being composed as well as one playing.
    this.cancelled = true;
    this.ports.behavior.cancel?.();
    void this.interrupt();
    const text = message.trim();
    void this.playback
      .then(() => (text ? this.speak(text, { epoch: ++this.epoch, kind: 'response' }) : undefined))
      .catch(() => undefined)
      .then(() => this.dispose('voicemail'));
    return true;
  }
  speak(text: string, options?: Parameters<Speech['speak']>[1]): Promise<SpeechReceipt> {
    const work = this.playback.then(() => this.play(text, options));
    this.playback = work.catch(() => undefined);
    return work;
  }
  private async play(
    raw: string,
    options?: Parameters<Speech['speak']>[1],
  ): Promise<SpeechReceipt> {
    if (this.stopped) throw new Error('LiveKit turn driver is closed');
    // The session's text filters (the Indian verbalisation), lowest order first, as natively.
    const text = filtered(this.ports, raw);
    const segment: SpeechSegment = {
      id: `livekit-${++this.counter}`,
      text,
      epoch: options?.epoch ?? this.epoch,
      kind: options?.kind ?? 'progress',
      generatedAt: this.ports.clock.now(),
    };
    this.current = segment;
    this.evidence.phase(segment, 'generated');
    this.evidence.phase(segment, 'queued');
    const receipt = this.output.begin(segment);
    const kind = this.ports.behavior.speechKind?.(raw);
    const confirmation = kind === 'confirmation' || kind === 'disclosure';
    this.gate.set(kind === 'confirmation' ? 'buffer' : kind === 'disclosure' ? 'discard' : 'open');
    const handle = this.session.say(text, {
      addToChatCtx: false,
      allowInterruptions: !confirmation,
    });
    this.active = { segment, handle, confirmation };
    try {
      await handle.waitForPlayout();
      if (handle.interrupted) {
        this.cancelled = true;
        this.ports.behavior.cancel?.();
        this.output.finish(true, false);
      }
      // Empty/failed synthesis cannot manufacture a completed receipt.
      this.output.finish(true, false);
      const value = await receipt;
      await this.ports.behavior.onPlayback?.(value);
      return value;
    } finally {
      this.active = undefined;
      this.current = undefined;
      this.gate.set('open');
    }
  }
  onTranscript(text: string, minWords: number): void {
    if (text.trim()) this.onCaller();
    if (this.active && !this.active.confirmation && text.trim().split(/\s+/).length >= minWords)
      void this.interrupt();
  }
  async interrupt(): Promise<void> {
    if (!this.active || this.stopped) return;
    this.cancelled = true;
    this.ports.behavior.cancel?.();
    this.evidence.emit({ type: 'interrupt', reason: 'transcript' });
    this.output.clearBuffer();
    this.active.handle.interrupt(true);
  }
  stop(): void {
    this.gate.close();
    this.stopped = true;
    this.cancelled = true;
    try {
      this.ports.behavior.cancel?.();
    } finally {
      this.output.close();
    }
  }
}

function filtered(ports: LiveKitPorts, text: string): string {
  const filters = [...(ports.textFilters ?? [])].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  for (const filter of filters) text = filter.apply(text, { language: ports.session.language });
  return text;
}
