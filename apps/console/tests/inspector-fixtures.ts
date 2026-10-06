import type { TurnRow } from '../components/inspector/turn-model';

/** One answered caller turn as the turns API serves it; tests override what they exercise. */
export function turn(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    turnId: 't1',
    input: 'speech',
    startedAt: '2026-10-06T10:00:00.000Z',
    endpointMs: 300,
    vadStopToFinalMs: null,
    sttFinalizeMs: 120,
    queueMs: null,
    groundingMs: null,
    decision: {
      ms: 240,
      outcome: 'succeeded',
      modelId: 'jev-1',
      answers: [
        {
          questionId: 'intent',
          type: 'choice',
          choice: 'promise_to_pay',
          value: null,
          confidence: 0.91,
        },
      ],
      flow: { node: 'disclose', listen: 'main' },
    },
    llmFirstTokenMs: null,
    llmTotalMs: null,
    llmCalls: 0,
    firstSegmentMs: 260,
    firstAudioMs: 700,
    bargeInMs: null,
    interrupted: false,
    segments: [
      {
        segmentId: 's1',
        ttsFirstByteMs: 180,
        carrierFirstAudioMs: 40,
        firstAudioAtMs: 700,
        state: 'completed',
      },
    ],
    userText: 'kal de dunga',
    agentText: 'Theek hai, kal tak.',
    textOmitted: false,
    ...overrides,
  };
}
