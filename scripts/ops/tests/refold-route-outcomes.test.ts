import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { PostgresCallOutcomeStore } from '../../../packages/plugin-storage/src/outcomes/postgres-store.ts';
import { main } from '../refold-route-outcomes-main.ts';

const run = promisify(execFile);
// `pg` belongs to the storage package; a script test reaches it the way the tool does, through that package.
const { Pool } = createRequire(
  new URL('../../../packages/plugin-storage/package.json', import.meta.url),
)('pg') as {
  Pool: new (config: { connectionString?: string; max: number }) => {
    query(sql: string, values?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
};
const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

function fakeStore() {
  const refoldRoutes = vi.fn(async () => ({
    scanned: 2,
    changed: [
      {
        callId: 'a',
        before: { routingPointId: 'p' } as never,
        after: { routingPointId: 'p', routeMs: 5 } as never,
      },
      { callId: 'b', before: { routingPointId: 'p' } as never, after: null },
    ],
    unchanged: 0,
    failed: [{ callId: 'c', reason: 'unreadable' }],
    applied: 1,
  }));
  const close = vi.fn(async () => undefined);
  return { refoldRoutes, close };
}

describe('refold-route-outcomes arguments', () => {
  const env = { DATABASE_URL: 'postgres://x/y' };
  async function call(argv: string[], environment: Record<string, string | undefined> = env) {
    const store = fakeStore();
    const lines: Record<string, unknown>[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main({
      argv,
      env: environment,
      log: (entry) => lines.push(entry),
      open: async () => store as never,
    });
    error.mockRestore();
    return { code, store, lines };
  }

  it('is a dry run unless --apply is given, and reports each call and a summary', async () => {
    const dry = await call(['--workspace', 'ws']);
    expect(dry.code).toBe(0);
    expect(dry.store.refoldRoutes).toHaveBeenCalledWith('ws', { apply: false });
    expect(dry.lines.map((line) => line.event)).toEqual([
      'refold_route',
      'refold_route',
      'refold_route_failed',
      'refold_summary',
    ]);
    expect(dry.lines.at(-1)).toMatchObject({
      mode: 'dry-run',
      scanned: 2,
      changed: 2,
      failed: 1,
      applied: 1,
    });
    expect(dry.lines[0]).toMatchObject({ applied: false });
    const applied = await call([
      '--workspace',
      'ws',
      '--apply',
      '--limit',
      '50',
      '--since',
      '2026-10-01T00:00:00Z',
    ]);
    expect(applied.store.refoldRoutes).toHaveBeenCalledWith('ws', {
      apply: true,
      limit: 50,
      since: '2026-10-01T00:00:00.000Z',
    });
    expect(applied.lines.at(-1)).toMatchObject({ mode: 'apply' });
    expect(applied.lines[0]).toMatchObject({ applied: true });
    expect(applied.lines[1]).toMatchObject({ applied: false, after: null });
    expect(applied.store.close).toHaveBeenCalled();
  });

  it('refuses a missing workspace, a stray option, a bad limit or time, and a missing database', async () => {
    for (const argv of [
      [],
      ['--apply'],
      ['--workspace', 'ws', '--force'],
      ['--workspace', 'ws', '--limit', 'many'],
      ['--workspace', 'ws', '--limit', '99999'],
      ['--workspace', 'ws', '--since', 'yesterday'],
    ]) {
      const result = await call(argv);
      expect([result.code, result.store.refoldRoutes.mock.calls.length], argv.join(' ')).toEqual([
        2, 0,
      ]);
    }
    expect((await call(['--workspace', 'ws'], {})).code).toBe(2);
    expect(
      (await call(['--workspace', 'ws'], { OVO_CONTROL_DATABASE_URL: 'postgres://x/z' })).code,
    ).toBe(0);
  });
});

describe.skipIf(!databaseUrl)('refold-route-outcomes against PostgreSQL', () => {
  it('runs as a command: a dry run reports, --apply rebuilds the route', async () => {
    const workspaceId = `refold-cli-${randomUUID()}`;
    const store = await PostgresCallOutcomeStore.open({ connectionString: databaseUrl! });
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const at = '2026-10-20T10:00:00.000Z';
      const events = [
        {
          id: 'e1',
          at,
          type: 'route.segment',
          payload: {
            index: 0,
            role: 'router',
            agentId: 'front',
            releaseId: randomUUID(),
            reason: 'start',
          },
        },
        {
          id: 'e2',
          at,
          type: 'route.fallback',
          payload: { turn: 1, node: 'intent', step: 'reask', result: 'taken', attempt: 1 },
        },
        {
          id: 'e3',
          at,
          type: 'route.decision',
          payload: {
            routingPointId: randomUUID(),
            routingReleaseId: randomUUID(),
            path: ['intent'],
            target: 'agent',
            turns: 2,
            routeMs: 1500,
          },
        },
      ];
      await store.append(workspaceId, 'call-1', events);
      await pool.query(
        `UPDATE ovo_call_outcomes SET route = route - 'turns' - 'routeMs' - 'fallbacks' - 'reasks' WHERE workspace_id = $1`,
        [workspaceId],
      );
      const env = {
        ...process.env,
        DATABASE_URL: databaseUrl,
        OVO_CONTROL_DATABASE_URL: databaseUrl,
      };
      const script = new URL('../refold-route-outcomes.mjs', import.meta.url).pathname;
      const lines = async (...args: string[]) =>
        (await run(process.execPath, [script, '--workspace', workspaceId, ...args], { env })).stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      const dry = await lines();
      expect(dry.map((line) => line.event)).toEqual(['refold_route', 'refold_summary']);
      expect(dry[1]).toMatchObject({ mode: 'dry-run', scanned: 1, changed: 1, applied: 0 });
      expect((await store.get(workspaceId, 'call-1'))!.route).not.toHaveProperty('routeMs');
      const applied = await lines('--apply');
      expect(applied.at(-1)).toMatchObject({ mode: 'apply', applied: 1 });
      expect((await store.get(workspaceId, 'call-1'))!.route).toMatchObject({
        turns: 2,
        routeMs: 1500,
        reasks: 1,
        fallbacks: 0,
      });
      expect((await lines('--apply')).at(-1)).toMatchObject({ scanned: 0, applied: 0 });
    } finally {
      await pool.end();
      await store.close();
    }
  }, 60_000);
});
