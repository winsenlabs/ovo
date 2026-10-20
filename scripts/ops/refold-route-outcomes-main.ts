import { PostgresCallOutcomeStore } from '../../packages/plugin-storage/src/outcomes/postgres-store.ts';

type Environment = Readonly<Record<string, string | undefined>>;

const USAGE =
  'usage: refold-route-outcomes --workspace <id> [--apply] [--limit <1-5000>] [--since <iso time>]';

function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** The refold tool: returns the exit code (0 done, 2 usage or run error). */
export async function main(input: {
  argv: readonly string[];
  env: Environment;
  log?: (entry: Record<string, unknown>) => void;
  open?: (databaseUrl: string) => Promise<Pick<PostgresCallOutcomeStore, 'refoldRoutes' | 'close'>>;
}): Promise<number> {
  const log = input.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const workspaceId = option(input.argv, '--workspace');
  const limit = option(input.argv, '--limit');
  const since = option(input.argv, '--since');
  const databaseUrl = input.env.OVO_CONTROL_DATABASE_URL ?? input.env.DATABASE_URL;
  const known = new Set(['--workspace', '--apply', '--limit', '--since']);
  const stray = input.argv.find((arg) => arg.startsWith('--') && !known.has(arg));
  if (
    !workspaceId ||
    stray ||
    (limit !== undefined && !/^\d{1,4}$/.test(limit)) ||
    (since !== undefined && Number.isNaN(Date.parse(since)))
  ) {
    console.error(USAGE);
    return 2;
  }
  if (!databaseUrl) {
    console.error('DATABASE_URL or OVO_CONTROL_DATABASE_URL is required');
    return 2;
  }
  const apply = input.argv.includes('--apply');
  const store = await (
    input.open ?? ((url) => PostgresCallOutcomeStore.open({ connectionString: url }))
  )(databaseUrl);
  try {
    const report = await store.refoldRoutes(workspaceId, {
      apply,
      ...(limit ? { limit: Number(limit) } : {}),
      ...(since ? { since: new Date(since).toISOString() } : {}),
    });
    for (const call of report.changed)
      log({
        event: 'refold_route',
        callId: call.callId,
        applied: apply && call.after !== null,
        before: call.before,
        after: call.after,
      });
    for (const call of report.failed) log({ event: 'refold_route_failed', ...call });
    log({
      event: 'refold_summary',
      workspaceId,
      mode: apply ? 'apply' : 'dry-run',
      scanned: report.scanned,
      changed: report.changed.length,
      unchanged: report.unchanged,
      failed: report.failed.length,
      applied: report.applied,
    });
    return 0;
  } finally {
    await store.close();
  }
}
