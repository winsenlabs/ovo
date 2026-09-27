import Fastify from 'fastify';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { NodeSqliteControlStore, type ControlStore } from '@winsendotai/ovo-plugin-storage';
import { expect, it, vi } from 'vitest';
import { registerTestCallRoutes } from '../src/routes/test-calls.ts';
import { TestCallRuntime } from '../src/test-call-runtime.ts';
const agentId = '31439c24-9d99-4a49-8dba-c46f9077198c';
// The real store is wrapped only at its public asynchronous boundary: the first
// response waits after its durable write, while a concurrent request reads it.
it.each(['draft', 'before', 'after', 'failure', 'lookup-failure', 'telemetry-failure'])(
  'durably admits %s with an atomic idempotency intent',
  async (phase) => {
    const useDraft = phase === 'draft';
    const store = new NodeSqliteControlStore(':memory:');
    const workspaceId = 'admission-proof';
    await store.ensureWorkspace(workspaceId);
    const agent = await store.createAgent(
      workspaceId,
      AgentConfig.parse({
        name: 'Draft',
        mode: 'announcement',
        message: 'Draft speech',
        recording: false,
      }),
      agentId,
    );
    const release = useDraft
      ? undefined
      : await store.createRelease({ workspaceId, agent, plugins: [], createdBy: 'test' });
    let entered!: () => void, unblock!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const wrapped = new Proxy({} as ControlStore, {
      get(_target, key) {
        const value = Reflect.get(store, key);
        if (phase === 'lookup-failure' && key === 'getFixtureCallRelease')
          return async () => {
            throw new Error('postcommit lookup failed');
          };
        if (!useDraft && (key === 'createCall' || key === 'createFixtureCall'))
          return async (...args: unknown[]) => {
            entered();
            if (phase === 'before') await blocked;
            if (phase === 'failure') {
              phase = 'retry';
              throw new Error('admission temporarily unavailable');
            }
            const result = await value(...args);
            if (phase === 'after') await blocked;
            return result;
          };
        return value;
      },
    });
    const jobs: import('../src/test-call-runtime.ts').FixtureChildJob[] = [];
    const runtime = new TestCallRuntime({
      enabled: true,
      maxConcurrent: 1,
      execute: async (job) => {
        jobs.push(job);
        return {
          callId: job.callId,
          kind: 'test',
          status: 'completed',
          outcome: { reason: 'behavior_completed', outcome: 'completed' },
          events: [],
          selections: {},
          sttMode: 'none',
          usage: [],
          carrierFrames: [],
          compatIssues: [],
        };
      },
    });
    const app = Fastify();
    const distribution = await loadDistribution({ role: 'api', profile: 'compose', env: {} });
    registerTestCallRoutes({
      app,
      catalog: distribution.catalog,
      distributionDefaults: distribution.defaults,
      store: wrapped,
      requireRole: () => ({ workspaceId, identityId: 'test' }) as never,
      testCallRuntime: runtime,
      ...(phase === 'telemetry-failure'
        ? {
            telemetry: {
              tryEnqueue() {
                throw new Error('startup telemetry failed');
              },
            } as never,
          }
        : {}),
    });
    const request = {
      method: 'POST' as const,
      url: `/v1/agents/${agentId}/test-calls`,
      headers: { 'idempotency-key': 'identical' },
      payload: useDraft ? { useDraft: true } : { releaseId: release!.id },
    };
    let first = app.inject(request).then((reply) => reply);
    try {
      if (phase === 'telemetry-failure') {
        expect((await first).statusCode).toBe(500);
        const calls = await store.listCalls(workspaceId);
        expect(calls.items).toHaveLength(1);
        expect(calls.items[0]?.status).toBe('failed');
        expect(
          (await store.listCallEvents(workspaceId, calls.items[0]!.id)).items.at(-1),
        ).toMatchObject({
          type: 'fixture.error',
          payload: { message: 'startup telemetry failed' },
        });
        expect(jobs).toHaveLength(0);
        expect(runtime.activeCount).toBe(0);
        return;
      }
      if (!useDraft) {
        await writing;
        if (phase === 'retry') {
          expect((await first).statusCode).toBe(500);
          first = app.inject(request).then((reply) => reply);
        }
        const concurrentPromise = app.inject(request).then((reply) => reply);
        if (phase === 'before') {
          expect(
            await Promise.race([
              concurrentPromise.then((reply) => reply.statusCode),
              new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
            ]),
          ).toBe('pending');
          const changed = await app.inject({
            ...request,
            payload: { ...request.payload, callerScript: { turns: [] } },
          });
          expect(changed.statusCode, changed.body).toBe(409);
          expect(
            (await app.inject({ ...request, headers: { 'idempotency-key': 'another' } }))
              .statusCode,
          ).toBe(429);
          unblock();
        }
        const concurrent = await concurrentPromise;
        if (phase === 'lookup-failure')
          expect((await first).statusCode, (await first).body).toBe(202);
        expect(concurrent.statusCode, concurrent.body).toBe(202);
        unblock();
        expect(concurrent.json().callId).toBe((await first).json().callId);
      }
      const accepted = await first;
      expect(accepted.statusCode, accepted.body).toBe(202);
      await vi.waitFor(() => expect(jobs).toHaveLength(1));
      const call = await store.getCall(workspaceId, accepted.json().callId);
      expect(call?.kind).toBe('test');
      expect((await store.listCallEvents(workspaceId, call!.id)).items[0]?.type).toBe(
        'fixture.request',
      );
      if (useDraft) {
        expect(jobs[0]!.release.selections?.engine).toMatchObject({
          pluginId: distribution.defaults.engine,
        });
        expect((await store.getAgent(workspaceId, agentId))?.config).toEqual(agent.config);
        await store.updateAgent(
          workspaceId,
          agentId,
          agent.draftVersion,
          AgentConfig.parse({ ...agent.config, message: 'Edited after admission' }),
        );
        expect(jobs[0]!.release.config).toEqual(agent.config);
        expect(await store.getRelease(workspaceId, call!.releaseId)).toBeUndefined();
        expect((await store.listReleases(workspaceId, agentId)).items).toEqual([]);
      }
    } finally {
      unblock();
      await first;
      await vi.waitFor(() => expect(runtime.activeCount).toBe(0));
      await app.close();
      await store.close();
    }
  },
);
