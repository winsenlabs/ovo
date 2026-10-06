import type { DecisionPort, DecisionResponse } from '@winsendotai/ovo-contracts';
import {
  FLOW_INTENT_QUESTION,
  FLOW_OTHER_INTENT,
  flowIntents,
  flowListen,
  matchFlowPhrase,
} from './jev-eval-flow.ts';
import { jevEvalRequest, type JevEvalSet } from './jev-eval.ts';
import { valueFingerprint } from './validation.ts';

/**
 * Decision answers captured once and replayed offline, so the eval runs in CI with no network and
 * no key. Answers are keyed by the fingerprint of the exact request, so changing the flow (a
 * description, a question, a line the caller is answering) leaves those cases unanswered and the
 * gate fails until they are recorded again: a policy change cannot pass on stale answers.
 */
export interface JevEvalRecording {
  /** `live` answers came from the model; `synthetic` answers echo the labels and measure nothing. */
  provenance: 'live' | 'synthetic';
  note: string;
  recordedAt: string;
  modelId?: string;
  answers: Record<string, DecisionResponse>;
}

export class JevEvalRecordingMissing extends Error {
  constructor(fingerprint: string) {
    super(`No recorded decision for request ${fingerprint.slice(0, 19)}; re-record the eval`);
    this.name = 'JevEvalRecordingMissing';
  }
}

export function replayDecision(recording: JevEvalRecording): DecisionPort {
  return {
    async decide(request) {
      const fingerprint = valueFingerprint(request);
      const answer = recording.answers[fingerprint];
      if (!answer) throw new JevEvalRecordingMissing(fingerprint);
      return structuredClone(answer);
    },
  };
}

/** The cases the instant tier does not resolve: only these ever reach the decision model. */
const decided = (set: JevEvalSet) =>
  set.cases.filter((evalCase) => !matchFlowPhrase(set.flow, evalCase.listen, evalCase.text));

/** Asks the live model every decided case once. The caller supplies the port and its key. */
export async function recordJevEval(
  set: JevEvalSet,
  live: DecisionPort,
  meta: { note: string; recordedAt: string; signal?: AbortSignal },
): Promise<JevEvalRecording> {
  const answers: Record<string, DecisionResponse> = {};
  const signal = meta.signal ?? new AbortController().signal;
  let modelId: string | undefined;
  for (const evalCase of decided(set)) {
    const request = jevEvalRequest(set, evalCase);
    const fingerprint = valueFingerprint(request);
    if (answers[fingerprint]) continue;
    answers[fingerprint] = await live.decide(request, { signal });
    modelId ??= answers[fingerprint].modelId;
  }
  return {
    provenance: 'live',
    note: meta.note,
    recordedAt: meta.recordedAt,
    ...(modelId ? { modelId } : {}),
    answers,
  };
}

const SYNTHETIC_ID = 'synthetic-label-echo';

/**
 * A stand-in until a live recording exists: every decided case is answered with its own label at
 * 0.9. It measures nothing about the model; what it keeps honest is the rest of the gate (rule-tier
 * misroutes, threshold and slot routing, and staleness when the flow or corpus changes).
 */
export function synthesizeJevEvalRecording(set: JevEvalSet, recordedAt: string): JevEvalRecording {
  const answers: Record<string, DecisionResponse> = {};
  const choice = (keys: string[], chosen: string) => {
    const rest = (1 - 0.9) / (keys.length - 1);
    const probabilities = Object.fromEntries(keys.map((key) => [key, key === chosen ? 0.9 : rest]));
    return {
      type: 'choice' as const,
      choice: chosen,
      confidence: 0.9,
      calibrationVersion: SYNTHETIC_ID,
      probabilities,
    };
  };
  for (const evalCase of decided(set)) {
    const request = jevEvalRequest(set, evalCase);
    const intents = [
      ...flowIntents(set.flow, evalCase.listen).map((intent) => intent.key),
      FLOW_OTHER_INTENT,
    ];
    const response: DecisionResponse = {
      modelId: SYNTHETIC_ID,
      answers: { [FLOW_INTENT_QUESTION]: choice(intents, evalCase.expected) },
    };
    for (const slot of flowListen(set.flow, evalCase.listen)!.slots) {
      const keys = slot.options.map((option) => option.key);
      const labelled = evalCase.slots?.[slot.id];
      response.answers[slot.id] = choice(keys, labelled ?? keys.at(-1)!);
    }
    answers[valueFingerprint(request)] = response;
  }
  return {
    provenance: 'synthetic',
    note: 'Synthetic: every decided case is answered with its own label. Not a Jev measurement; record live answers with `pnpm eval:jev --record`.',
    recordedAt,
    modelId: SYNTHETIC_ID,
    answers,
  };
}
