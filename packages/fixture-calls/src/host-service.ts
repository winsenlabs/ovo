import {
  Cap,
  type Clock,
  type EngineEvent,
  type MediaDuplex,
  type OperationRecord,
  type OperationStore,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import type { AgentConfig } from '@winsendotai/ovo-contracts';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import { sampleFor } from '@winsendotai/ovo-conformance/drivers';

/** Installed native handlers retain their pins, but never execute production side effects. */
export function fixtureExtensions(
  config: AgentConfig,
  installed: InstalledSessionExtensions | undefined,
): InstalledSessionExtensions {
  const source = installed ?? { plugins: [], nativeHandlers: {} };
  const tools = new Map(config.tools.map((tool) => [tool.id, tool]));
  return {
    ...source,
    nativeHandlers: Object.fromEntries(
      Object.keys(source.nativeHandlers).map((id) => [
        id,
        async () => sampleFor(tools.get(id)?.outputSchema ?? { type: 'object' }),
      ]),
    ),
  };
}

/** Ephemeral tool intents only; no cost ledger, reservations, or live secret access. */
export function fixtureHostService(input: {
  media: MediaDuplex;
  clock: Clock;
  usage: UsageSink;
  transcript: (
    event: Extract<EngineEvent, { type: 'user.transcript' | 'agent.transcript' }>,
  ) => void;
}) {
  const operations = new Map<string, OperationRecord>();
  const operationStore: OperationStore = {
    async createIntent(record) {
      if (operations.has(record.id)) return false;
      operations.set(record.id, structuredClone(record));
      return true;
    },
    async get(workspaceId, id) {
      const record = operations.get(id);
      return record?.workspaceId === workspaceId ? structuredClone(record) : undefined;
    },
    async settle(record) {
      operations.set(record.id, structuredClone(record));
    },
  };
  return definePlugin(
    {
      id: '@winsendotai/ovo-fixture-calls/host',
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      provides: [Cap.operationStore, Cap.secrets, Cap.media, Cap.usage, Cap.transcripts, Cap.clock],
      configSchema: { type: 'object', additionalProperties: false },
    },
    (ctx) => {
      ctx.provide(Cap.operationStore, operationStore);
      ctx.provide(Cap.secrets, {
        resolve: async () => {
          throw new Error('fixture_unavailable: live secrets are disabled');
        },
      });
      ctx.provide(Cap.media, input.media);
      ctx.provide(Cap.usage, input.usage);
      ctx.provide(Cap.transcripts, input.transcript);
      ctx.provide(Cap.clock, input.clock);
    },
  );
}
