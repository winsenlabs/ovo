import type {
  AudioFormat,
  EndReason,
  MediaDuplex,
  PlaybackEvidence,
  VoiceMediaTransport,
} from '@winsendotai/ovo-contracts';

const END_REASONS: ReadonlySet<string> = new Set([
  'behavior_completed',
  'caller_hangup',
  'caller_idle',
  'voicemail',
  'max_duration',
  'transferred',
  'ownership_lost',
  'drain',
  'superseded',
]);

/** A v1 free-form close reason as a typed EndReason. Unknown reasons become `error:<reason>`. */
export function asEndReason(reason: string): EndReason {
  if (END_REASONS.has(reason) || reason.startsWith('error:')) return reason as EndReason;
  if (/\b(stop|stopped|hang ?up|hangup|caller|callended|stream ended)\b/i.test(reason))
    return 'caller_hangup';
  return `error:${reason}`;
}

export interface DuplexFromLegacyOptions {
  carrierId?: string;
  clearFlushesMarkers?: boolean | 'unknown';
  mapReason?: (reason: string) => EndReason;
}

/**
 * v1 transport → MediaDuplex (§2.5). A v1 transport has no `cleared` event, so `onCleared`
 * fires once the transport's own `clear()` resolves.
 */
export function duplexFromLegacy(
  transport: VoiceMediaTransport,
  format: AudioFormat,
  playbackEvidence: PlaybackEvidence,
  options: DuplexFromLegacyOptions = {},
): MediaDuplex {
  const cleared = new Set<() => void>();
  const mapReason = options.mapReason ?? asEndReason;
  return {
    get sessionId() {
      return transport.sessionId;
    },
    carrierId: options.carrierId ?? 'legacy',
    format,
    playbackEvidence,
    clearFlushesMarkers: options.clearFlushesMarkers ?? 'unknown',
    get bufferedBytes() {
      return transport.bufferedBytes;
    },
    sendAudio: (bytes, signal) => transport.sendAudio(bytes, signal),
    mark: (name, signal) => transport.sendMark(name, signal),
    async clear(signal) {
      await transport.clear(signal);
      for (const listener of [...cleared]) listener();
    },
    onAudio: (fn) => transport.onAudio(fn),
    onPlayed: (fn) => transport.onMark(fn),
    onCleared(fn) {
      cleared.add(fn);
      return () => {
        cleared.delete(fn);
      };
    },
    onDtmf: (fn) => transport.onDtmf(fn),
    onClose: (fn) => transport.onClose((reason) => fn(mapReason(reason))),
    close: (reason) => transport.close(reason),
  };
}

/** MediaDuplex → v1 transport, for engines that still speak v1 (§2.11). */
export function legacyFromDuplex(duplex: MediaDuplex): VoiceMediaTransport {
  return {
    get sessionId() {
      return duplex.sessionId;
    },
    get bufferedBytes() {
      return duplex.bufferedBytes;
    },
    sendAudio: (audio, signal) => duplex.sendAudio(audio, signal),
    sendMark: (name, signal) => duplex.mark(name, signal),
    clear: (signal) => duplex.clear(signal),
    onAudio: (listener) => duplex.onAudio(listener),
    onMark: (listener) => duplex.onPlayed(listener),
    onDtmf: (listener) => duplex.onDtmf(listener),
    onClose: (listener) => duplex.onClose((reason) => listener(reason)),
    close: (reason) => duplex.close(asEndReason(reason)),
  };
}
