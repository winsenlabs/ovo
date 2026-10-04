/**
 * v1↔v2 speech and media adapters (§2.11). Each has one wave-1 purpose — bridging an existing
 * provider or the current engine — and wave 3 deletes any shim with no caller left.
 */
export { legacyAsStt, sttAsLegacy } from './stt-shims.ts';
export { legacyAsTts, ttsAsLegacy, type LegacyTtsIdentity } from './tts-shims.ts';
export {
  asEndReason,
  duplexFromLegacy,
  legacyFromDuplex,
  type DuplexFromLegacyOptions,
} from './duplex-shims.ts';
