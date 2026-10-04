import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../src/postgres.ts';
import { beginRoute } from './carrier-identity-support.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!url)('stream-first request-only correlation', () => {
  const schema = `stream_first_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let store: PostgresOrchestrationStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresOrchestrationStore({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await store.migrate();
  });

  afterAll(async () => {
    if (store) await store.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function streamFirst(label: string) {
    const { route, jobId, owner } = await beginRoute(store, schema, label);
    expect(
      await store.markDialAccepted({
        jobId,
        workerId: owner.ownerId,
        ownerEpoch: owner.ownerEpoch,
        dialRequestId: route.dialRequestId,
        carrierRequestId: route.carrierRequestId,
      }),
    ).toBe(true);
    const granted = await store.issueStreamGrant({
      organizationId: schema,
      carrierId: route.carrierId!,
      carrierRequestId: route.carrierRequestId,
      carrierCallId: `${label}-stream`,
      streamCallIdMatchesDial: false,
      tokenHash: createHash('sha256').update(label).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(granted).toMatchObject({
      sessionId: route.sessionId,
      carrierCallId: undefined,
      carrierStreamCallId: `${label}-stream`,
    });
    return { route, jobId, owner };
  }

  it('accepts a late distinct dial ID after the stream ID and audits the mismatch', async () => {
    const { route, jobId, owner } = await streamFirst('late-dial');
    expect(
      await store.markDialAccepted({
        jobId,
        workerId: owner.ownerId,
        ownerEpoch: owner.ownerEpoch,
        dialRequestId: route.dialRequestId,
        carrierRequestId: route.carrierRequestId,
        carrierCallId: 'late-dial-primary',
      }),
    ).toBe(true);
    expect(await store.getSessionRoute(jobId)).toMatchObject({
      carrierCallId: 'late-dial-primary',
      carrierStreamCallId: 'late-dial-stream',
    });
    expect(
      (
        await store.pool.query(
          `SELECT dial_call_id, stream_call_id FROM ovo_orch_audit_events
           WHERE session_id = $1 AND event_type = 'carrier.call_id_mismatch'`,
          [route.sessionId],
        )
      ).rows,
    ).toEqual([{ dial_call_id: 'late-dial-primary', stream_call_id: 'late-dial-stream' }]);
  });

  it('applies a late distinct dial callback after the stream ID and audits the mismatch', async () => {
    const { route, jobId } = await streamFirst('late-callback');
    expect(
      await store.applyCarrierCallback({
        organizationId: schema,
        carrierId: route.carrierId!,
        provider: 'test',
        eventId: 'stream-callback-event',
        carrierRequestId: route.carrierRequestId,
        carrierCallId: 'late-callback-stream',
        status: 'answered',
        occurredAt: new Date(),
      }),
    ).toMatchObject({ kind: 'applied' });
    expect(await store.getSessionRoute(jobId)).toMatchObject({
      carrierCallId: undefined,
      carrierStreamCallId: 'late-callback-stream',
    });
    expect(
      await store.applyCarrierCallback({
        organizationId: schema,
        carrierId: route.carrierId!,
        provider: 'test',
        eventId: 'late-callback-event',
        carrierRequestId: route.carrierRequestId,
        carrierCallId: 'late-callback-primary',
        status: 'answered',
        occurredAt: new Date(),
      }),
    ).toMatchObject({ kind: 'ignored_out_of_order' });
    expect(await store.getSessionRoute(jobId)).toMatchObject({
      carrierCallId: 'late-callback-primary',
      carrierStreamCallId: 'late-callback-stream',
    });
    expect(
      (
        await store.pool.query(
          `SELECT dial_call_id, stream_call_id FROM ovo_orch_audit_events
           WHERE session_id = $1 AND event_type = 'carrier.call_id_mismatch'`,
          [route.sessionId],
        )
      ).rows,
    ).toEqual([{ dial_call_id: 'late-callback-primary', stream_call_id: 'late-callback-stream' }]);
  });

  it('keeps the stream alias provisional when a gateway binds the same ID again', async () => {
    const { route, jobId } = await streamFirst('repeat-stream');
    expect(
      await store.bindCarrierCallId({
        organizationId: schema,
        carrierId: route.carrierId!,
        sessionId: route.sessionId,
        carrierCallId: 'repeat-stream-stream',
      }),
    ).toMatchObject({ kind: 'alias', route: { carrierCallId: undefined } });
    expect(
      await store.bindCarrierCallId({
        organizationId: schema,
        carrierId: route.carrierId!,
        sessionId: route.sessionId,
        carrierCallId: 'repeat-stream-primary',
      }),
    ).toMatchObject({ kind: 'bound', route: { carrierCallId: 'repeat-stream-primary' } });
    expect(await store.getSessionRoute(jobId)).toMatchObject({
      carrierCallId: 'repeat-stream-primary',
      carrierStreamCallId: 'repeat-stream-stream',
    });
    expect(
      (
        await store.pool.query(
          `SELECT dial_call_id, stream_call_id FROM ovo_orch_audit_events
           WHERE session_id = $1 AND event_type = 'carrier.call_id_mismatch'`,
          [route.sessionId],
        )
      ).rows,
    ).toEqual([{ dial_call_id: 'repeat-stream-primary', stream_call_id: 'repeat-stream-stream' }]);
  });

  it('keeps the first stream ID primary when the carrier promises exact ID matching', async () => {
    const { route, jobId, owner } = await beginRoute(store, schema, 'exact-stream-first');
    expect(
      await store.markDialAccepted({
        jobId,
        workerId: owner.ownerId,
        ownerEpoch: owner.ownerEpoch,
        dialRequestId: route.dialRequestId,
        carrierRequestId: route.carrierRequestId,
      }),
    ).toBe(true);
    expect(
      await store.issueStreamGrant({
        organizationId: schema,
        carrierId: route.carrierId!,
        carrierRequestId: route.carrierRequestId,
        carrierCallId: 'exact-stream',
        streamCallIdMatchesDial: true,
        tokenHash: createHash('sha256').update('exact-stream-first').digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ carrierCallId: 'exact-stream', carrierStreamCallId: undefined });
    expect(
      await store.markDialAccepted({
        jobId,
        workerId: owner.ownerId,
        ownerEpoch: owner.ownerEpoch,
        dialRequestId: route.dialRequestId,
        carrierRequestId: route.carrierRequestId,
        carrierCallId: 'different-dial',
      }),
    ).toBe(false);
  });
});
