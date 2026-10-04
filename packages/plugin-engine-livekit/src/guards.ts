import type { AgentSession, Agent } from '@livekit/agents';

export function assertEnvironment(env: Record<string, string | undefined> = process.env): void {
  if (Object.keys(env).some((key) => key.startsWith('LIVEKIT_') && env[key] !== undefined))
    throw new Error('OVO LiveKit engine refuses LIVEKIT_* credentials or configuration');
}
export function assertOptions(options: {
  vad?: unknown;
  stt?: unknown;
  tts?: unknown;
  llm?: unknown;
  turnHandling?: { turnDetection?: unknown };
}): void {
  if (options.vad === undefined || options.turnHandling?.turnDetection !== 'stt')
    throw new Error('OVO LiveKit requires explicit vad:null and turnDetection:stt');
  if (
    options.llm != null ||
    [options.stt, options.tts, options.vad].some((value) => typeof value === 'string')
  )
    throw new Error('OVO LiveKit refuses inference model IDs or an LLM');
}
export function assertSession(
  session: AgentSession,
  agent: Agent,
  inference: Pick<
    (typeof import('@livekit/agents'))['inference'],
    'STT' | 'TTS' | 'LLM' | 'VAD' | 'TurnDetector'
  >,
): void {
  const inspected = session as unknown as Record<string, unknown>;
  if (inspected._usingDefaultVad) throw new Error('OVO LiveKit refuses the default inference VAD');
  for (const key of ['stt', 'tts', 'vad', 'llm', 'turnDetection']) {
    const value = inspected[key];
    if (
      value &&
      typeof value === 'object' &&
      [inference.STT, inference.TTS, inference.LLM, inference.VAD, inference.TurnDetector].some(
        (Constructor) => value instanceof Constructor,
      )
    )
      throw new Error(`OVO LiveKit refuses inference ${key}`);
  }
  // LiveKit always creates an empty ToolContext; any populated context is forbidden.
  if (session.llm || session.tools.length || agent.toolCtx.tools.length)
    throw new Error('OVO LiveKit refuses an LLM or tool context');
}
