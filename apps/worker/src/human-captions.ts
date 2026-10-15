import { CAPTION_TOPIC } from '@winsendotai/ovo-contracts';
import type { RoomSeat } from './human-contract.ts';
import type { HumanRuntimeDeps } from './human-runtime-deps.ts';
import { HumanTranscriber } from './human-transcriber.ts';

interface CaptionInput {
  deps: HumanRuntimeDeps;
  seat: RoomSeat;
  /** The operator's room identity: the captions go to them alone. */
  operatorIdentity: string;
  /** Also transcribe the operator's track. */
  operator: boolean;
  index: number;
  now(): number;
}

/** Opens the segment's transcriber; undefined when there is no STT or it cannot open (no captions). */
export function openCaptions(input: CaptionInput): Promise<HumanTranscriber | undefined> {
  const { deps } = input;
  if (!deps.openStt || !deps.transcript) return Promise.resolve(undefined);
  const transcript = deps.transcript;
  return HumanTranscriber.open({
    open: deps.openStt,
    usage: deps.usageFor(input.index),
    format: deps.format,
    language: deps.sttLanguage,
    sessionId: deps.call.sessionId,
    idPrefix: `s${input.index}:`,
    operator: input.operator,
    caption: (caption) =>
      input.seat.sendData(CAPTION_TOPIC, new TextEncoder().encode(JSON.stringify(caption)), [
        input.operatorIdentity,
      ]),
    transcript: (event) => transcript(event, input.index),
    now: input.now,
    failed: (reason) => deps.audit('human.transcribe.failed', { reason }),
  });
}
