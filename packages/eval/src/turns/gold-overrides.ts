import type { CallName } from './corpus.ts';
import type { GoldOverrides } from './gold.ts';

/**
 * Per-call corrections to the rule-derived gold thoughts (gold.ts), each with its reason. Read
 * from the calls' event logs and evidence docs (~/work/ovo-waves/callN-evidence.md); none were
 * checked by ear, so docs/eval/turn-bakeoff.md lists them for the founder to confirm.
 */
export const GOLD_OVERRIDES: Partial<Record<CallName, GoldOverrides>> = {
  call4: {
    voiced: [
      {
        at: 44_178,
        note: '"Of January." had no VAD run (said softly) but is the caller finishing "…to the 5th."',
      },
    ],
  },
  call7: {
    noReply: [
      {
        at: 1_000,
        note: 'Hindi over the greeting ("haan theek hai, aap isko laga do"): someone in the room, not said to Maya',
      },
      {
        at: 209_500,
        note: 'garbled words (transcribed as Tamil) over the agent; dropped live; the caller spoke 3 s later',
      },
    ],
  },
  call8: {
    voiced: [
      {
        at: 101_832,
        note: '"Yes." confirming the dates had no VAD run (soft) but is the caller: the agent answered it',
      },
    ],
  },
};
