import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIRST_PARTY, loadDistribution } from '@winsendotai/ovo-distribution';
import { definePlugin } from '@winsendotai/ovo-runtime';

const host = (id: string) => definePlugin({ id, version: '1.0.0', contractVersion: 1,
  scope: 'process', provides: [], requires: [], secretFields: [],
  configSchema: { type: 'object' } }, () => {});

describe('dispatcher production entry contract', () => {
  it('configures the ledger on the stable distribution dispatcher profile path', async () => {
    const databaseUrl = 'postgresql://unused-for-profile-test';
    const loaded = await loadDistribution({ role: 'dispatcher', profile: 'compose',
      env: { DATABASE_URL: databaseUrl, OVO_QUEUE_URL: 'http://queue.test',
        OVO_DLQ_URL: 'http://dlq.test', AWS_REGION: 'us-east-1' },
      firstParty: [...FIRST_PARTY, { package: 'ovo-dispatcher-host-test', roles: ['dispatcher'],
        load: async () => ({ plugins: [host('ovo.operations.postgres'),
          host('@winsendotai/ovo-plugin-ledger'), host('ovo.dispatcher.node-net')] }) }],
    });
    expect(loaded.processRows.find((row) => row.id === '@winsendotai/ovo-plugin-ledger')?.config)
      .toEqual({ databaseUrl });
  });

  it('has no desired-count writer in the existing main module', () => {
    const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('ecsCapacityWriterPlugin');
    expect(source).not.toContain('decideAndApplyCapacity');
    expect(source).not.toContain('OVO_CAPACITY_AUTHORITY');
    expect(source).toContain('openDispatcherProcess');
  });
});
