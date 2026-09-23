import {
  bytesPerSecond,
  type EngineEvent,
  type SpeechEvidence,
  type SpeechEvidencePhase,
  type SpeechKind,
  type SpeechKindV2,
  type SpeechReceipt,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import type { EnginePorts } from '../kit/engine-ports.ts';

type MarkOutcome = 'played' | 'timeout' | 'interrupted';

interface ActiveSegment {
  abort: AbortController;
  resolveMark?: (outcome: MarkOutcome) => void;
}

const evidenceKind = (kind: SpeechKindV2): SpeechKind =>
  kind === 'acknowledgment' || kind === 'progress' ? kind : 'response';

/**
 * The reference engine's single media writer. Segments play strictly one after another; every
 * receipt is delivered to the behavior before `speak` resolves and before `bot.stopped`.
 */
export class ReferencePlayback {
  private chain: Promise<unknown> = Promise.resolve();
  private active?: ActiveSegment;
  private readonly marks = new Map<string, (outcome: MarkOutcome) => void>();
  private segments = 0;
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly ports: EnginePorts,
    private readonly emit: (event: EngineEvent) => void,
    private readonly observe: (event: VoiceEvent) => void,
  ) {}

  onPlayed(name: string): void {
    this.marks.get(name)?.('played');
  }

  close(): void {
    this.closed = true;
    void this.interrupt(false);
  }

  speak(
    text: string,
    epoch: number,
    kind: SpeechKindV2,
    stale: () => boolean = () => false,
  ): Promise<SpeechReceipt> {
    const run = this.chain.then(() => this.play(text, epoch, kind, stale));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Barge-in. Pending marks are dropped BEFORE clear, so a flushed mark is never taken as played. */
  async interrupt(clear = true): Promise<void> {
    const active = this.active;
    if (!active) return;
    for (const resolve of this.marks.values()) resolve('interrupted');
    this.marks.clear();
    active.abort.abort();
    if (clear && !this.closed) await this.ports.media.clear().catch(() => undefined);
  }

  private async play(
    text: string,
    epoch: number,
    kind: SpeechKindV2,
    stale: () => boolean,
  ): Promise<SpeechReceipt> {
    const segmentId = `seg-${++this.segments}`;
    const phase = (
      value: SpeechEvidencePhase,
      evidence: SpeechEvidence['evidence'],
      reason?: string,
    ) =>
      this.emit({
        type: 'speech',
        evidence: {
          sequence: ++this.sequence,
          segmentId,
          text,
          epoch,
          kind: evidenceKind(kind),
          phase: value,
          at: this.ports.clock.now(),
          evidence,
          ...(reason ? { reason } : {}),
        },
      });
    phase('generated', 'generated');
    this.emit({ type: 'agent.transcript', segmentId, text, state: 'generated' });
    phase('queued', 'generated');
    if (stale() || this.closed) {
      phase('dropped', 'generated', 'stale epoch');
      return this.finish(
        { id: segmentId, text, epoch, state: 'interrupted', evidence: 'estimated' },
        kind,
        false,
      );
    }
    const abort = new AbortController();
    const active: ActiveSegment = { abort };
    this.active = active;
    this.observe({ type: 'bot.started', epoch, atMs: this.ports.clock.now(), kind });
    let bytes = 0;
    try {
      for await (const chunk of this.ports.tts.synthesize({
        sessionId: this.ports.sessionId,
        text,
        format: this.ports.media.format,
        language: this.ports.session.language,
        ...(this.ports.voice ? { voice: this.ports.voice } : {}),
        kind,
        signal: abort.signal,
        onUsage: this.ports.usage,
      })) {
        if (abort.signal.aborted) break;
        if (bytes === 0) phase('started', 'generated');
        await this.ports.media.sendAudio(chunk, abort.signal);
        bytes += chunk.byteLength;
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        phase('failed', 'estimated', error instanceof Error ? error.message : 'tts failed');
        this.active = undefined;
        return this.finish(
          { id: segmentId, text, epoch, state: 'interrupted', evidence: 'estimated' },
          kind,
          true,
          epoch,
        );
      }
    }
    let outcome: MarkOutcome = 'interrupted';
    if (!abort.signal.aborted) {
      phase('sent', 'estimated');
      outcome = await this.awaitMark(segmentId, bytes, active);
    }
    if (this.active === active) this.active = undefined;
    const receipt = this.receiptFor(segmentId, text, epoch, outcome);
    if (outcome === 'played') phase('acknowledged', receipt.evidence);
    phase(receipt.state === 'completed' ? 'completed' : 'interrupted', receipt.evidence);
    return this.finish(receipt, kind, true, epoch);
  }

  private async awaitMark(
    name: string,
    bytes: number,
    active: ActiveSegment,
  ): Promise<MarkOutcome> {
    const media = this.ports.media;
    const played = new Promise<MarkOutcome>((resolve) => {
      active.resolveMark = resolve;
      this.marks.set(name, resolve);
      const audioMs = (bytes / bytesPerSecond(media.format)) * 1000;
      this.ports.clock.setTimeout(() => resolve('timeout'), audioMs + 1500);
      active.abort.signal.addEventListener('abort', () => resolve('interrupted'), { once: true });
    });
    try {
      await media.mark(name, active.abort.signal);
    } catch {
      return 'interrupted';
    }
    const outcome = await played;
    this.marks.delete(name);
    return outcome;
  }

  /** The §2.5 evidence mapping. */
  private receiptFor(id: string, text: string, epoch: number, outcome: MarkOutcome): SpeechReceipt {
    if (outcome === 'interrupted')
      return { id, text, epoch, state: 'interrupted', evidence: 'estimated' };
    const carrier = this.ports.media.playbackEvidence;
    if (outcome === 'played' && carrier === 'carrier-played')
      return { id, text, epoch, state: 'completed', evidence: 'confirmed' };
    if (
      outcome === 'played' &&
      carrier === 'carrier-processed' &&
      this.ports.session.acknowledgements.includes('weak-playback-evidence')
    )
      return {
        id,
        text,
        epoch,
        state: 'completed',
        evidence: 'confirmed',
        evidenceSource: 'carrier-processed',
      };
    return { id, text, epoch, state: 'completed', evidence: 'estimated' };
  }

  private async finish(
    receipt: SpeechReceipt,
    kind: SpeechKindV2,
    spoke: boolean,
    epoch?: number,
  ): Promise<SpeechReceipt> {
    this.emit({
      type: 'agent.transcript',
      segmentId: receipt.id,
      text: receipt.text,
      state: receipt.state === 'completed' ? 'played' : 'interrupted',
    });
    try {
      await this.ports.behavior.onPlayback?.(receipt);
    } finally {
      if (spoke && epoch !== undefined)
        this.observe({ type: 'bot.stopped', epoch, atMs: this.ports.clock.now(), kind });
    }
    return receipt;
  }
}
