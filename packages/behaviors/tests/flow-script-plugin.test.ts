import { describe, expect, it } from 'vitest';
import { AgentConfig, Cap, type Behavior } from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { BEHAVIOR_SERVICE_KEYS, createAnnouncementBehaviorPlugin } from '../src/index.ts';
import { scriptedJev } from './flow-fixture.ts';

const agent = AgentConfig.parse({
  name: 'Reminder',
  mode: 'announcement',
  decision: { enabled: true },
  script: {
    start: 'ask',
    nodes: [
      {
        id: 'ask',
        prompt: 'Shall I send the link?',
        transitions: [{ event: 'text', matches: ['yes'], to: 'sent' }],
      },
      { id: 'sent', prompt: 'Sent.', terminal: true },
    ],
  },
});

const announcement = createAnnouncementBehaviorPlugin();

/**
 * The script plugins read the decision plugin through the wave 3 cross-lane request to
 * `behaviors/src/index.ts`; until it is applied they compose exactly as before and this is skipped.
 */
const wired = (announcement.manifest as { optional?: readonly string[] }).optional?.includes(
  BEHAVIOR_SERVICE_KEYS.decision,
);

describe.skipIf(!wired)('a script plugin with a decision plugin selected (AGT-14)', () => {
  it('matches an unwritten reply to a transition through the decision plugin', async () => {
    const jev = scriptedJev([{ intent: 'option_1' }]);
    const decider = definePlugin(
      {
        id: 'decider',
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        requires: [],
        provides: [Cap.decision],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.decision, jev.port);
      },
    );
    const composition = await compose(
      [{ id: 'decider' }, { id: announcement.manifest.id, config: { agent } }],
      [decider, announcement],
    );
    try {
      const behavior = composition.ctx.get(Cap.behavior) as Behavior;
      behavior.beginTurn!(0);
      const prompt = await behavior.respond('');
      behavior.onPlayback!({
        id: 'r',
        text: prompt,
        epoch: 0,
        state: 'completed',
        evidence: 'confirmed',
      });
      behavior.beginTurn!(1);
      expect(await behavior.respond('haan bhej do')).toBe('Sent.');
      expect(jev.requests).toHaveLength(1);
    } finally {
      await composition.dispose();
    }
  });

  it('composes without a decision plugin, matching exactly as before', async () => {
    const composition = await compose(
      [{ id: announcement.manifest.id, config: { agent } }],
      [announcement],
    );
    try {
      const behavior = composition.ctx.get(Cap.behavior) as Behavior;
      behavior.beginTurn!(0);
      const prompt = await behavior.respond('');
      behavior.onPlayback!({
        id: 'r',
        text: prompt,
        epoch: 0,
        state: 'completed',
        evidence: 'confirmed',
      });
      behavior.beginTurn!(1);
      expect(await behavior.respond('haan bhej do')).toBe('Please clarify your question.');
      expect(await behavior.respond('yes')).toBe('Sent.');
    } finally {
      await composition.dispose();
    }
  });
});
