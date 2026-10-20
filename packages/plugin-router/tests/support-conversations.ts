import { readFileSync } from 'node:fs';
import type { RouterEntry, RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { exampleRoutingSnapshot, type EngineScript } from '../src/testing.ts';
import type { SimBody } from './support-sim.ts';

/** A router conversation as the JSONL fixtures store it (see replay.test.ts). */
export interface Conversation {
  name: string;
  engines: EngineScript;
  claims?: 'full';
  prepare?: string;
  begin?: true | string;
  transfer?: Record<string, unknown>;
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

export const readConversations = (file: string): Conversation[] =>
  readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Conversation);

const QUEUE_ID = '00000000-0000-4000-8000-0000000000e1';

/** The snapshot a conversation runs on: the example, with its transfer policy and human queue. */
export function snapshotFor(conversation: Conversation): RoutingReleaseSnapshot {
  if (conversation.humanQueue)
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
  return exampleRoutingSnapshot(
    conversation.transfer
      ? (raw) => {
          raw.schemaVersion = 2;
          raw.transfer = conversation.transfer;
        }
      : undefined,
  );
}

/** The scripted engine answers of a conversation as simulation answers (model ids are not simulated). */
export function answersOf(engines: EngineScript): NonNullable<SimBody['engines']>['answers'] {
  return Object.entries(engines).flatMap(([node, kinds]) =>
    Object.entries(kinds).flatMap(([engine, results]) =>
      (results ?? []).map(({ modelId: _model, ...result }) => ({
        node,
        engine: engine as 'decision' | 'llm' | 'external',
        ...result,
      })),
    ),
  );
}

/** Why a conversation cannot be a simulation, or undefined: it uses a per-test port trick. */
export function notSimulable(conversation: Conversation): string | undefined {
  if (conversation.entry) return 'a re-route entry is a worker feature';
  if (conversation.turns.some((turn) => 'advanceMs' in turn)) return 'it moves the clock by hand';
  if (typeof conversation.begin === 'string' && conversation.begin !== 'no_operators')
    return 'it refuses the first begin by a port trick';
  return undefined;
}
