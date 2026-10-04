import {
  validateDecisionExchange,
  DecisionRequest,
  type DecisionPort,
  type DecisionResponse,
  type NetFixtureScript,
  type NetFixtureStep,
  type NetPort,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { httpJson, syntheticRequestId, usageOnce } from '@winsendotai/ovo-plugin-kit';
import {
  decisionCriteriaWhere,
  decisionHttpStep,
  type DecisionTemplate,
} from '../kit/decision-support.ts';
import { FIXTURE_DOCS, FIXTURE_HOST, FIXTURE_RETRIEVED } from './fixture-stt.ts';

export const DECISION_URL = `https://${FIXTURE_HOST}/v1/decide`;

/**
 * The fixture decision model: one JSON POST per `decide()` to https://fixture.invalid/v1/decide,
 * mirroring `FixtureInference`. It validates the exchange it is handed rather than repairing it,
 * which is what the `decision@1` kit's refusal checks require of every provider.
 */
export class FixtureDecision implements DecisionPort {
  readonly provider = 'fixture';
  private calls = 0;

  constructor(
    private readonly net: NetPort,
    private readonly options: {
      usage?: UsageSink;
      model?: string;
      sessionId?: string;
    } = {},
  ) {}

  async decide(
    raw: DecisionRequest,
    { signal }: { signal: AbortSignal },
  ): Promise<DecisionResponse> {
    signal.throwIfAborted();
    const request = DecisionRequest.parse(raw);
    const meter = usageOnce(this.options.usage ?? (() => undefined));
    const result = await httpJson(
      this.net,
      DECISION_URL,
      {
        method: 'POST',
        json: {
          model: this.options.model ?? 'fixture-decision-1',
          state: request.state,
          questions: request.questions,
        },
      },
      { timeoutMs: 10_000, signal },
    );
    if (result.kind !== 'ok') throw new Error(`fixture decision ${result.kind}: ${result.reason}`);
    const { id, usage, ...body } = result.body;
    const requestId = String(
      id ?? syntheticRequestId('fixture', this.options.sessionId ?? 'kit-session', ++this.calls),
    );
    const tokens = (usage ?? {}) as Record<string, number>;
    if (typeof tokens.input_tokens === 'number')
      meter.emit({
        provider: 'fixture',
        operation: 'decision',
        unit: 'input_tokens',
        quantity: String(tokens.input_tokens),
        state: 'reconciled',
        requestId,
        elapsedMs: 0,
      });
    return validateDecisionExchange(request, body).response;
  }
}

/**
 * Renders the kit's plan as the fixture provider's wire script: one POST per planned exchange,
 * matched on the bound model and on every criterion key and description, verbatim.
 */
export const fixtureDecisionTemplate: DecisionTemplate = (plan): NetFixtureScript[] => {
  const steps: NetFixtureStep[] = [];
  plan.exchanges.forEach((exchange, index) => {
    if (exchange.delayMs) steps.push({ delayMs: exchange.delayMs });
    steps.push(
      decisionHttpStep(
        DECISION_URL,
        { model: plan.model, ...decisionCriteriaWhere(exchange.request) },
        JSON.stringify({
          id: `fixture-decision-${index + 1}`,
          usage: { input_tokens: 12 },
          ...exchange.response,
        }),
      ),
    );
  });
  return [
    {
      host: FIXTURE_HOST,
      source: `${FIXTURE_DOCS}/decision`,
      retrieved: FIXTURE_RETRIEVED,
      steps,
    },
  ];
};
