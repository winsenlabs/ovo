import { voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { MediaDuplex, SpeechReceipt, SpeechSegment } from '@winsendotai/ovo-contracts';
import { encode } from './codec.ts';
import type { Evidence } from './evidence.ts';

interface Pending {
  segment: SpeechSegment;
  resolve: (receipt: SpeechReceipt) => void;
  captured: boolean;
  sent: boolean;
  seconds: number;
  cancelTimer?: () => void;
}
/** Single writer. Acknowledgements are correlated to the active segment, never inferred from clear. */
export class CarrierAudioOutput extends voice.AudioOutput {
  private active?: Pending;
  private readonly detachPlayed: () => void;
  private readonly detachCleared: () => void;
  constructor(
    private readonly media: MediaDuplex,
    private readonly evidence: Evidence,
    private readonly weakAcknowledged: boolean,
    private readonly timeoutMs = 2000,
    private readonly failed: () => void = () => {},
  ) {
    super(8000);
    this.detachPlayed = media.onPlayed((name) => {
      if (this.active?.segment.id === name && this.active.sent) this.finish(false, true);
    });
    this.detachCleared = media.onCleared(() => this.finish(true, false));
  }
  begin(segment: SpeechSegment): Promise<SpeechReceipt> {
    if (this.active) throw new Error('LiveKit output already has an active segment');
    return new Promise((resolve) => {
      this.active = { segment, resolve, captured: false, sent: false, seconds: 0 };
    });
  }
  override async captureFrame(frame: AudioFrame): Promise<void> {
    const active = this.active;
    if (!active || frame.userdata.segmentId !== active.segment.id) return;
    await super.captureFrame(frame);
    if (!active.captured) {
      active.captured = true;
      this.evidence.phase(active.segment, 'started');
      this.onPlaybackStarted(this.evidence.clock.now());
    }
    await this.media.sendAudio(encode(frame, this.media.format));
    if (this.active !== active) return;
    active.seconds += frame.samplesPerChannel / frame.sampleRate;
  }
  override flush(): void {
    super.flush();
    const active = this.active;
    if (!active || active.sent || !active.captured) return;
    active.sent = true;
    this.evidence.phase(active.segment, 'sent');
    active.cancelTimer = this.evidence.clock.setTimeout(
      () => this.finish(false, false),
      active.seconds * 1000 + this.timeoutMs,
    );
    void this.media.mark(active.segment.id).catch(() => {
      this.finish(true, false);
      this.failed();
    });
  }
  clearBuffer(): void {
    // Cancel correlation before clear: Twilio can synchronously flush cancelled marks.
    this.finish(true, false);
    this.abandonOpenSegment();
    void this.media.clear().catch(this.failed);
  }
  finish(interrupted: boolean, acknowledged: boolean): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.cancelTimer?.();
    const strong =
      acknowledged &&
      (this.media.playbackEvidence === 'carrier-played' ||
        (this.media.playbackEvidence === 'carrier-processed' && this.weakAcknowledged));
    const evidence = !interrupted && strong ? 'confirmed' : 'estimated';
    if (!interrupted && acknowledged) this.evidence.phase(active.segment, 'acknowledged', evidence);
    this.evidence.phase(active.segment, interrupted ? 'interrupted' : 'completed', evidence);
    const receipt: SpeechReceipt = {
      id: active.segment.id,
      text: active.segment.text,
      epoch: active.segment.epoch,
      state: interrupted ? 'interrupted' : 'completed',
      evidence,
      ...(strong && this.media.playbackEvidence === 'carrier-processed'
        ? { evidenceSource: 'carrier-processed' as const }
        : {}),
    };
    active.resolve(receipt);
    if (active.captured)
      this.onPlaybackFinished({ interrupted, playbackPosition: interrupted ? 0 : active.seconds });
  }
  close(): void {
    this.finish(true, false);
    try {
      this.detachPlayed();
    } finally {
      this.detachCleared();
    }
  }
}
