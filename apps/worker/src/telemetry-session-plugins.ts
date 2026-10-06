import {
  Cap,
  type DecisionPort,
  type DecisionResponse,
  type DecisionTrace,
  type KnowledgePort,
} from '@winsendotai/ovo-contracts';
import { manifestKeys, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { decorateByKind } from '@winsendotai/ovo-session-host';
import {
  beginStage,
  instrumentPlugin,
  stageOutcome,
  type StageIdentity,
  type StageTelemetry,
} from './telemetry-stage-core.ts';
import {
  instrumentInferencePlugin,
  instrumentSttPlugin,
  instrumentTtsPlugin,
} from './telemetry-stages.ts';

/** Every session provider whose time a turn spends waiting on is timed under its own stage. */
export function instrumentSessionPlugin(
  definition: PluginDefinition,
  telemetry: StageTelemetry,
): PluginDefinition {
  const { kind, provider } = manifestKeys(definition.manifest).manifest;
  const identity = { provider };
  if (kind === 'decision')
    return instrumentPlugin(definition, Cap.decision, (service) => {
      if (service) instrumentDecision(service as DecisionPort, telemetry, identity);
    });
  if (kind === 'knowledge')
    return instrumentPlugin(definition, Cap.knowledge, (service) => {
      if (service) instrumentKnowledge(service as KnowledgePort, telemetry, identity);
    });
  return decorateByKind(definition, {
    stt: (item) => instrumentSttPlugin(item, telemetry, identity),
    tts: (item) => instrumentTtsPlugin(item, telemetry, identity),
    llm: (item) => instrumentInferencePlugin(item, telemetry, identity),
  });
}

/** Observes the decision round trip; the answer is returned untouched for the gate to validate. */
export function instrumentDecision(
  port: DecisionPort,
  telemetry: StageTelemetry,
  identity: StageIdentity,
): void {
  const decide = port.decide.bind(port);
  port.decide = async (request, options) => {
    const finish = beginStage(telemetry, { stage: 'decision', ...identity });
    const where = flowPayload(options.trace);
    try {
      const response = await decide(request, options);
      finish('succeeded', { ...decisionPayload(response), ...where });
      return response;
    } catch (error) {
      finish(stageOutcome(error), where);
      throw error;
    }
  };
}

export function instrumentKnowledge(
  port: KnowledgePort,
  telemetry: StageTelemetry,
  identity: StageIdentity,
): void {
  const search = port.search.bind(port);
  port.search = async (query, options) => {
    const finish = beginStage(telemetry, { stage: 'grounding', ...identity });
    try {
      const result = await search(query, options);
      finish('succeeded');
      return result;
    } catch (error) {
      finish(stageOutcome(error));
      throw error;
    }
  };
}

/** The flow state a decision was asked in (AGT-1): node and listen ids only. */
function flowPayload(trace: DecisionTrace | undefined): Record<string, unknown> {
  const flow = trace?.flow;
  return flow
    ? { flow: { node: flow.node?.slice(0, 80) ?? null, listen: flow.listen.slice(0, 80) } }
    : {};
}

/** Only identifiers, choices and confidences: never the state the question was asked about. */
function decisionPayload(response: DecisionResponse): Record<string, unknown> {
  if (!response || typeof response !== 'object') return {};
  const answers = response.answers && typeof response.answers === 'object' ? response.answers : {};
  return {
    modelId: typeof response.modelId === 'string' ? response.modelId.slice(0, 200) : null,
    answers: Object.entries(answers)
      .slice(0, 16)
      .map(([questionId, answer]) => ({
        questionId,
        type: answer?.type ?? null,
        choice: answer?.type === 'choice' ? answer.choice : null,
        value:
          answer?.type === 'noul' ? answer.noul : answer?.type === 'score' ? answer.score : null,
        confidence: typeof answer?.confidence === 'number' ? answer.confidence : null,
      })),
  };
}
