/** Whether caller and agent words are kept in call evidence and per-turn telemetry. */
export type TranscriptText = 'store' | 'omit';

export interface TranscriptTextPolicy {
  /** The installation default. */
  default: TranscriptText;
  /** Per-agent overrides, keyed by agent id. */
  agents?: Readonly<Record<string, TranscriptText>>;
}

const TEXT_KEYS = ['text', 'transcript', 'speechText', 'spokenPrefix'] as const;

/**
 * Reads `OVO_TELEMETRY_TRANSCRIPT_TEXT` (store|omit, default store) and
 * `OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS` (`agent-id=omit,other-id=store`). A malformed value
 * refuses to start rather than silently keeping words an operator asked to omit.
 */
export function transcriptTextPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TranscriptTextPolicy {
  const fallback = env.OVO_TELEMETRY_TRANSCRIPT_TEXT?.trim() || 'store';
  const agents: Record<string, TranscriptText> = {};
  for (const entry of (env.OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS ?? '').split(',')) {
    if (!entry.trim()) continue;
    const [agentId, value, extra] = entry.split('=').map((part) => part.trim());
    if (!agentId || extra !== undefined)
      throw new Error('OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS must be agent-id=store|omit pairs');
    agents[agentId] = transcriptText(value, 'OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS');
  }
  return { default: transcriptText(fallback, 'OVO_TELEMETRY_TRANSCRIPT_TEXT'), agents };
}

export function transcriptTextFor(
  policy: TranscriptTextPolicy,
  agentId: string,
  override?: TranscriptText,
): TranscriptText {
  return override ?? policy.agents?.[agentId] ?? policy.default;
}

/** Blanks caller and agent words in a call-event payload, including a copied engine event. */
export function withoutTranscriptText(payload: Record<string, unknown>): Record<string, unknown> {
  let omitted = false;
  const copy: Record<string, unknown> = { ...payload };
  for (const key of TEXT_KEYS)
    if (typeof copy[key] === 'string') {
      copy[key] = null;
      omitted = true;
    }
  const event = record(copy.event);
  if (event) {
    const scrubbed: Record<string, unknown> = { ...event };
    if (typeof scrubbed.text === 'string') scrubbed.text = '';
    if (typeof scrubbed.spokenPrefix === 'string') delete scrubbed.spokenPrefix;
    const evidence = record(scrubbed.evidence);
    if (evidence && typeof evidence.text === 'string')
      scrubbed.evidence = { ...evidence, text: '' };
    omitted ||= JSON.stringify(scrubbed) !== JSON.stringify(event);
    copy.event = scrubbed;
  }
  if (omitted) copy.textOmitted = true;
  return copy;
}

function transcriptText(value: string | undefined, name: string): TranscriptText {
  if (value === 'store' || value === 'omit') return value;
  throw new Error(`${name} must be store or omit`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
