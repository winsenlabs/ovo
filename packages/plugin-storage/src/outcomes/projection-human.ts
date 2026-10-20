import type { CallOutcomeHuman, SessionEvent } from '@winsendotai/ovo-contracts';

type HumanEvent = Extract<
  SessionEvent,
  { type: 'human.requested' | 'human.state' | 'human.webhook' | 'human.completed' }
>;

const blank = (): CallOutcomeHuman => ({
  queueKey: '',
  queueId: '',
  kind: 'managed',
  ticket: '',
  requested: 0,
  connected: 0,
  waitMs: null,
  talkMs: null,
  outcome: null,
  operator: null,
  callbacks: { accepted: false, released: false, outcome: null },
});

/**
 * Folds one `human.*` event into a call's human summary: the last queue wins, counts add, and a
 * third party's callbacks only set flags, so they fold the same whether they arrive before or
 * after `call.outcome` (an external leg is handed on long before its callbacks come in).
 */
export function foldHuman(
  current: CallOutcomeHuman | null,
  event: HumanEvent,
): CallOutcomeHuman | null {
  const human = current ? { ...current, callbacks: { ...current.callbacks } } : null;
  switch (event.type) {
    case 'human.requested': {
      const p = event.payload;
      if (p.result === 'refused')
        return (
          human ?? {
            ...blank(),
            queueKey: p.queue,
            queueId: p.queueId,
            kind: p.kind,
            outcome: 'unavailable',
          }
        );
      const next = human ?? blank();
      return {
        ...next,
        queueKey: p.queue,
        queueId: p.queueId,
        kind: p.kind,
        ticket: p.ticket ?? '',
        requested: next.requested + 1,
        waitMs: null,
        talkMs: null,
        outcome: null,
        operator: null,
      };
    }
    case 'human.state': {
      const p = event.payload;
      const next = human ?? blank();
      if (p.callback) {
        // A third party's callback: `accepted` and `released` set a flag, `outcome` keeps its result.
        if (p.callback === 'accepted' || p.callback === 'released')
          next.callbacks[p.callback] = true;
        else if (p.callback === 'outcome') next.callbacks.outcome = p.code ?? 'outcome';
        return next;
      }
      if (p.state === 'connected') next.connected += 1;
      if (p.operator && (p.state === 'accepted' || p.state === 'connected'))
        next.operator = p.operator;
      if (p.state === 'connected' && p.waitMs !== undefined) next.waitMs = p.waitMs;
      return next;
    }
    case 'human.completed': {
      const p = event.payload;
      const next = human ?? blank();
      return {
        ...next,
        queueKey: p.queue,
        kind: p.kind,
        ticket: p.ticket,
        outcome: p.outcome,
        waitMs: p.waitMs,
        talkMs: p.talkMs ?? null,
        operator: p.operator ?? next.operator,
      };
    }
    default:
      return human;
  }
}
