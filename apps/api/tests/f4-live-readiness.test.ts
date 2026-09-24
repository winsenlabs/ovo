import { AgentConfig } from '@winsendotai/ovo-contracts';
import type { AgentDraft, ControlStore } from '@winsendotai/ovo-plugin-storage';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { catalog, fixture } from '../../../packages/session-host/tests/compat-support.ts';
import { liveReadiness } from '../src/live-readiness.ts';

const agent = (config: AgentDraft['config']): AgentDraft => ({
  id: 'agent',
  workspaceId: 'workspace',
  draftVersion: 1,
  config,
  createdAt: '',
  updatedAt: '',
});

describe('F4 live readiness inputs', () => {
  it('passes turn strategy, carrier frame size, and removed MCP discoveries to compat', async () => {
    const base = fixture({
      stt: {
        capabilities: {
          inputFormats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
          turnSignals: [],
          frameMs: { min: 40, max: 100, preferred: 40 },
        },
      },
    });
    base.selections!.engine!.config = { turnStrategy: 'provider' };
    const config = AgentConfig.parse({
      ...base.config,
      voice: { engine: { plugin: 'engine', config: { turnStrategy: 'provider' } } },
      tools: [
        {
          id: 'lookup',
          description: 'lookup',
          connector: 'mcp',
          connectionId: 'connection',
          remoteName: 'lookup',
          inputSchema: { type: 'object' },
          effect: 'read',
        },
      ],
      allowedTools: ['lookup'],
    });
    const store = {
      getMcpDiscoveredTool: async () => ({ removedAt: '2026-09-24T00:00:00.000Z' }),
      getProviderBinding: async () => undefined,
      getCredential: async () => undefined,
    } as unknown as ControlStore;
    const result = await liveReadiness(agent(config), store, base.registry, base.selections!);
    const codes = result.details.map((issue) => issue.code);
    expect(codes).toContain('turn_signal_missing');
    expect(codes).toContain('stt_frame_size');
    expect(codes).toContain('mcp_tool_removed');
  });

  it('reports a selected turn strategy that the engine cannot run', async () => {
    const base = fixture();
    base.selections!.engine!.config = { turnStrategy: 'smart-turn' };
    const config = AgentConfig.parse({
      ...base.config,
      voice: { engine: { plugin: 'engine', config: { turnStrategy: 'smart-turn' } } },
    });
    const result = await liveReadiness(
      agent(config),
      {
        getProviderBinding: async () => undefined,
        getCredential: async () => undefined,
      } as unknown as ControlStore,
      new PluginRegistry(catalog()),
      base.selections!,
    );
    expect(result.details).toContainEqual(
      expect.objectContaining({ code: 'engine_capability_missing', stage: 'live' }),
    );
  });

  it('reports a glibc-only selected plugin on a worker image without glibc', async () => {
    const base = fixture({
      llm: { runtime: { native: 'glibc', egressHosts: [], modelLicences: [] } },
    });
    const report = vi.spyOn(process.report, 'getReport').mockReturnValue({ header: {} } as never);
    try {
      const result = await liveReadiness(
        agent(base.config),
        {
          getProviderBinding: async () => undefined,
          getCredential: async () => undefined,
        } as unknown as ControlStore,
        base.registry,
        base.selections!,
      );
      expect(result.details).toContainEqual(
        expect.objectContaining({ code: 'runtime_incompatible', pluginId: 'llm', stage: 'live' }),
      );
    } finally {
      report.mockRestore();
    }
  });
});
