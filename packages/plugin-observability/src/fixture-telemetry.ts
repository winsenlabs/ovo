import type { EngineEvent, EndReason, UsageMeter } from '@winsendotai/ovo-contracts';
import type { BufferedTelemetryWriter } from './telemetry-ingestion.ts';
import { TurnTelemetryCollector } from './turn-telemetry.ts';
import { WorkerTelemetryAdapter } from './worker-telemetry-adapter.ts';

/** Feeds fixture calls through the same bounded telemetry writer as live and simulation calls. */
export function createFixtureTelemetry(
  writer: BufferedTelemetryWriter | undefined,
  input: {
    workspaceId: string;
    callId: string;
    agentId: string;
    releaseId: string;
    language: string;
  },
) {
  if (!writer) return undefined;
  let sequence = 0;
  const adapter = new WorkerTelemetryAdapter(writer, {
    ...input,
    source: 'test',
    nextSequence: () => sequence++,
  });
  // Fixture calls speak fixture text only, so their turns keep it.
  const turns = new TurnTelemetryCollector({
    includeText: true,
    emit: (turn) => adapter.turnSummary(turn),
  });
  return {
    started: () => adapter.sessionStarted(),
    event(row: { seq: number; atMs: number; event: EngineEvent }) {
      const event: EngineEvent = row.event;
      turns.engine(event);
      if (event.type === 'user.transcript')
        adapter.transcript(
          {
            revision: row.seq,
            text: event.text,
            isFinal: event.stability === 'final',
            speechFinal: event.stability === 'final',
            speechStarted: true,
          },
          event.stability === 'final',
        );
      else if (event.type === 'agent.transcript') adapter.agentTranscript(event);
      else if (event.type === 'speech') adapter.speech(event.evidence);
      else if (event.type === 'timing') adapter.timing(event);
    },
    usage(meter: UsageMeter) {
      adapter.usageMeter(meter);
    },
    ended: (reason: EndReason) => {
      turns.flush();
      return adapter.sessionEnded(reason);
    },
  };
}
