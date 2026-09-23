import type {
  CallState,
  CarrierControlFactory,
  CarrierHttpRequest,
  CarrierHttpRoute,
  CarrierIngress,
  DialRequest,
  DialResult,
  HangupQuery,
  NetFixtureScript,
  NetPort,
  ResolvedBinding,
  UpgradeRequest,
} from '@winsendotai/ovo-contracts';
import type { FakeHostPorts } from '../drivers/carrier-host-ports.ts';
import type { JsonlFixture } from '../drivers/jsonl.ts';

export type CarrierFactory = (env: {
  net: NetPort;
}) =>
  | { control: CarrierControlFactory; ingress: CarrierIngress }
  | Promise<{ control: CarrierControlFactory; ingress: CarrierIngress }>;

type Purpose = CarrierHttpRoute['purpose'];

export interface CarrierKitOptions {
  binding: ResolvedBinding;
  /** jsonl transcripts: 'in' frames are decoded; 'out' lines with `command` are encoded and compared. */
  transcripts?: { fixture: JsonlFixture; params?: Record<string, string> }[];
  rest?: {
    dial: {
      scripts: NetFixtureScript[];
      request?: Partial<DialRequest>;
      expect?: DialResult['kind'];
    };
    hangup?: {
      scripts: NetFixtureScript[];
      query: HangupQuery;
      expect: 'ended' | 'already_ended' | 'unsupported';
    };
    /** Required when `control.cancelBeforeAnswer`: hangup by `carrierRequestId`. */
    cancel?: { scripts: NetFixtureScript[]; carrierRequestId: string };
  };
  /** Signature vectors: at least one valid and one invalid request. */
  vectors?: {
    http?: { purpose: Purpose; request: CarrierHttpRequest; valid: boolean; label?: string }[];
    upgrade?: { request: UpgradeRequest; valid: boolean; label?: string }[];
  };
  statusMap?: {
    map(raw: string): CallState | undefined;
    expected: Readonly<Record<string, CallState>>;
  };
  /** Validly signed requests per purpose (answer or media-url for on-answer carriers; per-call ones). */
  requests?: Partial<Record<Purpose, CarrierHttpRequest>>;
  /** Hang-up markup for an 'ended' grant; defaults to /hangup/i. */
  hangupMarkup?: RegExp;
  /** The kit's host ports (url-secret HMAC); defaults to createFakeCarrierHostPorts with `binding`. */
  host?: () => FakeHostPorts;
}

export interface CarrierKitContext {
  factory: CarrierFactory;
  options: CarrierKitOptions;
}

export const PER_CALL_PURPOSES: readonly Purpose[] = ['status', 'answer', 'amd', 'resume'];

export function baseDial(
  host: FakeHostPorts,
  carrierId: string,
  binding: ResolvedBinding,
  atDial: boolean,
  format: DialRequest['media']['format'],
): DialRequest {
  const requestId = 'dial-1';
  const cb = (purpose: Purpose) =>
    host.callbackUrl(carrierId, binding.bindingId, purpose, { requestId });
  return {
    requestId,
    jobId: 'job-1',
    to: '+15550100',
    from: '+15550199',
    media: {
      url: host.mediaUrl(carrierId, binding.bindingId),
      routeParams: atDial ? { sid: 'session-1', rt: 'route-token-1' } : {},
      format,
    },
    callbacks: { status: cb('status'), answer: cb('answer'), amd: cb('amd'), resume: cb('resume') },
    maxDurationSec: 600,
  };
}

/** Deep equality for decoded frames, with byte payloads compared as base64. */
export function same(a: unknown, b: unknown): boolean {
  const normalise = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString('base64') };
    if (Array.isArray(value)) return value.map(normalise);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([k, v]) => [k, normalise(v)]),
      );
    return value;
  };
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

/** A transcript `command` as JSON (`payloadBase64` for audio) → MediaCommand. */
export function commandOf(raw: unknown) {
  const command = raw as { type: string; name?: string; payloadBase64?: string };
  if (command.type === 'audio')
    return {
      type: 'audio' as const,
      payload: new Uint8Array(Buffer.from(command.payloadBase64 ?? '', 'base64')),
    };
  if (command.type === 'mark') return { type: 'mark' as const, name: command.name ?? '' };
  return { type: 'clear' as const };
}

/** Transcript `events` in JSON form: audio payloads as `payloadBase64`. */
export function eventsOf(raw: unknown): unknown[] {
  return (raw as Record<string, unknown>[])
    .map((event) =>
      event.type === 'audio' && typeof event.payloadBase64 === 'string'
        ? {
            ...event,
            payloadBase64: undefined,
            payload: new Uint8Array(Buffer.from(event.payloadBase64, 'base64')),
          }
        : event,
    )
    .map((event) => Object.fromEntries(Object.entries(event).filter(([, v]) => v !== undefined)));
}
