import { FakeClock, fixtureLlmPlugin } from '@winsendotai/ovo-conformance/drivers';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { callerPlayback } from '../src/default-script.ts';
import { runFixtureCall } from '../src/run.ts';
import { input } from './support.ts';

describe('default fixture caller', () => {
  it('waits for delayed confirmation playback before sending the default yes', async () => {
    const clock = new FakeClock();
    const said: string[] = [];
    const hangup = vi.fn();
    const caller = callerPlayback({
      clock,
      script: {
        turns: [
          { atMs: 0, say: 'Please do that.' },
          { atMs: 1200, say: 'yes' },
        ],
      },
      reactiveConfirmation: true,
      say: (text) => said.push(text),
      dtmf: () => undefined,
      hangup,
    });
    try {
      caller.start();
      await clock.advanceAsync(7000);
      expect(said).toEqual(['Please do that.']);
      expect(hangup).not.toHaveBeenCalled();
      const prompt =
        'Please confirm: Send message. Details: {}. Say yes to proceed or no to cancel.';
      caller.onEvent({
        type: 'agent.transcript',
        segmentId: 'confirm',
        text: prompt,
        state: 'generated',
      });
      expect(said).toEqual(['Please do that.']);
      caller.onEvent({
        type: 'agent.transcript',
        segmentId: 'confirm',
        text: prompt,
        state: 'played',
      });
      await clock.advanceAsync(0);
      expect(said).toEqual(['Please do that.', 'yes']);
      caller.onEvent({
        type: 'agent.transcript',
        segmentId: 'confirm',
        text: prompt,
        state: 'played',
      });
      await clock.advanceAsync(0);
      expect(said.filter((text) => text === 'yes')).toHaveLength(1);
    } finally {
      caller.cancel();
    }
  });

  it('refuses a default agent write until the fixture STT transcript can wait for playback', () => {
    const base = input();
    const config = AgentConfig.parse({
      ...base.release.config,
      mode: 'agent',
      tools: [
        {
          id: 'send',
          description: 'Send message',
          connector: 'native',
          inputSchema: { type: 'object' },
          effect: 'write',
          confirmation: true,
        },
      ],
      allowedTools: ['send'],
    });
    const registry = new PluginRegistry([...base.registry.list(), fixtureLlmPlugin]);
    expect(() => {
      const call = runFixtureCall({
        ...base,
        registry,
        callerScript: 'default',
        release: {
          ...base.release,
          config,
          selections: {
            ...base.release.selections,
            llm: {
              pluginId: fixtureLlmPlugin.manifest.id,
              version: fixtureLlmPlugin.manifest.version,
              bindingId: 'env',
              config: {},
            },
          },
        },
      });
      void call.done.catch(() => undefined);
    }).toThrow('fixture_unavailable: confirmed write needs playback-gated STT replay');
  });
});
