import { voice, type AgentSession } from '@livekit/agents';
import type { Evidence } from './evidence.ts';
import type { TurnDriver } from './turn-driver.ts';

export function attachEvents(
  session: AgentSession,
  driver: TurnDriver,
  evidence: Evidence,
  minWords: number,
  error: () => void,
): () => void {
  let transcript = 0;
  const transcribed = (event: voice.UserInputTranscribedEvent) => {
    const id = event.itemId ?? `stt-${++transcript}`;
    evidence.emit({
      type: 'user.transcript',
      turnId: id,
      segmentId: id,
      text: event.transcript,
      stability: event.isFinal ? 'final' : 'interim',
    });
    driver.onTranscript(event.transcript, minWords);
  };
  const metrics = (event: voice.MetricsCollectedEvent) => {
    const metric = event.metrics;
    if (metric.type === 'tts_metrics')
      evidence.emit({
        type: 'timing',
        key: 'tts_ttfb',
        atMs: evidence.clock.now(),
        ms: Math.max(0, metric.ttfbMs),
      });
  };
  const state = () =>
    evidence.emit({ type: 'timing', key: 'turn_decision', atMs: evidence.clock.now() });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, transcribed);
  session.on(voice.AgentSessionEventTypes.MetricsCollected, metrics);
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, state);
  session.on(voice.AgentSessionEventTypes.Error, error);
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, error);
  return () => {
    session.off(voice.AgentSessionEventTypes.UserInputTranscribed, transcribed);
    session.off(voice.AgentSessionEventTypes.MetricsCollected, metrics);
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, state);
    session.off(voice.AgentSessionEventTypes.Error, error);
    session.off(voice.AgentSessionEventTypes.FunctionToolsExecuted, error);
  };
}
