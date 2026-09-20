import { expect, it, vi } from 'vitest';
import { AgentConfig, type Inference, type ToolConnector } from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { withSessionFixtures } from '../src/index.ts';

it('replaces provider and every connector before their initialization', async () => {
  const initialize = vi.fn(() => {
    throw new Error('Real provider must not initialize');
  });
  const config = AgentConfig.parse({ name: 'Fixture isolation', mode: 'agent' });
  const services = [
    'ovo.inference',
    ...['native', 'http', 'mcp'].map((kind) => `ovo.tool-connector.${kind}`),
  ];
  const original = services.map((service, index) =>
    definePlugin(
      {
        id: `test.fixture.${index}`,
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        provides: [service],
        requires: [],
        configSchema: {},
        secretFields: [],
      },
      initialize,
    ),
  );
  const catalog = withSessionFixtures(config, original, {
    modelReplies: [{ kind: 'text', text: 'Explicit fixture reply' }],
    toolResults: { change: { fixture: true } },
  });
  const instance = await compose(
    catalog.map((plugin) => ({ id: plugin.manifest.id })),
    catalog,
  );
  try {
    const inference = instance.ctx.get('ovo.inference') as Inference;
    expect(await inference.generate({} as never)).toEqual({
      kind: 'text',
      text: 'Explicit fixture reply',
    });
    expect(await inference.generate({} as never)).toEqual({
      kind: 'text',
      text: config.uncertainty,
    });
    for (const service of services.slice(1)) {
      const connector = instance.ctx.get(service) as ToolConnector;
      expect(await connector.invoke({ id: 'change' } as never, {}, {} as never)).toEqual({
        fixture: true,
      });
      await expect(connector.invoke({ id: 'missing' } as never, {}, {} as never)).rejects.toThrow(
        'fixture is missing',
      );
    }
    expect(initialize).not.toHaveBeenCalled();
  } finally {
    await instance.dispose();
  }
});
