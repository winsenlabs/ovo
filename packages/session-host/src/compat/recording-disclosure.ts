import { disclosureLines, type AgentConfig } from '@winsendotai/ovo-contracts';
import type { CompatRule } from './types.ts';
import { issue } from './types.ts';

/** A line that tells the caller about recording: English, Hinglish or Hindi. */
const MENTIONS_RECORDING = /\brecord(?:ed|ing)?\b|रिकॉर्ड/iu;

/**
 * The recording flag and what callers are told should agree. A recording agent should say so before
 * anything else (DPDP notice: best practice now, binding from 13 May 2027); an agent that tells
 * callers "this call is recorded" should record, as the live CreditMantri agent of 2026-10-07 did
 * not. A warning, never a blocker: the wording and the duty are the operator's decision.
 */
export const recordingDisclosure: CompatRule = (input, stage) => {
  const { config } = input;
  const told = spokenLines(config).some((line) => MENTIONS_RECORDING.test(line));
  if (config.recording && !told)
    return [
      issue(
        'recording_disclosure_mismatch',
        stage,
        'This agent records its calls but no line tells the caller: set compliance.disclosure.text ' +
          'or say it in the flow',
        { field: 'compliance.disclosure' },
        'warning',
      ),
    ];
  if (!config.recording && told)
    return [
      issue(
        'recording_disclosure_mismatch',
        stage,
        'A line tells callers the call is recorded, but recording is off for this agent',
        { field: 'recording' },
        'warning',
      ),
    ];
  return [];
};

function spokenLines(config: AgentConfig): string[] {
  return [
    ...disclosureLines(config.compliance),
    ...Object.values(config.decision?.flow?.lines ?? {}),
    ...(config.opening?.lines ?? []),
  ];
}
