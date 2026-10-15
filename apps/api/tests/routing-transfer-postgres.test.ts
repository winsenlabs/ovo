import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeWav } from '@winsendotai/ovo-audio';
import { createOperationsRuntime, type OperationsRuntime } from '../src/operations-runtime.ts';
import { registerRoutingRoutes } from '../src/routes/routing.ts';
import {
  DEFAULT_RELEASE,
  draftInput,
  exampleReleases,
  fakeStore,
  poolInput,
  registry,
  release,
} from './routing-fixtures.ts';
import { pcmWav } from './routing-audio-fixtures.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)(
  'hold clips and transfer publish on the operations database (Wave 16)',
  () => {
    const organizationId = `routing-transfer-${randomUUID()}`;
    let runtime: OperationsRuntime;
    let app: FastifyInstance;
    const store = fakeStore(
      [
        ...exampleReleases().filter((item) => item.id !== DEFAULT_RELEASE),
        release(DEFAULT_RELEASE, 'sales-en', {
          config: { handoff: { agents: { llmTool: true, nodes: {} } } },
        }),
      ].map((item) => ({ ...item, workspaceId: organizationId })),
    );
    const call = (
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      payload?: unknown,
      headers = {},
    ) => app.inject({ method, url, payload: payload as never, headers });
    const upload = (name: string, body: Buffer) =>
      app.inject({
        method: 'POST',
        url: `/v1/routing/audio?name=${encodeURIComponent(name)}`,
        payload: body,
        headers: { 'content-type': 'audio/x-wav' },
      });
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      runtime = await createOperationsRuntime({
        organizationId,
        databaseUrl,
        routingEnabled: true,
      });
      app = Fastify({ logger: false });
      app.setErrorHandler((caught, _request, reply) => {
        const thrown = caught as Error & { statusCode?: number; code?: string };
        if (thrown instanceof z.ZodError)
          return reply.code(400).send({ error: { code: 'validation_error' } });
        return reply
          .code(thrown.statusCode ?? 500)
          .send({ error: { code: thrown.code ?? 'internal_error', message: thrown.message } });
      });
      registerRoutingRoutes({
        app,
        store: store as never,
        requireRole: () => ({
          identityId: 'operator',
          label: 'Operator',
          workspaceId: organizationId,
          role: 'admin' as const,
        }),
        operations: runtime.service,
        enabled: true,
        externalEnabled: false,
        transferEnabled: true,
        requireCostPolicy: false,
        registry,
        expectedVersion: (request) =>
          Number(String(request.headers['if-match']).replaceAll('"', '')),
      });
      for (const [key, name, members] of [
        [
          'sales',
          'Sales',
          [
            ['sales-en', ['en']],
            ['sales-hi', ['hi']],
          ],
        ],
        ['support', 'Support', [['support', ['en']]]],
        ['billing', 'Billing', [['support', ['en']]]],
      ] as const) {
        const created = await call('POST', '/v1/routing/pools', {
          definition: poolInput(name, members as never),
        });
        ids[key] = created.json().id;
      }
    });

    afterAll(async () => {
      await app?.close();
      await runtime?.close();
    });

    it('converts, stores, previews and lists an uploaded clip', async () => {
      const created = await upload('Hold music', pcmWav(22050, 2, 2));
      expect(created.statusCode, created.body).toBe(201);
      const clip = created.json();
      expect(clip).toMatchObject({
        durationMs: 2000,
        byteLength: 16000,
        source: { sampleRate: 22050 },
      });
      ids.clip = clip.id;
      const content = await call('GET', `/v1/routing/audio/${clip.id}/content`);
      expect(content.statusCode).toBe(200);
      expect(decodeWav(content.rawPayload).frames).toBe(16000);
      expect(
        (await call('GET', '/v1/routing/audio')).json().items.map((i: { id: string }) => i.id),
      ).toEqual([clip.id]);
      const taken = await upload('HOLD MUSIC', pcmWav(8000, 1));
      expect([taken.statusCode, taken.json().error.code]).toEqual([
        409,
        'routing_audio_name_taken',
      ]);
    });

    it('links a transfer catalogue to its pools and clips, and publishes them pinned', async () => {
      const draft = draftInput();
      draft.nodes[0].branches[0].target.poolId = ids.sales;
      draft.nodes[0].branches[1].target.poolId = ids.support;
      draft.transfer = {
        targets: [
          {
            key: 'billing',
            description: 'Payments and refunds',
            destination: { kind: 'pool', poolId: ids.billing, language: 'any' },
          },
        ],
        hold: {
          steps: [{ kind: 'clip', assetId: ids.clip }],
          onTimeout: [{ kind: 'default' }, { kind: 'end', line: { en: 'Goodbye.' } }],
        },
      };
      const point = await call('POST', '/v1/routing/points', { draft });
      expect(point.statusCode, point.body).toBe(201);
      ids.point = point.json().id;
      // The service's link tables, not a draft scan: the transfer-only pool and the clip are in use.
      expect((await call('GET', `/v1/routing/pools/${ids.billing}`)).json().usedBy).toEqual([
        ids.point,
      ]);
      expect((await call('GET', `/v1/routing/audio/${ids.clip}`)).json().usedBy).toEqual([
        ids.point,
      ]);
      const inUse = await call('DELETE', `/v1/routing/audio/${ids.clip}`);
      expect([inUse.statusCode, inUse.json().usedBy]).toEqual([409, [ids.point]]);

      const published = await call('POST', `/v1/routing/points/${ids.point}/releases`, {});
      expect(published.statusCode, published.body).toBe(201);
      const { snapshot, warnings } = published.json();
      expect(warnings).toEqual([]);
      expect(snapshot.schemaVersion).toBe(2);
      const clip = (await call('GET', `/v1/routing/audio/${ids.clip}`)).json();
      expect(snapshot.transfer.hold.steps[0]).toEqual({
        kind: 'clip',
        assetId: ids.clip,
        sha256: clip.sha256,
      });
      expect(Object.keys(snapshot.pools)).toContain(ids.billing);
    });

    it('reports deleted pools and clips by name once they are gone', async () => {
      // A clip and a pool nobody names any more can be deleted...
      const spare = (await upload('Spare', pcmWav(8000, 1))).json();
      expect((await call('DELETE', `/v1/routing/audio/${spare.id}`)).statusCode).toBe(204);
      const pool = (
        await call('POST', '/v1/routing/pools', {
          definition: poolInput('Spare', [['support', ['en']]]),
        })
      ).json();
      expect(
        (await call('DELETE', `/v1/routing/pools/${pool.id}`, undefined, { 'if-match': '"1"' }))
          .statusCode,
      ).toBe(204);
      // ...and a draft naming them afterwards is told they were deleted, not that they never existed.
      const draft = draftInput();
      draft.nodes[0].branches[0].target.poolId = pool.id;
      draft.nodes[0].branches[1].target.poolId = ids.support;
      draft.transfer = {
        targets: [],
        hold: { steps: [{ kind: 'clip', assetId: spare.id }], onTimeout: [{ kind: 'default' }] },
      };
      const checked = await call('POST', `/v1/routing/points/${ids.point}/validate`, { draft });
      expect(checked.json().issues.map((issue: { code: string }) => issue.code)).toEqual([
        'routing_pool_deleted',
        'routing_transfer_audio_deleted',
      ]);
      // The bytes stay readable by digest for releases that pinned them.
      expect(await runtime.service.routing.audio.content(spare.id, spare.sha256)).toHaveLength(
        8000,
      );
    });
  },
);
