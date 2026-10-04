import type { EngineEvent } from '../voice/engine.ts';
import type { MediaDuplex } from '../voice/media.ts';

/** Wraps the session's media for recording and takes speech evidence from the engine's events. */
export interface RecordingTap {
  wrap(media: MediaDuplex): MediaDuplex;
  attach(events: { subscribe(fn: (event: EngineEvent) => void): () => void }): void;
}
