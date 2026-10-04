import type { EngineEvent, TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';

type Listener<T> = (event: T) => void;

/** Synchronous delivery. Nested control events wait until system events have drained. */
export class VoiceEventBus {
  private readonly events = new Set<Listener<VoiceEvent>>();
  private readonly decisions = new Set<Listener<TurnDecision>>();
  private readonly engine = new Set<Listener<EngineEvent>>();
  private readonly system: VoiceEvent[] = [];
  private readonly control: VoiceEvent[] = [];
  private dispatching = false;

  onEvent(listener: Listener<VoiceEvent>): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  onDecision(listener: Listener<TurnDecision>): () => void {
    this.decisions.add(listener);
    return () => this.decisions.delete(listener);
  }

  onEngine(listener: Listener<EngineEvent>): () => void {
    this.engine.add(listener);
    return () => this.engine.delete(listener);
  }

  observe(event: VoiceEvent): void {
    const priority =
      event.type === 'stt' ||
      event.type === 'vad.start' ||
      event.type === 'vad.stop' ||
      event.type === 'bot.started' ||
      event.type === 'bot.stopped';
    (priority ? this.system : this.control).push(event);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.system.length || this.control.length) {
        const next = this.system.shift() ?? this.control.shift()!;
        for (const listener of [...this.events]) listener(next);
      }
    } finally {
      this.dispatching = false;
    }
  }

  decide(decision: TurnDecision): void {
    for (const listener of [...this.decisions]) listener(decision);
  }

  emit(event: EngineEvent): void {
    for (const listener of [...this.engine]) listener(event);
  }

  clear(): void {
    this.system.length = 0;
    this.control.length = 0;
    this.events.clear();
    this.decisions.clear();
    this.engine.clear();
  }
}
