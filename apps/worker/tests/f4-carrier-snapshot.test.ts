import { AgentConfig } from '@winsendotai/ovo-contracts';
import {
  twilioCarrierPlugin,
  twilioIngress,
} from '../../../packages/plugin-carrier-twilio/src/index.ts';
import { definePlugin, manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { WorkerCarrierRuntime } from '../src/carrier-runtime.ts';

describe('immutable outbound carrier selection', () => {
  it('reads the inbound route carrier instead of the release carrier', async () => {
    const alternate = definePlugin(
      {
        ...manifestKeys(twilioCarrierPlugin.manifest).manifest,
        id: '@example/alternate-carrier',
        provider: 'alternate',
        capabilities: { ...twilioIngress.capabilities, carrierId: 'alternate' },
      },
      () => undefined,
    );
    const release = {
      id: 'release-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      config: AgentConfig.parse({ name: 'Inbound', mode: 'announcement', message: 'Hello' }),
      selections: {
        carrier: {
          pluginId: twilioCarrierPlugin.manifest.id,
          version: twilioCarrierPlugin.manifest.version,
          bindingId: 'env',
          config: {},
        },
      },
      providerBindings: {},
      plugins: [],
    };
    const create = vi.fn(() => ({ hangup: async () => 'ended' }) as never);
    const runtime = new WorkerCarrierRuntime({
      registry: new PluginRegistry([twilioCarrierPlugin, alternate]),
      controls: new Map([
        [
          alternate.manifest.id,
          {
            version: alternate.manifest.version,
            factory: {
              capabilities: { ...twilioIngress.capabilities, carrierId: 'alternate' },
              create,
            },
          },
        ],
      ]),
      store: {
        getRelease: async () => release,
        getProviderBinding: async () => ({
          id: 'alternate-binding',
          workspaceId: 'workspace-1',
          provider: 'alternate',
          pluginId: alternate.manifest.id,
          credentialId: 'alternate-credential',
          config: { accountSid: `AC${'1'.repeat(32)}` },
        }),
      } as never,
      secrets: { forAgent: () => ({ resolve: async () => 'secret' }) } as never,
      defaults: { engine: '@winsendotai/ovo-plugin-voice-session-engine' },
      env: {},
      publicBaseUrl: 'https://voice.example.test',
      routeSecret: 'x'.repeat(32),
    });
    const selected = await runtime.forJob(
      {
        id: 'job-1',
        workspaceId: 'workspace-1',
        ownerEpoch: 1,
        payload: {
          kind: 'inbound_call',
          releaseId: 'release-1',
          carrierPluginId: alternate.manifest.id,
          carrierBindingId: 'alternate-binding',
        },
      },
      false,
    );
    expect(selected.carrier.carrierId).toBe('alternate');
    expect(selected.selections.carrier?.pluginId).toBe(alternate.manifest.id);
    expect(create).toHaveBeenCalled();
  });

  it('uses the release binding config even after the mutable binding row changes', async () => {
    const bindingId = 'binding-1';
    const release = {
      id: 'release-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      config: AgentConfig.parse({ name: 'Notice', mode: 'announcement', message: 'Hello' }),
      selections: {
        carrier: {
          pluginId: twilioCarrierPlugin.manifest.id,
          version: twilioCarrierPlugin.manifest.version,
          bindingId,
          binding: {
            provider: 'twilio',
            credentialId: 'credential-1',
            config: { accountSid: `AC${'2'.repeat(32)}` },
            fingerprint: 'f1',
            updatedAt: '2026-01-01',
          },
          config: {},
        },
      },
      providerBindings: {},
      plugins: [],
    };
    const getProviderBinding = vi.fn(async () => ({
      id: bindingId,
      workspaceId: 'workspace-1',
      provider: 'twilio',
      pluginId: twilioCarrierPlugin.manifest.id,
      credentialId: 'credential-1',
      config: { accountSid: `AC${'3'.repeat(32)}` },
    }));
    const create = vi.fn(
      () =>
        ({
          dial: async () => ({ kind: 'rejected' }),
          reconcile: async () => ({ kind: 'pending' }),
          hangup: async () => 'ended',
          handoff: async () => ({ kind: 'confirmed' }),
        }) as never,
    );
    const runtime = new WorkerCarrierRuntime({
      registry: new PluginRegistry([twilioCarrierPlugin]),
      controls: new Map([
        [
          twilioCarrierPlugin.manifest.id,
          {
            version: twilioCarrierPlugin.manifest.version,
            factory: { capabilities: twilioIngress.capabilities, create },
          },
        ],
      ]),
      store: { getRelease: async () => release, getProviderBinding } as never,
      secrets: { forAgent: () => ({ resolve: async () => 'secret' }) } as never,
      defaults: { engine: '@winsendotai/ovo-plugin-voice-session-engine' },
      env: {},
      publicBaseUrl: 'https://voice.example.test',
      routeSecret: 'x'.repeat(32),
    });
    const selected = await runtime.forJob(
      {
        id: 'job-1',
        workspaceId: 'workspace-1',
        ownerEpoch: 1,
        payload: { releaseId: 'release-1' },
      },
      false,
    );
    expect(selected.carrier.binding.config).toEqual({ accountSid: `AC${'2'.repeat(32)}` });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { accountSid: `AC${'2'.repeat(32)}` },
      }),
    );
    expect(getProviderBinding).not.toHaveBeenCalled();
  });
});
