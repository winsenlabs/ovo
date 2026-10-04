import { createProductionRecordingsPlugin } from '@winsendotai/ovo-plugin-recordings/production';
import {
  productionRecordingsFromEnv,
  type RedactedExportInput,
} from '@winsendotai/ovo-plugin-recordings';
import type { ControlStore, StoredCallEvent } from '@winsendotai/ovo-plugin-storage';

const EXPORT_EVENT_PAGE_SIZE = 100;
const EXPORT_EVENT_MAX_PAGES = 100;

export function createWorkerRecordingsPlugin(store: ControlStore, databaseUrl: string) {
  const config = productionRecordingsFromEnv(databaseUrl);
  if (!config) throw new Error('Production recording storage is not configured');
  return createProductionRecordingsPlugin(config, {
    loadExportInput: async (recording, options) => {
      const events = await loadCallEvents(
        store,
        recording.workspaceId,
        recording.callId,
        options?.signal,
      );
      return exportInput(recording.createdAt, events);
    },
  });
}

export function recordingRetentionDays(): number {
  const value = Number(process.env.OVO_RECORDING_RETENTION_DAYS ?? 30);
  if (!Number.isSafeInteger(value) || value < 1 || value > 365)
    throw new Error('OVO_RECORDING_RETENTION_DAYS must be an integer between 1 and 365');
  return value;
}

async function loadCallEvents(
  store: Pick<ControlStore, 'listCallEvents'>,
  workspaceId: string,
  callId: string,
  signal?: AbortSignal,
): Promise<StoredCallEvent[]> {
  const events: StoredCallEvent[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < EXPORT_EVENT_MAX_PAGES; pageNumber += 1) {
    signal?.throwIfAborted();
    const page = await store.listCallEvents(workspaceId, callId, EXPORT_EVENT_PAGE_SIZE, cursor);
    signal?.throwIfAborted();
    if (page.items.length > EXPORT_EVENT_PAGE_SIZE)
      throw new Error('Recording export source returned an oversized event page');
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (!cursor) return events;
  }
  throw new Error('Recording export source exceeds bounded event pages');
}

function exportInput(createdAt: string, events: StoredCallEvent[]): RedactedExportInput {
  const confirmed = new Set(
    events
      .filter(
        (event) =>
          event.type === 'speech.completed' &&
          event.payload.evidence === 'confirmed' &&
          event.payload.humanHeard === true,
      )
      .flatMap((event) => {
        const reference = eventReference(event);
        return reference ? [reference] : [];
      }),
  );
  return {
    transcript: events.flatMap((event) => {
      if (event.type !== 'transcript.accepted' && event.type !== 'speech.generated') return [];
      const text = eventText(event);
      if (!text) return [];
      const speaker = event.type === 'transcript.accepted' ? 'customer' : 'agent';
      const reference = eventReference(event);
      return [
        {
          speaker,
          text: text.slice(0, 20_000),
          startMs: Math.max(0, Date.parse(event.at) - Date.parse(createdAt)),
          playback:
            speaker === 'customer'
              ? undefined
              : reference && confirmed.has(reference)
                ? 'confirmed'
                : 'unplayed',
        } satisfies RedactedExportInput['transcript'][number],
      ];
    }),
    events: events.map((event) => ({
      atMs: Math.max(0, Date.parse(event.at) - Date.parse(createdAt)),
      type: event.type.slice(0, 200),
    })),
  };
}

function eventText(event: StoredCallEvent): string | undefined {
  return typeof event.payload.text === 'string'
    ? event.payload.text
    : typeof event.payload.transcript === 'string'
      ? event.payload.transcript
      : undefined;
}

function eventReference(event: StoredCallEvent): string | undefined {
  const value = event.payload.segmentId ?? event.payload.responseId ?? event.payload.turnId;
  return typeof value === 'string' && value.length <= 200 ? value : undefined;
}
