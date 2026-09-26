import { afterEach, expect, it, vi } from 'vitest';
import { AgentConfig, type EngineEvent } from '@winsendotai/ovo-contracts';
import {
  FakeClock,
  fixtureLlmPlugin,
  withEgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { plugins, STREAMING_VOICE_PLUGIN_IDS } from '../../plugin-voice/src/index.ts';
import { runFixtureCall } from '../src/run.ts';
import { input } from './support.ts';
import * as host from '../src/host-service.ts';

afterEach(() => vi.restoreAllMocks());

it('runs the native engine and confirmed fixture tool only after the prompt is played', async () => {
  await withEgressSentinel(
    async () => {
      const base = input();
      const clock = new FakeClock();
      const events: EngineEvent[] = [];
      const executions: number[] = [];
      const fixtureExtensions = host.fixtureExtensions;
      vi.spyOn(host, 'fixtureExtensions').mockImplementation((...args) => {
        const extensions = fixtureExtensions(...args);
        const handler = extensions.nativeHandlers.send!;
        return {
          ...extensions,
          nativeHandlers: {
            ...extensions.nativeHandlers,
            send: async (...handlerArgs) => {
              executions.push(events.length);
              return handler(...handlerArgs);
            },
          },
        };
      });
      const liveHandler = vi.fn(async () => {
        throw new Error('live handler reached');
      });
      const nativePackage = {
        packageName: '@fixture/native',
        packageVersion: '1.0.0',
        pluginId: '@fixture/native-marker',
        pluginVersion: '1.0.0',
        handlerIds: ['send'],
      };
      const config = AgentConfig.parse({
        ...base.release.config,
        mode: 'agent',
        tools: [
          {
            id: 'send',
            description: 'Send message',
            connector: 'native',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            effect: 'write',
            confirmation: true,
          },
        ],
        allowedTools: ['send'],
      });
      const registry = new PluginRegistry([
        ...base.registry
          .list()
          .filter((item) => item.manifest.id !== base.release.selections.engine.pluginId),
        ...plugins,
        fixtureLlmPlugin,
      ]);
      const call = runFixtureCall({
        ...base,
        clock,
        registry,
        callerScript: 'default',
        fixtureTemplates: {
          ...base.fixtureTemplates,
          [fixtureLlmPlugin.manifest.id]: (value) =>
            base.fixtureTemplates[fixtureLlmPlugin.manifest.id]!(value).map((script) => ({
              ...script,
              steps: script.steps.map((step, index) =>
                index === 1 && 'expect' in step && step.expect === 'http'
                  ? { ...step, where: { results: 1 } }
                  : step,
              ),
            })),
        },
        installedExtensions: {
          plugins: [],
          nativeHandlers: { send: liveHandler },
          nativeHandlerPackages: [nativePackage],
        },
        telemetry: {
          onEvent: (row) => {
            events.push(row.event);
          },
        },
        release: {
          ...base.release,
          config,
          plugins: [{ id: nativePackage.pluginId, version: nativePackage.pluginVersion }],
          selections: {
            ...base.release.selections,
            engine: {
              pluginId: STREAMING_VOICE_PLUGIN_IDS.sessionEngine,
              version: '0.1.0',
              config: {},
            },
            llm: {
              pluginId: fixtureLlmPlugin.manifest.id,
              version: fixtureLlmPlugin.manifest.version,
              bindingId: 'env',
              config: {},
            },
          },
        },
      });
      const completion = call.done.then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      await clock.advanceAsync(7000);
      await clock.advanceAsync(0);
      await clock.advanceAsync(0);
      const promptPlayed = events.findIndex(
        (event) =>
          event.type === 'agent.transcript' &&
          event.state === 'played' &&
          event.text.startsWith('Please confirm:'),
      );
      const yes = events.findIndex(
        (event) =>
          event.type === 'user.transcript' && event.text === 'yes' && event.stability === 'final',
      );
      await clock.advanceAsync(120_000);
      expect(promptPlayed, JSON.stringify(events)).toBeGreaterThanOrEqual(0);
      expect(yes, JSON.stringify(events)).toBeGreaterThan(promptPlayed);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toBeGreaterThan(yes);
      const completed = await completion;
      if ('error' in completed) throw completed.error;
      expect(
        completed.result.events.some(
          (row) =>
            row.event.type === 'agent.transcript' &&
            row.event.text === 'All done.' &&
            row.event.state === 'played',
        ),
      ).toBe(true);
      expect(liveHandler).not.toHaveBeenCalled();
    },
    { allowLoopback: false },
  );
});
