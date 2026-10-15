import type { HumanExternalAttempt } from './human-external.ts';
import type { CheckedTarget } from '@winsendotai/ovo-contracts';
import { humanRelease } from './human-attempt.ts';
import type { QueueSnapshot } from './human-contract.ts';
import { humanState } from './human-events.ts';
import type { CarrierHandoffResult, DynamicHandoffTarget } from './human-runtime.ts';
import { SegmentStats } from './segment-telemetry.ts';
import type { StartableSegment } from './transfer-attempt.ts';

const HEADER_VALUE = /[^\x20-\x7e]/g;
/** SIP header values are printable ASCII and at most this long (human queue design 4.2). */
const HEADER_VALUE_MAX = 256;

function headerValue(value: string | undefined): string | undefined {
  const clean = value?.replace(HEADER_VALUE, '').trim().slice(0, HEADER_VALUE_MAX);
  return clean ? clean : undefined;
}

/**
 * The context a SIP transfer carries (design 7.8): `X-OVO-*` ids and, when the queue's policy
 * allows them, the language and intent, plus the context link a third party fetches the rest
 * with, then the answer's own allow-listed headers (which can never override an `X-OVO-*` name).
 */
export function sipContextHeaders(input: {
  callId: string;
  ticketId: string;
  language?: string;
  intent?: string;
  contextUrl?: string;
  answered: Readonly<Record<string, string>>;
}): Record<string, string> {
  const ours: [string, string | undefined][] = [
    ['X-OVO-Call-Id', headerValue(input.callId)],
    ['X-OVO-Ticket', headerValue(input.ticketId)],
    ['X-OVO-Language', headerValue(input.language)],
    ['X-OVO-Intent', headerValue(input.intent)],
    ['X-OVO-Context-Url', headerValue(input.contextUrl)],
  ];
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.answered))
    if (!/^x-ovo-/i.test(name)) headers[name] = value;
  for (const [name, value] of ours) if (value) headers[name] = value;
  return headers;
}

/** A checked destination as the carrier's handoff target: a phone number carries no headers. */
export function handoffTarget(
  destination: CheckedTarget,
  headers: Record<string, string>,
): DynamicHandoffTarget {
  return destination.kind === 'phone'
    ? { kind: 'phone', e164: destination.e164 }
    : { kind: 'sip', uri: destination.uri, headers };
}

/** The sanitised reason a carrier refusal is recorded with (a code, never carrier text). */
function refusalCode(reason: string): string {
  return (
    reason
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 40) || 'rejected'
  );
}

/**
 * The external queue's segment (design 7.4 step 4): not a graph, a carrier transfer. `start` asks
 * the carrier to move the live leg to the answered destination before the session ends; a refusal
 * throws, which the controller turns into `start_failed` with the caller still on the line and the
 * chain moving on. A confirmed (or unknown) handoff releases the ticket `handed_off`, and once the
 * controller has attached the segment the session ends `transferred` without a hang-up.
 */
export class ExternalHandoffSegment implements StartableSegment {
  readonly kind = 'human';
  readonly release: StartableSegment['release'];
  readonly stats: SegmentStats;
  readonly entryInfo: NonNullable<StartableSegment['entryInfo']>;
  ending?: 'carrier_transfer';
  handedOff = false;
  /** The carrier was asked to move the leg; its answer may arrive after the session has closed. */
  private moving = false;

  constructor(
    private readonly attempt: HumanExternalAttempt,
    private readonly input: {
      index: number;
      queue: QueueSnapshot;
      ticketId: string;
      language: string;
      destination: CheckedTarget;
      headers: Record<string, string>;
      handoff(target: DynamicHandoffTarget, ticketId: string): Promise<CarrierHandoffResult>;
      markHandedOff(): Promise<void>;
      endHandedOff(): Promise<void>;
      record(type: string, payload: Record<string, unknown>): void;
    },
  ) {
    this.release = humanRelease(input.queue, input.language);
    this.stats = new SegmentStats(input.index, input.language);
    this.entryInfo = { ticketId: input.ticketId, queueKind: 'external' };
  }

  async start(): Promise<void> {
    const { input } = this;
    const target = handoffTarget(input.destination, input.headers);
    this.moving = true;
    const result = await input.handoff(target, input.ticketId).catch((error: unknown) => {
      this.moving = false;
      throw error;
    });
    if (result.kind === 'rejected') {
      this.moving = false;
      throw new Error(`carrier_refused:${refusalCode(result.reason)}`);
    }
    this.handedOff = true;
    this.ending = 'carrier_transfer';
    input.record(
      'human.state',
      humanState(input.ticketId, 'handed_off', {
        by: 'worker',
        ...(result.kind === 'unknown' ? { code: 'unknown_receipt' } : {}),
      }),
    );
    // swallow-ok: the release below carries the outcome; the mark only opens the callback window.
    await input.markHandedOff().catch(() => undefined);
    await this.attempt.endConnected('handed_off', 'handed_off');
  }

  /** The controller has attached the segment: the leg now belongs to the destination. */
  attached(): void {
    // swallow-ok: ending the session is the call's own cleanup; a failure is its to report.
    void this.input.endHandedOff().catch(() => undefined);
  }

  async close(): Promise<undefined> {
    if (!this.handedOff && !this.moving) await this.attempt.dispose('abandoned', 'failed');
    return undefined;
  }
}
