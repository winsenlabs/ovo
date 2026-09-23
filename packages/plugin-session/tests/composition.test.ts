import { describe, expect, it } from 'vitest';
import { AgentConfig, type Behavior, type OperationRecord } from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { createSessionPluginCatalog, behaviorPluginId } from '../src/index.ts';

function services() {
  const records = new Map<string, OperationRecord>();
  return definePlugin(
    {
      id: 'test.session-services',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: ['ovo.operation-store', 'ovo.secret-resolver'],
      requires: [],
      configSchema: {},
      secretFields: [],
    },
    (ctx) => {
      ctx.provide('ovo.operation-store', {
        createIntent: async (record: OperationRecord) => {
          if (records.has(record.id)) return false;
          records.set(record.id, record);
          return true;
        },
        get: async (_workspace: string, id: string) => records.get(id),
        settle: async (record: OperationRecord) => {
          records.set(record.id, record);
        },
      });
      ctx.provide('ovo.secret-resolver', {
        resolve: async () => {
          throw new Error('No live credentials in fixtures');
        },
      });
    },
  );
}
const inference = (agent = false) =>
  definePlugin(
    {
      id: 'test.inference',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: ['ovo.inference'],
      requires: [],
      configSchema: {},
      secretFields: [],
    },
    (ctx) => {
      ctx.provide('ovo.inference', {
        generate: async (request: { results: unknown[] }) =>
          agent && !request.results.length
            ? { kind: 'tool', toolId: 'check', input: {} }
            : { kind: 'text', text: 'Fixture verified.' },
      });
    },
  );

async function response(raw: unknown) {
  const config = AgentConfig.parse(raw);
  const catalog = createSessionPluginCatalog({
    config,
    workspaceId: 'local',
    bindings: {},
    output: { kind: 'simulation' },
    inferencePlugin: inference(config.mode === 'agent'),
    nativeHandlers: { check: async () => ({ ok: true }) },
    nativeHandlerPackages: [
      {
        packageName: 'fixture-native-tools',
        packageVersion: '1.0.0',
        pluginId: 'fixture-native-tools/native-handlers',
        pluginVersion: '1.0.0',
        handlerIds: ['check'],
      },
    ],
  });
  const system = services();
  const instance = await compose(
    [
      { id: system.manifest.id },
      ...catalog.map((plugin) => ({
        id: plugin.manifest.id,
        config:
          plugin.manifest.id === behaviorPluginId(config)
            ? { agent: config, workspaceId: 'local', sessionId: 'fixture' }
            : {},
      })),
    ],
    [system, ...catalog],
  );
  try {
    return await (instance.ctx.get('ovo.behavior') as Behavior).respond('check');
  } finally {
    await instance.dispose();
  }
}

describe('complete default session graphs', () => {
  it('runs announcement without any inference binding', async () => {
    expect(await response({ name: 'Announcement', mode: 'announcement', message: 'Hello.' })).toBe(
      'Hello.',
    );
  });
  it('runs deterministic FAQ without any inference binding', async () => {
    expect(
      await response({
        name: 'FAQ',
        mode: 'faq',
        faq: [{ id: 'q', question: 'check', answer: 'Approved answer.' }],
      }),
    ).toBe('Approved answer.');
  });
  it('runs context through an explicitly installed inference adapter', async () => {
    expect(await response({ name: 'Context', mode: 'context', context: 'Fixture facts.' })).toBe(
      'Fixture verified.',
    );
  });
  it('runs agent through the real shared execution boundary', async () => {
    expect(
      await response({
        name: 'Agent',
        mode: 'agent',
        allowedTools: ['check'],
        tools: [
          {
            id: 'check',
            connector: 'native',
            description: 'Fixture check',
            effect: 'read',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    ).toBe('Fixture verified.');
  });
  it('rejects missing provider and native implementation before effects', () => {
    const config = AgentConfig.parse({ name: 'Context', mode: 'context' });
    expect(() =>
      createSessionPluginCatalog({
        config,
        workspaceId: 'local',
        bindings: {},
        output: { kind: 'simulation' },
      }),
    ).toThrow('inference binding');
    const agent = AgentConfig.parse({
      name: 'Agent',
      mode: 'agent',
      allowedTools: ['unknown'],
      tools: [
        {
          id: 'unknown',
          connector: 'native',
          description: 'Missing implementation',
          effect: 'read',
          inputSchema: {},
        },
      ],
    });
    expect(() =>
      createSessionPluginCatalog({
        config: agent,
        workspaceId: 'local',
        bindings: {},
        output: { kind: 'simulation' },
        inferencePlugin: inference(),
      }),
    ).toThrow('not installed');
  });
  it('reports the unwired live inference path and rejects a cross-workspace snapshot', () => {
    const config = AgentConfig.parse({ name: 'Live Context', mode: 'context' });
    const input = {
      config,
      workspaceId: 'local',
      output: { kind: 'live' as const, plugin: inference() },
    };
    expect(() =>
      createSessionPluginCatalog({
        ...input,
        bindings: { inference: { workspaceId: 'other' } },
      }),
    ).toThrow('Inference binding belongs to another workspace');
    expect(() =>
      createSessionPluginCatalog({
        ...input,
        bindings: { inference: { workspaceId: 'local' } },
      }),
    ).toThrow('Live inference plugin is required until F4 wiring');
    expect(() =>
      createSessionPluginCatalog({
        ...input,
        bindings: { inference: { workspaceId: 'local' } },
        inferencePlugin: inference(),
      }),
    ).not.toThrow();
    expect(() =>
      createSessionPluginCatalog({
        ...input,
        bindings: { inference: { workspaceId: 'local' } },
        output: { kind: 'host' },
      }),
    ).not.toThrow();
  });
});
