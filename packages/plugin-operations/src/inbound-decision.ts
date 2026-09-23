import type { InboundDecision, StreamGrant } from '@winsendotai/ovo-contracts';
import type { InboundGatewayDecision } from './types.ts';

/** C2 supplies route artifacts; this mapper never mints a grant or constructs a URL. */
export type InboundDecisionContext =
  | { kind: 'reserved'; grant: StreamGrant }
  | { kind: 'wait'; retryUrl: string; announce?: boolean }
  | { kind: 'callback'; digitsUrl: string; timeoutSeconds: number }
  | { kind: 'busy' }
  | { kind: 'human' };

type Decision<K extends InboundGatewayDecision['kind']> = Extract<
  InboundGatewayDecision,
  { kind: K }
>;
type Context<K extends InboundDecisionContext['kind']> = Extract<
  InboundDecisionContext,
  { kind: K }
>;

export function inboundDecisionFor(
  decision: Decision<'reserved'>,
  context: Context<'reserved'>,
): InboundDecision;
export function inboundDecisionFor(
  decision: Decision<'wait'>,
  context: Context<'wait'>,
): InboundDecision;
export function inboundDecisionFor(
  decision: Decision<'callback'>,
  context: Context<'callback'>,
): InboundDecision;
export function inboundDecisionFor(
  decision: Decision<'busy'>,
  context: Context<'busy'>,
): InboundDecision;
export function inboundDecisionFor(
  decision: Decision<'human'>,
  context: Context<'human'>,
): InboundDecision;
export function inboundDecisionFor(
  decision: InboundGatewayDecision,
  context: InboundDecisionContext,
): InboundDecision {
  if (!context || context.kind !== decision.kind)
    throw new TypeError(`Inbound ${decision.kind} requires matching context`);
  switch (decision.kind) {
    case 'reserved': {
      const grant = (context as Context<'reserved'>).grant;
      if (
        grant?.kind !== 'stream' ||
        typeof grant.mediaUrl !== 'string' ||
        !grant.mediaUrl ||
        !grant.routeParams ||
        typeof grant.routeParams.sid !== 'string' ||
        !grant.routeParams.sid ||
        typeof grant.routeParams.rt !== 'string' ||
        !grant.routeParams.rt
      )
        throw new TypeError('Inbound reserved requires a StreamGrant with mediaUrl, sid and rt');
      if (grant.routeParams.sid !== decision.sessionId)
        throw new TypeError('Inbound reserved grant sid must match sessionId');
      const { kind: _stream, ...fields } = grant;
      return { kind: 'connect', ...fields };
    }
    case 'wait': {
      const selected = context as Context<'wait'>;
      if (typeof selected.retryUrl !== 'string' || !selected.retryUrl.trim())
        throw new TypeError('Inbound wait requires retryUrl');
      if (selected.announce !== undefined && typeof selected.announce !== 'boolean')
        throw new TypeError('Inbound wait announce must be boolean');
      if (!Number.isFinite(decision.pollAfterMs))
        throw new TypeError('Inbound wait requires finite pollAfterMs');
      if (typeof decision.announcement !== 'string')
        throw new TypeError('Inbound wait requires announcement');
      return {
        kind: 'wait',
        message: decision.announcement,
        ...(selected.announce === undefined ? {} : { announce: selected.announce }),
        pauseSeconds: Math.max(1, Math.ceil(decision.pollAfterMs / 1_000)),
        retryUrl: selected.retryUrl,
      };
    }
    case 'callback': {
      const selected = context as Context<'callback'>;
      if (typeof selected.digitsUrl !== 'string' || !selected.digitsUrl.trim())
        throw new TypeError('Inbound callback requires digitsUrl');
      if (!Number.isInteger(selected.timeoutSeconds) || selected.timeoutSeconds < 1)
        throw new TypeError('Inbound callback requires positive timeoutSeconds');
      if (typeof decision.announcement !== 'string')
        throw new TypeError('Inbound callback requires announcement');
      switch (decision.state) {
        case 'queued':
          return { kind: 'hangup', message: 'Your callback request has been queued.' };
        case 'declined':
          return { kind: 'hangup', message: 'No callback was requested.' };
        case 'suppressed':
          return { kind: 'hangup', message: 'A callback cannot be scheduled for this number.' };
        case 'prompt':
          break;
        default:
          throw new TypeError(`Unsupported inbound callback state: ${String(decision.state)}`);
      }
      return {
        kind: 'callback-offer',
        prompt: decision.announcement,
        digitsUrl: selected.digitsUrl,
        timeoutSeconds: selected.timeoutSeconds,
      };
    }
    case 'busy':
      if (typeof decision.reason !== 'string') throw new TypeError('Inbound busy requires reason');
      return { kind: 'busy', reason: decision.reason };
    case 'human':
      if (typeof decision.target !== 'string' || !decision.target.trim())
        throw new TypeError('Inbound human requires target');
      if (typeof decision.announcement !== 'string')
        throw new TypeError('Inbound human requires announcement');
      return { kind: 'human', e164: decision.target, message: decision.announcement };
    default:
      throw new TypeError(
        `Unsupported inbound decision kind: ${String((decision as { kind: string }).kind)}`,
      );
  }
}
