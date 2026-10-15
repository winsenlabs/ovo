import { createHash } from 'node:crypto';
import type { SipHandoffResponse } from '@winsendotai/ovo-sip-carrier-kit';
import type { SipRequest } from '../sip/message.ts';
import type { Call } from './call.ts';

export type ReferResult = SipHandoffResponse;

const SIPFRAG_STATUS = /^SIP\/2\.0\s+(\d{3})\b/;

/** 408 and 503 are the statuses where asking again can help; the rest are the far end's decision. */
const retryable = (status: number) => status === 408 || status === 503;

/**
 * One REFER in flight on a call (RFC 3515): sent in-dialog, answered 202, then tracked by the
 * `message/sipfrag` NOTIFYs of its implicit `refer` subscription. A 2xx sipfrag means the far end
 * placed the transferred call, so we BYE; anything final that is not 2xx leaves the caller with us.
 */
export class ReferState {
  accepted = false;
  /** The CSeq of the REFER, which is the `id` of its subscription. */
  cseq = 0;
  private result?: ReferResult;
  private resolve!: (result: ReferResult) => void;
  readonly done = new Promise<ReferResult>((resolve) => (this.resolve = resolve));

  constructor(
    private readonly call: Call,
    readonly requestId: string,
    private readonly host: string,
  ) {}

  get settled(): boolean {
    return this.result !== undefined;
  }

  /** The first result wins. A transferred (or probably transferred) leg ends the call here. */
  settle(result: ReferResult, source: string): void {
    if (this.result) return;
    this.result = result;
    this.call.timers.stop('refer');
    const { call } = this;
    call.host.logger.info('sip.refer', {
      ...call.logFields,
      requestId: this.requestId,
      referHost: this.host,
      result: result.kind,
      reason: result.kind === 'confirmed' ? undefined : result.reason,
      source,
    });
    // A rejection keeps the dialog and frees the slot for another attempt.
    if (result.kind === 'rejected') call.refer = undefined;
    this.resolve(result);
    if (result.kind === 'confirmed' || (result.kind === 'unknown' && this.accepted))
      call.end('transferred', { bye: true, stream: 'transferred' });
  }

  /** The call ended under a pending REFER (the far end's BYE often beats the last NOTIFY). */
  callEnded(reason: string): void {
    this.settle(
      this.accepted
        ? { kind: 'unknown', reason: 'refer_call_ended' }
        : { kind: 'rejected', reason: `call_ended_${reason}`.slice(0, 256), retryable: false },
      'call_end',
    );
  }

  /** A NOTIFY for this subscription; the caller has validated the Event header. */
  progress(status: number, terminated: boolean): void {
    if (status >= 200 && status < 300)
      this.settle(
        {
          kind: 'confirmed',
          receiptId: `sip-refer:${createHash('sha256')
            .update(`${this.call.callId}|${this.requestId}`)
            .digest('hex')
            .slice(0, 32)}`,
        },
        'notify',
      );
    else if (status >= 300)
      this.settle(
        { kind: 'rejected', reason: `refer_failed_${status}`, retryable: retryable(status) },
        'notify',
      );
    else if (terminated)
      this.settle({ kind: 'unknown', reason: 'refer_subscription_ended' }, 'notify');
  }
}

/**
 * Sends the REFER for `referTo` and resolves when its fate is known. Repeating the same
 * `requestId` while it is in flight joins it; a different one is refused (`refer_in_progress`).
 */
export function requestRefer(
  call: Call,
  input: { requestId: string; referTo: string; host: string },
): Promise<ReferResult> {
  if (call.refer)
    return call.refer.requestId === input.requestId
      ? call.refer.done
      : Promise.resolve({ kind: 'rejected', reason: 'refer_in_progress', retryable: true });
  const state = new ReferState(call, input.requestId, input.host);
  call.refer = state;
  call.timers.start('refer', call.host.config.referTimeoutMs, () =>
    state.settle(
      state.accepted
        ? { kind: 'unknown', reason: 'refer_no_notify' }
        : { kind: 'unknown', reason: 'refer_no_response' },
      'timeout',
    ),
  );
  const sent = call.sendInDialog('REFER', [
    ['Refer-To', `<${input.referTo}>`],
    ['Referred-By', `<sip:ovo@${call.host.config.advertisedHost}>`],
  ]);
  // The request was built synchronously, so this is the REFER's CSeq.
  state.cseq = call.dialog?.localSeq ?? 0;
  void sent.then((response) => {
    if (state.settled) return;
    if (!response)
      return state.settle({ kind: 'unknown', reason: 'refer_no_response' }, 'no_response');
    if (response.status >= 300)
      return state.settle(
        {
          kind: 'rejected',
          reason: `refer_declined_${response.status}`,
          retryable: retryable(response.status),
        },
        'response',
      );
    state.accepted = true;
  });
  return state.done;
}

/**
 * The answer to a NOTIFY on `call`: 200 when it belongs to the REFER in flight and carries a
 * sipfrag status line, else 481 (no such subscription) or 400 (not a sipfrag). RFC 6665 §4.4.1.
 */
export function referNotify(call: Call, request: SipRequest): number {
  const state = call.refer;
  // `Event: refer;id=<CSeq of the REFER>`, other parameters allowed in any order.
  const event = /^refer\s*((?:;[^;]*)*)$/i.exec(request.headers.get('event') ?? '');
  const id = /;\s*id\s*=\s*(\d+)\s*(?:;|$)/i.exec(event?.[1] ?? '')?.[1];
  if (!state || state.settled || !event || (id !== undefined && Number(id) !== state.cseq))
    return 481;
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const status = SIPFRAG_STATUS.exec(Buffer.from(request.body).toString('utf8').trimStart())?.[1];
  if (type !== 'message/sipfrag' || !status) return 400;
  state.progress(
    Number(status),
    /^terminated\b/i.test(request.headers.get('subscription-state') ?? ''),
  );
  return 200;
}
