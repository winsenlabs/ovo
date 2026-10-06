import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PostgresControlStore } from '../src/index.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('call event batches (OBS-10)', () => {
  let store: PostgresControlStore;
  const workspaceId = `batch-${randomUUID()}`;
  let callId: string;

  beforeAll(async () => {
    store = await PostgresControlStore.open(databaseUrl!);
    await store.ensureWorkspace(workspaceId, 'Batch writes');
    const agent = await store.createAgent(
      workspaceId,
      AgentConfig.parse({ name: 'Batch', mode: 'announcement', message: 'Hello' }),
    );
    const release = await store.createRelease({
      workspaceId,
      agent,
      plugins: [{ id: 'behavior.announcement', version: '1.0.0' }],
      createdBy: 'operator',
    });
    callId = (
      await store.createCall({
        workspaceId,
        releaseId: release.id,
        kind: 'live',
        status: 'running',
      })
    ).id;
  });

  afterAll(async () => {
    await store?.close();
  });

  it('writes a batch in order after single events, with consecutive sequences', async () => {
    await store.appendCallEvent(workspaceId, callId, 'session.started', { source: 'live' });
    const batch = await store.appendCallEvents!(
      workspaceId,
      callId,
      Array.from({ length: 60 }, (_, index) => ({
        type: 'engine.event',
        payload: { index },
        epoch: index % 3,
      })),
    );
    expect(batch.map((event) => event.sequence)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 2),
    );
    await store.appendCallEvent(workspaceId, callId, 'session.ended', { reason: 'caller_hangup' });
    const page = await store.listCallEvents(workspaceId, callId, 100);
    expect(page.items.map((event) => event.type)).toEqual([
      'session.started',
      ...Array(60).fill('engine.event'),
      'session.ended',
    ]);
    expect(page.items[5]).toMatchObject({ sequence: 6, epoch: 1, payload: { index: 4 } });
  });

  it('keeps concurrent batches for one call from interleaving sequences', async () => {
    const results = await Promise.all(
      [0, 1, 2].map((group) =>
        store.appendCallEvents!(
          workspaceId,
          callId,
          Array.from({ length: 5 }, (_, index) => ({ type: `group-${group}`, payload: { index } })),
        ),
      ),
    );
    for (const batch of results) {
      const sequences = batch.map((event) => event.sequence);
      expect(sequences).toEqual(sequences.map((_, index) => sequences[0]! + index));
    }
  });

  it('refuses a batch for an unknown call and accepts an empty one', async () => {
    await expect(
      store.appendCallEvents!(workspaceId, randomUUID(), [{ type: 'x', payload: {} }]),
    ).rejects.toThrow('Call not found');
    expect(await store.appendCallEvents!(workspaceId, callId, [])).toEqual([]);
  });
});
