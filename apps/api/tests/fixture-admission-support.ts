import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
// Existing route-only fixtures model the new atomic port; durable concurrency is
// covered separately against SQLite and PostgreSQL, never by this in-memory fake.
export function mockFixtureAdmission(store: ControlStore): ControlStore {
  const releases = new Map<string, string>();
  return Object.assign(store, {
    async createFixtureCall(input: {
      workspaceId: string;
      id: string;
      agentId: string;
      fingerprint: string;
      releaseId: string;
    }) {
      const call = await store.createCall({ ...input, kind: 'test', status: 'running' });
      await store.appendCallEvent(input.workspaceId, input.id, 'fixture.request', {
        fingerprint: input.fingerprint,
        agentId: input.agentId,
        releaseId: input.releaseId,
      });
      releases.set(input.id, input.releaseId);
      return {
        created: true,
        call,
        release: await store.getRelease(input.workspaceId, input.releaseId),
      };
    },
    getFixtureCallRelease(workspaceId: string, callId: string) {
      return store.getRelease(workspaceId, releases.get(callId)!);
    },
  });
}
