import {
  LocalAesGcmSecretManager,
  masterKeyRingFromEnv,
  rewrapWorkspaceCredentials,
  type RewrapSummary,
} from '@winsendotai/ovo-plugin-secrets';
import { PostgresControlStore, type ControlStore } from '@winsendotai/ovo-plugin-storage';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * `secrets:rewrap`: after OVO_SECRETS_MASTER_KEY is replaced and the old key is moved to
 * OVO_SECRETS_MASTER_KEY_PREVIOUS, re-encrypt every active stored credential under the new key.
 * Prints counts and credential ids only, never values. Returns the process exit code.
 */
export async function runSecretsRewrap(input: {
  env: Environment;
  argv: readonly string[];
  log?: (entry: Record<string, unknown>) => void;
  openStore?: (databaseUrl: string) => Promise<ControlStore>;
}): Promise<number> {
  const log = input.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const dryRun = input.argv.includes('--dry-run');
  const workspaces = input.argv.flatMap((arg, index) =>
    arg === '--workspace' && input.argv[index + 1] ? [input.argv[index + 1]!] : [],
  );
  const workspaceId = input.env.OVO_ORGANIZATION_ID ?? input.env.OVO_ADMIN_WORKSPACE_ID;
  if (!workspaces.length && workspaceId) workspaces.push(workspaceId);
  if (!workspaces.length) throw new Error('Pass --workspace <id> or set OVO_ORGANIZATION_ID');
  const backend = input.env.OVO_SECRETS_BACKEND ?? 'encrypted-store';
  if (backend !== 'encrypted-store' && backend !== 'local')
    throw new Error(`Rewrap applies to stored secrets only; OVO_SECRETS_BACKEND is ${backend}`);
  const keys = masterKeyRingFromEnv(input.env);
  const databaseUrl = input.env.OVO_CONTROL_DATABASE_URL ?? input.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL or OVO_CONTROL_DATABASE_URL is required');
  const store = await (input.openStore ?? PostgresControlStore.open)(databaseUrl);
  try {
    const secrets = new LocalAesGcmSecretManager(store, keys, backend);
    const summaries: RewrapSummary[] = [];
    for (const workspace of workspaces) {
      const summary = await rewrapWorkspaceCredentials({
        store,
        secrets,
        workspaceId: workspace,
        backend,
        dryRun,
      });
      summaries.push(summary);
      log({
        event: 'secrets_rewrap',
        dryRun,
        primaryKeyId: keys.primary.id,
        previousKeyIds: keys.previous.map((key) => key.id),
        ...summary,
      });
    }
    return summaries.some((summary) => summary.failed.length) ? 1 : 0;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && /(?:^|\/)secrets-rewrap\.(?:ts|js|cjs)$/.test(process.argv[1])) {
  runSecretsRewrap({ env: process.env, argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
