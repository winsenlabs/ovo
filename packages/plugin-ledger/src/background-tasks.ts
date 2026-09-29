import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { PostgresCostLedger } from './postgres.ts';
import { ReservationSweeper, type ReservationJobPort } from './reservation-sweeper.ts';

export const plugins = [
  definePlugin(
    {
      id: '@winsendotai/ovo-plugin-ledger/reservation-sweeper',
      version: '1.0.0',
      contractVersion: 2,
      kind: 'infra',
      scope: 'process',
      requires: [Cap.costLedger, Cap.orchestrationStore],
      provides: [Cap.backgroundTask],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      const ledger = ctx.get(Cap.costLedger);
      if (!(ledger instanceof PostgresCostLedger))
        throw new Error('Reservation sweeper requires Postgres cost ledger');
      const sweeper = new ReservationSweeper(
        ledger.pool,
        ctx.get(Cap.orchestrationStore) as ReservationJobPort,
      );
      ctx.provide(Cap.backgroundTask, {
        id: 'reservation-sweeper',
        intervalMs: 30_000,
        tick: (signal: AbortSignal) => sweeper.tick(signal).then(() => undefined),
      });
    },
  ),
];
