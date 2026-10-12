/**
 * Why a speech turn ended (Wave 8), recorded per turn so endpoint latency can be attributed:
 * - `complete`, `silence`, `long`, `unfinished`: the commit after the VAD went quiet, by how the
 *   words end (a complete sentence or answer; no signal, short or long; trailing off: "and",
 *   "to the", a comma, a mid-word "-", "around the 1");
 * - `answer`: a short complete answer ("Yes.", "हाँ।") no VAD speech was timing, committed soon
 *   after its interim;
 * - `stall`: the interim stopped changing while the VAD still heard sound;
 * - `noise`: the VAD went on hearing sound that brought no new words (the room);
 * - `final`: the STT's final arrived after the VAD went quiet, before the commit;
 * - `ceiling`: no final arrived within the wait after the commit; the turn ended on the interim;
 * - `hold`: words that trailed off waited for more that never came;
 * - `pause` (Wave 9): words that stopped mid-thought, on a hesitation, an article or a preposition
 *   ("No, umm...", "it should still be a"), waited the longer pause for more that never came;
 * - `agent`: words said over the agent waited for it to stop (an answer to its question);
 * - `vad-timeout`, `provider`: the other stop strategies; `safety`: the stop safety timer.
 */
export const ENDPOINT_RULES = [
  'complete',
  'silence',
  'long',
  'unfinished',
  'answer',
  'stall',
  'noise',
  'final',
  'ceiling',
  'hold',
  'pause',
  'agent',
  'vad-timeout',
  'provider',
  'safety',
] as const;
export type EndpointRule = (typeof ENDPOINT_RULES)[number];
