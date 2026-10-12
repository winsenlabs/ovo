import type { SpeechEvidence } from '@winsendotai/ovo-contracts';
import { boundedEvidenceText } from './telemetry-event-writer.ts';

/** The `speech.<phase>` call event for one line's evidence; text only where a line begins or ends. */
export function speechAuditPayload(
  evidence: SpeechEvidence,
  callId: string,
  maxTextCharacters: number,
): Record<string, unknown> {
  const terminal = ['completed', 'interrupted', 'dropped', 'failed'].includes(evidence.phase);
  const includeText = evidence.phase === 'generated' || terminal;
  const text = includeText ? boundedEvidenceText(evidence.text, maxTextCharacters) : undefined;
  return {
    speaker: 'agent',
    role: 'assistant',
    segmentId: evidence.segmentId,
    responseId: `${callId}:${evidence.epoch}`,
    turnId: String(evidence.epoch),
    responseEpoch: evidence.epoch,
    speechKind: evidence.kind,
    phase: evidence.phase,
    text: text?.value ?? null,
    speechText: text?.value ?? null,
    textLength: evidence.text.length,
    textTruncated: text?.truncated ?? false,
    evidence: evidence.evidence,
    humanHeard: evidence.phase === 'completed' && evidence.evidence === 'confirmed',
    reason: evidence.reason ? boundedEvidenceText(evidence.reason, 500).value : null,
    alignment: {
      clock: 'worker-wall-clock',
      occurredAt: new Date(evidence.at).toISOString(),
      exactAudioAlignment: false,
      carrierMarkEvidence: evidence.evidence,
    },
  };
}
