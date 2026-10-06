import { describe, expect, it } from 'vitest';
import { validateSelections, type CompatInput } from '../src/compat/index.ts';
import { MULAW, fixture, speech } from './compat-support.ts';

/** An STT that finalises only when the host commits, as ElevenLabs Scribe does by default. */
const manualCommit = () =>
  fixture({
    stt: {
      capabilities: { ...speech, turnSignals: [], forceEndpoint: true, inputFormats: [MULAW] },
    },
  });

const turnIssues = (input: CompatInput) =>
  validateSelections(input, 'live').filter((issue) => issue.code === 'turn_signal_missing');

describe('turn_signal_missing for a manual-commit STT (STT-5)', () => {
  it('asks for a VAD so the commit strategy can end turns', () => {
    expect(turnIssues(manualCommit())).toEqual([
      expect.objectContaining({
        slot: 'stt',
        message: expect.stringMatching(/finalises only on a host commit; select a VAD/),
      }),
    ]);
  });

  it('accepts the release once a VAD is selected', () => {
    const input = manualCommit();
    input.selections!.vad = { pluginId: 'vad', version: '1.0.0', config: {} };
    expect(turnIssues(input)).toEqual([]);
  });

  it('keeps the generic message for an STT that cannot be committed', () => {
    const input = fixture({
      stt: { capabilities: { ...speech, turnSignals: [], inputFormats: [MULAW] } },
    });
    expect(turnIssues(input)).toEqual([
      expect.objectContaining({
        message: 'Provider turn detection requires an end-of-turn signal or VAD',
      }),
    ]);
  });
});
