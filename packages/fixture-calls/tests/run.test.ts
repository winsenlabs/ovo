import { describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { AgentConfig, Cap } from '@winsendotai/ovo-contracts';
import {
  FakeClock,
  fixtureCarrierIngress,
  fixtureInboundFrame,
  fixtureLlmPlugin,
  fixtureSttPlugin,
  FIXTURE_STT_CAPABILITIES,
  withEgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import {
  fixtureCarrierInboundFrame,
  runFixtureCall,
  withFixtureEgressSentinel,
} from '../src/index.ts';
import { fixtureExtensions } from '../src/host-service.ts';
import { input } from './support.ts';

describe('runFixtureCall', () => {
  it('runs selected engine and serializer with FixtureNet, retaining speech, transcript, timing and outcome', async () => {
    const clock = new FakeClock();
    const result = await withEgressSentinel(async (sentinel) => {
      const call = runFixtureCall({
        ...input(),
        clock,
        callId: '6fb07390-0a23-48b0-8d68-c1716c482732',
      });
      await clock.advanceAsync(0);
      const result = await call.done;
      expect(sentinel.attempts).toEqual([]);
      return result;
    });
    expect(result.outcome).toEqual({ reason: 'behavior_completed', outcome: 'completed' });
    expect(result.callId).toBe('6fb07390-0a23-48b0-8d68-c1716c482732');
    expect(result.events.map((row) => row.event.type)).toEqual(
      expect.arrayContaining([
        'user.transcript',
        'user.turn',
        'agent.transcript',
        'timing',
        'speech',
        'end',
      ]),
    );
    expect(result.carrierFrames.some((frame) => JSON.parse(frame).event === 'media')).toBe(true);
    expect(result.sttMode).toBe('template');
    expect(result.compatIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'meter_uncovered', severity: 'warning', stage: 'test' }),
      ]),
    );
    expect(result.usage.every((meter) => meter.state === 'estimated')).toBe(true);
  });

  it.each([false, true])(
    'opens recording only when release.config.recording is %s',
    async (enabled) => {
      const clock = new FakeClock();
      const tracks: string[] = [];
      const open = vi.fn(() => ({
        write: (track: string) => {
          tracks.push(track);
        },
        finish: () => ({ id: 'recording-1' }),
      }));
      const call = runFixtureCall({ ...input(enabled), clock, recording: { open } });
      await clock.advanceAsync(0);
      const result = await call.done;
      expect(open).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(result.recording).toEqual(enabled ? { id: 'recording-1' } : undefined);
      if (enabled) expect(tracks).toEqual(expect.arrayContaining(['caller', 'agent']));
      else expect(tracks).toEqual([]);
    },
  );

  it('refuses an enabled recording when no recording port can create an artifact', () => {
    expect(() => runFixtureCall(input(true))).toThrow(
      'fixture_unavailable: recording port is required for this release',
    );
  });

  it('prefers a provider template to an invalid static script and reports missing LLM fixtures', async () => {
    const base = input();
    const fixture = {
      host: 'fixture.invalid',
      source: 'bad static',
      retrieved: '2026-09-25',
      steps: [
        {
          expect: 'http' as const,
          method: 'POST',
          url: 'https://fixture.invalid/never',
          reply: { status: 200 },
        },
      ],
    };
    const clock = new FakeClock();
    const call = runFixtureCall({
      ...base,
      clock,
      fixtures: { ...base.fixtures, [fixtureSttPlugin.manifest.id]: [fixture] },
    });
    await clock.advanceAsync(0);
    expect((await call.done).sttMode).toBe('template');
    // A selected LLM with no fixture is rejected before graph composition or network use.
    const registry = new PluginRegistry([...base.registry.list(), fixtureLlmPlugin]);
    const withoutLlmTemplate = { ...base.fixtureTemplates };
    delete withoutLlmTemplate[fixtureLlmPlugin.manifest.id];
    expect(() =>
      runFixtureCall({
        ...base,
        registry,
        fixtureTemplates: withoutLlmTemplate,
        release: {
          ...base.release,
          config: { ...base.release.config, mode: 'context' },
          selections: {
            ...base.release.selections,
            llm: {
              pluginId: fixtureLlmPlugin.manifest.id,
              version: '0.1.0',
              bindingId: 'env',
              config: {},
            },
          },
        },
      }),
    ).toThrow(/fixture_unavailable/);
  });

  it('falls back to the conformance STT only after the selected provider has no fixture', async () => {
    const base = input();
    const selectedStt = definePlugin(
      {
        id: 'selected-stt-without-fixture',
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'stt',
        provider: 'selected',
        provides: [`${Cap.stt}@2`],
        capabilities: FIXTURE_STT_CAPABILITIES,
        conformance: ['stt@1'],
        meters: [
          { key: 'selected.stt.audio_seconds', unit: 'audio_seconds', label: 'Audio', role: 'stt' },
        ],
        runtime: { egressHosts: [], modelLicences: [] },
        configSchema: { type: 'object' },
      },
      () => {
        throw new Error('selected STT must be replaced before composition');
      },
    );
    const clock = new FakeClock();
    const call = runFixtureCall({
      ...base,
      clock,
      registry: new PluginRegistry([...base.registry.list(), selectedStt]),
      release: {
        ...base.release,
        selections: {
          ...base.release.selections,
          stt: {
            pluginId: selectedStt.manifest.id,
            version: '1.0.0',
            bindingId: 'env',
            config: {},
          },
        },
      },
    });
    await clock.advanceAsync(0);
    const result = await call.done;
    expect(result.sttMode).toBe('fixture-generic');
    expect(result.selections.stt?.id).toBe(fixtureSttPlugin.manifest.id);
  });

  it('rejects a selected carrier with no published fixture', () => {
    const base = input();
    expect(() => runFixtureCall({ ...base, fixtures: {} })).toThrow(/fixture_unavailable/);
  });

  it('fails the call if an engine hides a direct egress attempt', async () => {
    const fallback = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
    try {
      const clock = new FakeClock();
      const call = runFixtureCall({ ...input(false, true), clock });
      const rejected = expect(call.done).rejects.toThrow(
        /Egress blocked.*fetch https:\/\/egress-forbidden\.invalid/,
      );
      await clock.advanceAsync(0);
      await rejected;
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
    }
  });

  it('does not expose a live parent ledger or carrier control to the selected engine', async () => {
    const clock = new FakeClock();
    const get = vi.fn(() => ({ reserve: vi.fn(), dial: vi.fn() }));
    const call = runFixtureCall({
      ...input(),
      clock,
      parent: {
        keys: new Set([Cap.costLedger, Cap.carrierControl]),
        get,
        all: () => new Map(),
      },
    });
    await clock.advanceAsync(0);
    expect((await call.done).outcome.outcome).toBe('completed');
    expect(get).not.toHaveBeenCalled();
  });

  it('substitutes fixture native handlers without invoking installed handlers', async () => {
    const base = input();
    const live = vi.fn(async () => {
      throw new Error('live handler was invoked');
    });
    const config = AgentConfig.parse({
      ...base.release.config,
      tools: [
        {
          id: 'write',
          description: 'Write',
          connector: 'native',
          effect: 'write',
          confirmation: true,
          inputSchema: { type: 'object' },
          outputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      ],
    });
    const extensions = fixtureExtensions(config, { plugins: [], nativeHandlers: { write: live } });
    expect(
      await extensions.nativeHandlers.write!(
        {},
        {
          signal: new AbortController().signal,
          operationId: 'op',
          workspaceId: 'workspace-1',
        },
      ),
    ).toEqual({ ok: true });
    expect(live).not.toHaveBeenCalled();
  });

  it('exposes an inbound-frame helper only for the conformance carrier', () => {
    expect(fixtureCarrierInboundFrame(fixtureCarrierIngress())).toBe(fixtureInboundFrame);
    expect(
      fixtureCarrierInboundFrame({ ...fixtureCarrierIngress(), carrierId: 'other' }),
    ).toBeUndefined();
  });

  it('guards child setup before a carrier plugin can apply', async () => {
    const fallback = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
    try {
      await withFixtureEgressSentinel(async (sentinel) => {
        await expect(globalThis.fetch('https://setup-egress.invalid')).rejects.toThrow(
          /Egress blocked/,
        );
        expect(sentinel.attempts).toEqual(['fetch https://setup-egress.invalid']);
      });
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
    }
  });

  it('blocks a provider template from opening a loopback socket during setup', () => {
    const fallback = vi.spyOn(net, 'connect').mockImplementation((() => {
      throw new Error('socket reached');
    }) as typeof net.connect);
    try {
      const base = input();
      expect(() =>
        runFixtureCall({
          ...base,
          fixtureTemplates: {
            ...base.fixtureTemplates,
            [fixtureSttPlugin.manifest.id]: () => {
              net.connect(1, '127.0.0.1');
              return [];
            },
          },
        }),
      ).toThrow(/Egress blocked.*net.connect 127\.0\.0\.1:1/);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
    }
  });

  it('blocks loopback TCP even inside the child setup fence', async () => {
    const fallback = vi.spyOn(net, 'connect').mockImplementation((() => {
      throw new Error('socket reached');
    }) as typeof net.connect);
    try {
      await withFixtureEgressSentinel(() => {
        expect(() => net.connect(1, '127.0.0.1')).toThrow(/Egress blocked/);
      });
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
    }
  });
});
