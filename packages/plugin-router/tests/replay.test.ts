import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MemberClaim } from '@winsendotai/ovo-contracts';
import type { EngineScript } from '../src/testing.ts';
import { dtmf, idle, opening, routerHarness } from './harness.ts';

/**
 * Router conversations as JSONL, one per line: the caller's turns, what each scripted engine
 * answers (rules always run for real), how claims and prepares behave, and what must come out:
 * the line the router says each turn, the `route.*` events in order (each a subset of the
 * payload), and the completion reason. Adding a conversation is adding a line.
 */
interface Conversation {
  name: string;
  engines: EngineScript;
  claims?: 'full';
  prepare?: string;
  turns: (
    | { opening: true }
    | { idle: true }
    | { text: string }
    | { digits: string }
    | { advanceMs: number }
  )[];
  says: (string | null)[];
  events: [string, Record<string, unknown>][];
  completionReason: string;
}

const conversations: Conversation[] = readFileSync(
  new URL('./fixtures/router-conversations.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Conversation);

describe('router replay', () => {
  it('has conversations to replay', () => {
    expect(conversations.length).toBeGreaterThanOrEqual(5);
  });

  it.each(conversations.map((conversation) => [conversation.name, conversation] as const))(
    '%s',
    async (_name, conversation) => {
      const h = routerHarness({
        script: conversation.engines,
        ...(conversation.claims === 'full'
          ? { host: { claim: (): MemberClaim => ({ kind: 'full' }) } }
          : {}),
        ...(conversation.prepare
          ? {
              handoff: {
                prepare: () => ({
                  ok: false as const,
                  reason: conversation.prepare as 'compose_failed',
                }),
              },
            }
          : {}),
      });
      const said: (string | null)[] = [];
      let last = 0;
      for (const turn of conversation.turns) {
        if ('advanceMs' in turn) {
          h.host.advance(turn.advanceMs);
          said.push(null);
          continue;
        }
        const reply =
          'opening' in turn
            ? await h.turn('', opening)
            : 'idle' in turn
              ? await h.turn('', idle)
              : 'digits' in turn
                ? await h.turn(turn.digits, dtmf(turn.digits))
                : await h.turn(turn.text);
        said.push(reply.say);
        last = reply.epoch;
      }
      expect(said).toEqual(conversation.says);
      const routeEvents = h.events.filter((event) => event.type.startsWith('route.'));
      expect(routeEvents.map((event) => event.type)).toEqual(
        conversation.events.map(([type]) => type),
      );
      routeEvents.forEach((event, index) =>
        expect(event.payload).toMatchObject(conversation.events[index]![1]),
      );
      h.receipt(last);
      expect(h.behavior.isComplete()).toBe(true);
      expect(h.behavior.completionReason()).toBe(conversation.completionReason);
    },
  );
});
