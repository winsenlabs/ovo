import type {
  ExportInputLoader,
  LiveRecording,
  RecordingManifest,
  RedactedExportInput,
} from '@winsendotai/ovo-plugin-recordings';
import type { ControlStore, StoredCallEvent } from '@winsendotai/ovo-plugin-storage';

type ExportSourceStore = Pick<ControlStore, 'listCallEvents'>;
const EXPORT_EVENT_PAGE_SIZE = 100;
const EXPORT_EVENT_MAX_PAGES = 100;

/** Loads only the durable events for the repository-verified recording call. */
export function createRecordingExportInputLoader(store: ExportSourceStore): ExportInputLoader {
  return async (recording) => {
    const events: StoredCallEvent[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < EXPORT_EVENT_MAX_PAGES; pageNumber += 1) {
      const page = await store.listCallEvents(
        recording.workspaceId,
        recording.callId,
        EXPORT_EVENT_PAGE_SIZE,
        cursor,
      );
      if (page.items.length > EXPORT_EVENT_PAGE_SIZE)
        throw new Error('Recording export source returned an oversized event page');
      events.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      if (!cursor) return exportInput(recording, events);
    }
    throw new Error('Recording export source exceeds bounded event pages');
  };
}

export function publicManifest(manifest: RecordingManifest) {
  const { failure: _failure, ...artifact } = manifest;
  return {
    ...artifact,
    segments: manifest.segments.map(
      ({ objectKey: _objectKey, error: _error, ...segment }) => segment,
    ),
  };
}

export function publicRecording(recording: LiveRecording) {
  const { failure: _failure, ...safe } = recording;
  return safe;
}

export function publicExport<T extends { outputKey?: string; error?: string }>(job: T) {
  const { outputKey: _outputKey, error: internalError, ...safe } = job;
  return {
    ...safe,
    error: internalError ? 'Recording export failed' : undefined,
  };
}

export function transcriptLine(event: StoredCallEvent, callCreatedAt: string) {
  const text = eventText(event);
  if (!text || !/(transcript|speech|input|output|behavior)/i.test(event.type)) return [];
  const speakerValue = event.payload.speaker ?? event.payload.role;
  const speaker =
    speakerValue === 'customer' || speakerValue === 'agent' ? speakerValue : 'unknown';
  return [
    {
      eventId: event.id,
      sequence: event.sequence,
      atMs: Math.max(0, Date.parse(event.at) - Date.parse(callCreatedAt)),
      speaker,
      text: text.slice(0, 20_000),
      evidence: 'control-call-event-at',
      exactAudioAlignment: false,
    },
  ];
}

function exportInput(
  recording: Readonly<LiveRecording>,
  events: StoredCallEvent[],
): RedactedExportInput {
  const completed = new Set(
    events
      .filter((event) => event.type === 'speech.completed')
      .flatMap((event) => {
        const reference = eventReference(event);
        return reference ? [reference] : [];
      }),
  );
  return {
    transcript: events.flatMap((event) => {
      const text = eventText(event);
      if (!text) return [];
      const speaker = eventSpeaker(event);
      if (!speaker) return [];
      const reference = eventReference(event);
      return [
        {
          speaker,
          text: text.slice(0, 20_000),
          startMs: Math.max(0, Date.parse(event.at) - Date.parse(recording.createdAt)),
          playback:
            speaker === 'customer'
              ? undefined
              : event.type === 'speech.completed' || (reference ? completed.has(reference) : false)
                ? 'confirmed'
                : 'unplayed',
        } satisfies RedactedExportInput['transcript'][number],
      ];
    }),
    events: events.map((event) => ({
      atMs: Math.max(0, Date.parse(event.at) - Date.parse(recording.createdAt)),
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

function eventSpeaker(event: StoredCallEvent): 'customer' | 'agent' | undefined {
  const explicit = event.payload.speaker ?? event.payload.role;
  if (explicit === 'customer' || explicit === 'agent') return explicit;
  if (/transcript|input/i.test(event.type)) return 'customer';
  if (/speech|output|behavior/i.test(event.type)) return 'agent';
  return undefined;
}

function eventReference(event: StoredCallEvent): string | undefined {
  const value = event.payload.segmentId ?? event.payload.responseId ?? event.payload.turnId;
  return typeof value === 'string' && value.length <= 200 ? value : undefined;
}
