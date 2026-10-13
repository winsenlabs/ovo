import type { Clock } from '@winsendotai/ovo-contracts';
import type { SipMessage, SipRequest } from './message.ts';

/** RFC 4028: Min-SE floor 90 s (§4), recommended Session-Expires 1800 s. */
export const MIN_SE = 90;
export const DEFAULT_SE = 1800;

export interface SessionExpires {
  seconds: number;
  refresher?: 'uac' | 'uas';
}

export function parseSessionExpires(value: string | undefined): SessionExpires | undefined {
  const match = /^\s*(\d{1,10})\s*(;.*)?$/.exec(value ?? '');
  if (!match) return undefined;
  const refresher = /;\s*refresher\s*=\s*(uac|uas)\b/i.exec(match[2] ?? '')?.[1]?.toLowerCase();
  return {
    seconds: Number(match[1]),
    ...(refresher ? { refresher: refresher as 'uac' | 'uas' } : {}),
  };
}

const supportsTimer = (message: SipMessage) =>
  [...message.headers.getAll('supported'), ...message.headers.getAll('require')].some(
    (tag) => tag.toLowerCase() === 'timer',
  );

export type UasTimerDecision =
  | { kind: 'none' }
  | { kind: 'reject'; minSe: number }
  | { kind: 'timer'; seconds: number; refresher: 'uac' | 'uas'; headers: [string, string][] };

/**
 * What a UAS does with an INVITE or UPDATE (RFC 4028 §9): 422 below Min-SE; otherwise echo the
 * interval and pick a refresher (the UAC when it supports timers, else us).
 */
export function uasSessionTimer(request: SipRequest): UasTimerDecision {
  const se = parseSessionExpires(request.headers.get('session-expires'));
  if (!se) return { kind: 'none' };
  const theirMin = parseSessionExpires(request.headers.get('min-se'))?.seconds ?? 0;
  const floor = Math.max(MIN_SE, theirMin);
  if (se.seconds < floor) return { kind: 'reject', minSe: floor };
  const uacSupports = supportsTimer(request);
  const refresher = uacSupports ? (se.refresher ?? 'uac') : 'uas';
  return {
    kind: 'timer',
    seconds: se.seconds,
    refresher,
    headers: [
      ['Session-Expires', `${se.seconds};refresher=${refresher}`],
      ...(uacSupports ? ([['Require', 'timer']] as [string, string][]) : []),
    ],
  };
}

/** Our request headers as UAC: support timers and ask for the default interval. */
export function uacTimerHeaders(seconds = DEFAULT_SE): [string, string][] {
  return [
    ['Session-Expires', `${seconds}`],
    ['Min-SE', `${MIN_SE}`],
  ];
}

/**
 * The running timer of one dialog. The refresher refreshes at SE/2; the other side sends BYE at
 * SE − min(32, SE/3) when no refresh arrived (RFC 4028 §10).
 */
export class SessionTimer {
  private cancel?: () => void;

  constructor(
    private readonly clock: Clock,
    private readonly handlers: { refresh(): void; expire(): void },
  ) {}

  arm(seconds: number, weRefresh: boolean): void {
    this.stop();
    const ms = weRefresh ? (seconds * 1000) / 2 : (seconds - Math.min(32, seconds / 3)) * 1000;
    this.cancel = this.clock.setTimeout(() => {
      this.cancel = undefined;
      if (weRefresh) this.handlers.refresh();
      else this.handlers.expire();
    }, ms);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}
