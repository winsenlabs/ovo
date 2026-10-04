import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
await mkdir('.data', { recursive: true, mode: 0o700 });
try {
  await access('.data/local.env');
  console.log('Local configuration already exists; retained existing keys.');
} catch {
  const content =
    [
      `OVO_ADMIN_TOKEN=${randomBytes(32).toString('hex')}`,
      `OVO_SESSION_SECRET=${randomBytes(32).toString('hex')}`,
      `OVO_SECRETS_MASTER_KEY=${randomBytes(32).toString('hex')}`,
      'OVO_ADMIN_WORKSPACE_ID=local',
      'OVO_DATABASE_FILE=../../.data/ovo.sqlite',
      'OVO_SECRETS_BACKEND=local',
      'OVO_API_URL=http://127.0.0.1:4000',
      'NODE_ENV=development',
    ].join('\n') + '\n';
  await writeFile('.data/local.env', content, { flag: 'wx', mode: 0o600 });
  console.log(
    'Created private .data/local.env. Secrets were not printed. Use the admin token from that file in the local console login.',
  );
}
