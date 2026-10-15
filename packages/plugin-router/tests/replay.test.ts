import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  HandoffBeginFailure,
  MemberClaim,
  RouterEntry,
  RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import { exampleRoutingSnapshot, type EngineScript } from '../src/testing.ts';
import { dtmf, idle, opening, routerHarness } from './harness.ts';

/**
 * Router conversations as JSONL, one per line: the caller's turns, what each scripted engine
 * answers (rules always run for real), how claims and prepares behave, and what must come out:
 * the line the router says each turn, the `route.*` events in order (each a subset of the
 * payload), and the completion reason. Adding a conversation is adding a line.
 *
 * R2 conversations (`router-transfer-conversations.jsonl`) may also offer the host's `begin`
 * (`true`, or a refusal for the first begin), give the point a `transfer` policy, compose the
 * router for a re-route (`entry`), and list what each `begun` request must contain.
 */
interface Conversation {
  name: string;
  engines: EngineScript;
  claims?: 'full';
  prepare?: string;
  begin?: true | HandoffBeginFailure;
  transfer?: Record<string, unknown>;
  /** R3: the release binds the human queue `desk`, and the `intent` node falls back through these. */
  humanQueue?: { fallback: unknown[] };
  entry?: RouterEntry;
  begun?: Record<string, unknown>[];
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

const read = (file: string): Conversation[] =>
  readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Conversation);
const conversations = read('router-conversations.jsonl');
const transfers = read('router-transfer-conversations.jsonl');

function beginScript(begin: Conversation['begin']) {
  if (begin === undefined || begin === true) return begin;
  let refused = false;
  return () => {
    if (refused) return { ok: true as const, handoffId: 'begin-ok', state: 'preparing' as const };
    refused = true;
    return { ok: false as const, reason: begin };
  };
}

const QUEUE_ID = '00000000-0000-4000-8000-0000000000e1';

function withQueue(conversation: Conversation): RoutingReleaseSnapshot {
  return exampleRoutingSnapshot((raw) => {
    raw.schemaVersion = 3;
    raw.transfer = conversation.transfer;
    raw.nodes[0].fallback = conversation.humanQueue!.fallback;
    raw.humanQueues = [{ key: 'desk', queueId: QUEUE_ID, priority: 0 }];
    raw.queues = {
      [QUEUE_ID]: {
        id: QUEUE_ID,
        version: 1,
        key: 'desk',
        priority: 0,
        definition: {
          kind: 'managed',
          name: 'Desk',
          announcement: { en: 'A colleague will take over.' },
        },
      },
    };
  });
}

async function replay(conversation: Conversation) {
  const begin = beginScript(conversation.begin);
  const human = conversation.humanQueue;
  const h = routerHarness({
    script: conversation.engines,
    ...(conversation.transfer
      ? {
          patch: (raw) => {
            raw.schemaVersion = 2;
            raw.transfer = conversation.transfer;
          },
        }
      : {}),
    // Schema 3 pins each bound queue under `queues`.
    ...(human
      ? {
          snapshot: withQueue(conversation),
        }
      : {}),
    ...(conversation.claims === 'full'
      ? { host: { claim: (): MemberClaim => ({ kind: 'full' }) } }
      : {}),
    handoff: {
      ...(begin ? { begin } : {}),
      ...(conversation.prepare
        ? {
            prepare: () => ({
              ok: false as const,
              reason: conversation.prepare as 'compose_failed',
            }),
          }
        : {}),
    },
    ...(conversation.entry ? { ports: { entry: conversation.entry } } : {}),
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
  expect(routeEvents.map((event) => event.type)).toEqual(conversation.events.map(([type]) => type));
  routeEvents.forEach((event, index) =>
    expect(event.payload).toMatchObject(conversation.events[index]![1]),
  );
  if (conversation.begun) {
    expect(h.handoff.prepared).toEqual([]);
    expect(h.handoff.begun).toHaveLength(conversation.begun.length);
    h.handoff.begun.forEach((request, index) =>
      expect(request).toMatchObject(conversation.begun![index]!),
    );
  }
  h.receipt(last);
  expect(h.behavior.isComplete()).toBe(true);
  expect(h.behavior.completionReason()).toBe(conversation.completionReason);
}

describe('router replay', () => {
  it('has conversations to replay', () => {
    expect(conversations.length).toBeGreaterThanOrEqual(5);
    expect(transfers.length).toBeGreaterThanOrEqual(6);
  });

  it.each(conversations.map((conversation) => [conversation.name, conversation] as const))(
    '%s',
    async (_name, conversation) => replay(conversation),
  );

  it.each(transfers.map((conversation) => [conversation.name, conversation] as const))(
    'R2: %s',
    async (_name, conversation) => replay(conversation),
  );
});
