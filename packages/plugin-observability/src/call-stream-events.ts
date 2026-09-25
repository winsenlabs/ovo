/** Names durable call events for the public SSE stream. */
export function streamEventName(row: { type: string; payload: Record<string, unknown> }): string {
  const event = row.payload.event;
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    const raw = event as Record<string, unknown>;
    if (raw.type === 'user.transcript' && ['interim', 'final'].includes(String(raw.stability)))
      return `transcript.user.${raw.stability}`;
    if (
      raw.type === 'agent.transcript' &&
      ['generated', 'played', 'interrupted'].includes(String(raw.state))
    )
      return `transcript.agent.${raw.state}`;
    if (raw.type === 'user.turn' || raw.type === 'interrupt' || raw.type === 'voicemail')
      return 'turn';
    if (raw.type === 'timing' || raw.type === 'speech' || raw.type === 'end') return raw.type;
  }
  if (row.type === 'session.timing') return 'timing';
  if (row.type.startsWith('speech.')) return 'speech';
  if (
    row.type === 'session.engine-ended' ||
    row.type === 'session.ended' ||
    row.type === 'session.failed'
  )
    return 'end';
  if (row.type === 'transcript.accepted') return 'transcript.user.final';
  if (row.type === 'transcript.revision')
    return row.payload.isFinal ? 'transcript.user.final' : 'transcript.user.interim';
  if (
    row.type === 'transcript.agent' &&
    ['generated', 'played', 'interrupted'].includes(String(row.payload.state))
  )
    return `transcript.agent.${row.payload.state}`;
  return 'audit';
}
