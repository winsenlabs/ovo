import type {
  EngineEvent,
  SessionInput,
  TextFilter,
  TranscriptObserver,
} from '@winsendotai/ovo-contracts';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { VoiceEventBus } from './events.ts';
import type { TurnLatency } from './latency.ts';
import type { SpeechEventProjector } from './speech-events.ts';
import type { createTurnController } from './turn-controller-host.ts';

/** Points the scheduler at this session: pipeline depth, output limits, timing and text filters. */
export function configureScheduler(
  scheduler: BoundedSpeechScheduler,
  session: SessionInput,
  engine: { prefetchSegments?: number; maxPrefetchBytes?: number; markTimeoutMs?: number } = {},
  textFilters: readonly TextFilter[] = [],
  speechEvents: SpeechEventProjector,
): void {
  scheduler.configurePipeline(engine.prefetchSegments ?? 2);
  scheduler.configureSession(session);
  scheduler.configureOutput({
    maxPrefetchBytes: engine.maxPrefetchBytes,
    markTimeoutMs: engine.markTimeoutMs,
  });
  scheduler.configureTiming((phase, segment, elapsedMs) =>
    speechEvents.onTiming(phase, segment, elapsedMs),
  );
  scheduler.configureFilters(textFilters, session.language);
}

/**
 * Feeds every voice bus event to the turn controller, and projects caller transcripts into engine
 * events and latency marks.
 */
export function projectBusEvents(
  bus: VoiceEventBus,
  latency: TurnLatency,
  turnController: ReturnType<typeof createTurnController>,
  emit: (event: EngineEvent) => void,
): () => void {
  return bus.onEvent((event) => {
    if (event.type === 'vad.stop') latency.noteVadStop();
    if (event.type === 'stt' && event.event.type === 'transcript') {
      const segment = event.event.segment;
      if (segment.stability === 'final') latency.noteFinalStt();
      emit({
        type: 'user.transcript',
        turnId: segment.segmentId,
        segmentId: segment.segmentId,
        text: segment.text,
        stability: segment.stability,
      });
    }
    turnController.observe(event);
  });
}

/** What an engine reports before its ingress exists (input disabled, or not started yet). */
export function emptyIngressStats() {
  return { acceptedFrames: 0, acceptedBytes: 0, pendingFrames: 0, pendingBytes: 0, overflows: 0 };
}

/** Hands a transcript event to the observer. Inspection is never voice business authority. */
export function observeTranscript(
  observer: TranscriptObserver | undefined,
  event: EngineEvent,
  failed: (error: unknown) => void,
): void {
  if (event.type !== 'user.transcript' && event.type !== 'agent.transcript') return;
  try {
    observer?.(event);
  } catch (error) {
    failed(error);
  }
}
