import type { OperationsService } from '@winsendotai/ovo-plugin-operations';

const terminal = new Set([
  'completed',
  'busy',
  'failed',
  'no-answer',
  'no_answer',
  'canceled',
  'cancelled',
]);

/** Project a verified Twilio call status after the orchestration callback store accepts it. */
export async function projectInboundTerminalStatus(
  operations: OperationsService,
  event: { carrierCallId: string; status: string },
): Promise<boolean> {
  if (!terminal.has(event.status)) return false;
  const released = await operations.inbound.releaseByCarrierCallId(event.carrierCallId);
  if (!released) return false;
  await operations.calls.markTerminalByCarrierCallId(event.carrierCallId);
  return true;
}
