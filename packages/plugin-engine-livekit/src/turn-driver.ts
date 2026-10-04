import type { AgentSession, voice } from '@livekit/agents';
import type { EndReason, Speech, SpeechReceipt, SpeechSegment } from '@winsendotai/ovo-contracts';
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
  private active?: { segment: SpeechSegment; handle: voice.SpeechHandle; confirmation: boolean };
  current?: SpeechSegment;
  constructor(
    private readonly ports: LiveKitPorts,
    private readonly session: AgentSession,
    private readonly output: CarrierAudioOutput,
    private readonly evidence: Evidence,
    private readonly dispose: (reason: EndReason) => void,
    private readonly gate: SttGate,
  ) {}
  enqueue(text: string, input: 'speech' | 'dtmf' = 'speech'): void {
    if (this.stopped) return;
    this.turns = this.turns
      .then(async () => {
        await this.playback;
        if (this.stopped) return;
        const turnId = `turn-${++this.epoch}`;
        this.evidence.emit({ type: 'user.turn', phase: 'started', turnId, input });
        this.evidence.emit({ type: 'user.turn', phase: 'stopped', turnId, input, text });
        this.cancelled = false;
        const { behavior } = this.ports;
        behavior.beginTurn?.(this.epoch);
        const variables = {
          ...structuredClone(this.ports.session.variables),
          ...(input === 'dtmf' ? { inputEvent: 'dtmf', digits: text } : {}),
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
        if (behavior.isComplete?.()) this.dispose('behavior_completed');
      })
      .catch(() => {
        if (!this.stopped && !this.cancelled) this.dispose('error:livekit-behavior');
      });
  }
  speak(text: string, options?: Parameters<Speech['speak']>[1]): Promise<SpeechReceipt> {
    const work = this.playback.then(() => this.play(text, options));
    this.playback = work.catch(() => undefined);
    return work;
  }
  private async play(
    text: string,
    options?: Parameters<Speech['speak']>[1],
  ): Promise<SpeechReceipt> {
    if (this.stopped) throw new Error('LiveKit turn driver is closed');
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
    const kind = this.ports.behavior.speechKind?.(text);
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
