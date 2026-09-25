import { createAnnouncementBehaviorPlugin } from '@winsendotai/ovo-behaviors';
import { AgentConfig, Cap, MULAW_8K } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { createSessionServicesPlugin, validateRelease } from '../src/release-runtime.ts';

const behavior = createAnnouncementBehaviorPlugin();
const agent = {
  id: 'agent-1',
  workspaceId: 'workspace-1',
  draftVersion: 1,
  config: AgentConfig.parse({ name: 'Notice', mode: 'announcement', message: 'Hello' }),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as never;
const services = createSessionServicesPlugin({} as never, {} as never, {});
const store = { getProviderBinding: async () => undefined } as never;

function fixtureEngine(requires: string[], applied: () => void) {
  return definePlugin(
    {
      id: 'fixture-engine',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'fixture',
      provides: [`${Cap.engine}@2`],
      requires,
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: {
        turnDetection: ['provider'],
        bargeIn: true,
        dtmf: true,
        confirmedPlayback: true,
        ownsProviders: false,
        formats: [MULAW_8K],
        consumesTurnDetector: false,
      },
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['engine@1'],
    },
    () => {
      applied();
      throw new Error('engine must not apply at release');
    },
  );
}

function pins(engine: ReturnType<typeof fixtureEngine>) {
  return [
    { id: behavior.manifest.id, version: behavior.manifest.version },
    { id: engine.manifest.id, version: engine.manifest.version },
  ];
}

describe('F4 release graph validation', () => {
  it('validates a data-selected v2 engine even when it is absent from release.plugins', async () => {
    const applied = vi.fn();
    const engine = fixtureEngine([Cap.behavior, 'missing.selected-port'], applied);
    await expect(
      validateRelease(
        agent,
        [{ id: behavior.manifest.id, version: behavior.manifest.version }],
        store,
        [behavior, engine],
        services,
        { engine: { pluginId: engine.manifest.id, version: engine.manifest.version, config: {} } },
      ),
    ).rejects.toThrow('Missing service missing.selected-port');
    expect(applied).not.toHaveBeenCalled();
  });

  it('validates explicit v2 engine dependencies without applying the engine', async () => {
    const applied = vi.fn();
    const engine = fixtureEngine([Cap.behavior, 'missing.engine-port'], applied);
    await expect(
      validateRelease(agent, pins(engine), store, [behavior, engine], services),
    ).rejects.toThrow('Missing service missing.engine-port');
    expect(applied).not.toHaveBeenCalled();
  });

  it('accepts an explicit v2 engine with host and behavior ports without applying it', async () => {
    const applied = vi.fn();
    const engine = fixtureEngine([Cap.behavior, Cap.media], applied);
    await expect(
      validateRelease(agent, pins(engine), store, [behavior, engine], services),
    ).resolves.toHaveLength(2);
    expect(applied).not.toHaveBeenCalled();
  });
});
