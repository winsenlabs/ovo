import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgentConfig,
  Cap,
  type CarrierIngress,
  type CarrierMediaEvent,
  type DecisionRequest,
  type EngineEvent,
  type NetFixtureScript,
  type ReleaseSelection,
} from '@winsendotai/ovo-contracts';
import {
  FakeClock,
  FIXTURE_PLUGIN_IDS,
  fixtureDecisionPlugin,
  fixtureDecisionTemplate,
  fixtureLlmPlugin,
  fixtureTemplates as inferenceTemplates,
} from '../../conformance/src/drivers.ts';
import { decisionQuestionPayload, type AgentDecisionQuestion } from '@winsendotai/ovo-contracts';
import { runFixtureCall } from '@winsendotai/ovo-fixture-calls';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../src/load.ts';
import { callerHangupTemplate } from './fixture-support.ts';

const TWILIO = '@winsendotai/ovo-carrier-twilio';
const NATIVE = '@winsendotai/ovo-plugin-voice-session-engine';
// Real providers for speech, exactly as the matrix runs them, so only the LLM and the decision are
// fixtures: the point is a decision inside a production-shaped graph, not a graph made of fixtures.
const DEEPGRAM = '@winsendotai/ovo-provider-deepgram-stt';
const OPENAI_TTS = '@winsendotai/ovo-provider-openai-tts';
const DECIDED_LINE = 'I am sending you a payment link now.';

const question: AgentDecisionQuestion = {
  type: 'choice',
  id: 'intent',
  purpose: 'Route the opening turn without an LLM round trip.',
  instructions: 'What is the caller asking for?',
  threshold: 0.8,
  fallback: 'llm',
  expected: 'pay',
  options: [
    { key: 'pay', description: 'Wants to pay the outstanding now', outcome: { say: DECIDED_LINE } },
    { key: 'other', description: 'Anything else', outcome: {} },
  ],
};

const policy = {
  enabled: true,
  questions: [question],
  state: { sources: ['last-turn' as const], transcriptTurns: 6 },
  timeoutMs: 1_500,
};

/**
 * The scripted wire exchange, built from the SAME compiler the runtime uses. If the compiled request
 * ever stops matching what the policy means, the fixture stops matching and this test fails rather
 * than quietly exercising a shape nothing produces.
 */
function decisionScript(confidence: number): NetFixtureScript[] {
  const request: DecisionRequest = {
    state: { lastCallerTurn: 'hello fixture' },
    questions: { intent: decisionQuestionPayload(question) },
  };
  return fixtureDecisionTemplate({
    model: 'fixture-decision-1',
    exchanges: [
      {
        request,
        response: {
          modelId: 'fixture-decision-1',
          answers: {
            intent: {
              type: 'choice',
              choice: 'pay',
              confidence,
              calibrationVersion: 'fixture-decision-1/cohort-a',
              probabilities: { pay: 0.9, other: 0.1 },
            },
          },
        },
      },
    ],
  });
}

/** The fixture providers' shared host, so an empty script can still claim it. */
const FIXTURE_HOST_SCRIPT = {
  host: 'fixture.invalid',
  source: 'https://fixture.invalid/docs/llm',
  retrieved: '2026-10-01',
} as const;

function selection(
  registry: PluginRegistry,
  pluginId: string,
  provider?: string,
  config: Record<string, unknown> = {},
): ReleaseSelection {
  const definition = registry.get(pluginId);
  if (!definition) throw new Error(`Plugin is not installed: ${pluginId}`);
  return {
    pluginId,
    version: definition.manifest.version,
    ...(provider
      ? {
          bindingId: `fixture-${provider}`,
          binding: {
            provider,
            config,
            credentialId: 'decision-fixture-credential',
            fingerprint: 'decision-fixture',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        }
      : {}),
    config: {},
  };
}

describe('a decision plugin driven through the real session graph', () => {
  let loaded: Awaited<ReturnType<typeof loadDistribution>>;
  beforeAll(async () => {
    loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
  });

  /**
   * `llm: 'forbidden'` registers an EMPTY script for the fixture LLM's host instead of its template,
   * so any inference request mismatches and fails the call. That is a stronger statement than
   * counting spoken lines: the LLM is not merely unused, it is unreachable.
   */
  async function run(confidence: number, llm: 'scripted' | 'forbidden') {
    const registry = new PluginRegistry([
      ...loaded.catalog,
      fixtureLlmPlugin,
      fixtureDecisionPlugin,
    ]);
    const carrier = await compose([{ id: TWILIO }], loaded.catalog, {
      scope: 'process',
      net: createFixtureNet([]),
      enforcement: 'enforce',
    });
    try {
      const ingress = carrier.all(Cap.carrierIngress).get('twilio') as CarrierIngress & {
        createFixtureFrameEncoder(): (event: CarrierMediaEvent) => string;
      };
      const events: EngineEvent[] = [];
      const clock = new FakeClock();
      const call = runFixtureCall({
        registry,
        clock,
        fixtures: {
          ...loaded.fixtures,
          [FIXTURE_PLUGIN_IDS.decision]: decisionScript(confidence),
          ...(llm === 'forbidden'
            ? { [FIXTURE_PLUGIN_IDS.llm]: [{ ...FIXTURE_HOST_SCRIPT, steps: [] }] }
            : {}),
        },
        fixtureTemplates: {
          ...loaded.fixtureTemplates,
          ...(llm === 'scripted' ? inferenceTemplates : {}),
          [DEEPGRAM]: callerHangupTemplate(loaded.fixtureTemplates[DEEPGRAM]!, 'CloseStream'),
        },
        fixtureSecrets: { 'decision-fixture-credential': 'fixture-key' },
        carrier: {
          pluginId: TWILIO,
          ingress,
          inboundFrame: ingress.createFixtureFrameEncoder(),
        },
        release: {
          id: 'decision-release',
          workspaceId: 'decision-workspace',
          plugins: [],
          config: AgentConfig.parse({
            name: 'Collections',
            mode: 'agent',
            language: 'en-IN',
            recording: false,
            clarification: 'Could you say that again?',
            decision: policy,
          }),
          selections: {
            engine: selection(registry, NATIVE),
            carrier: { ...selection(registry, TWILIO), bindingId: 'env' },
            stt: selection(registry, DEEPGRAM, 'deepgram', { model: 'nova-3' }),
            tts: selection(registry, OPENAI_TTS, 'openai', {
              model: 'gpt-4o-mini-tts',
              voice: 'alloy',
            }),
            llm: { ...selection(registry, FIXTURE_PLUGIN_IDS.llm), bindingId: 'env' },
            decision: { ...selection(registry, FIXTURE_PLUGIN_IDS.decision), bindingId: 'env' },
          },
        },
        callerScript: { turns: [{ atMs: 0, say: 'hello fixture' }] },
        agentTexts: [DECIDED_LINE],
        telemetry: {
          onEvent: (row) => {
            events.push(row.event);
          },
        },
      });
      await clock.advanceAsync(30_000);
      const result = await call.done;
      return { result, events };
    } finally {
      await carrier.dispose();
    }
  }

  it('selects the decision slot and speaks the authored outcome with no LLM turn', async () => {
    const { result, events } = await run(0.93, 'forbidden');
    expect(result.status, JSON.stringify(result.outcome)).toBe('completed');
    // The slot reached the graph: this is what `selectSessionGraph` actually resolved.
    expect(result.selections.decision?.id).toBe(FIXTURE_PLUGIN_IDS.decision);
    const spoken = events.filter((event) => event.type === 'agent.transcript').map((e) => e.text);
    expect(spoken).toContain(DECIDED_LINE);
    // The decision answered the turn. Reaching the LLM at all would have failed the fixture above.
    expect(spoken.join(' ')).not.toContain('Please confirm:');
    // The decision was metered, so its cost is accounted like any other provider's.
    expect(
      result.usage.some((meter) => meter.provider === 'fixture' && meter.unit === 'input_tokens'),
    ).toBe(true);
  }, 60_000);

  it('reaches the LLM when the same model answers below the authored threshold', async () => {
    const { result, events } = await run(0.4, 'scripted');
    expect(result.status, JSON.stringify(result.outcome)).toBe('completed');
    expect(result.selections.decision?.id).toBe(FIXTURE_PLUGIN_IDS.decision);
    const spoken = events.filter((event) => event.type === 'agent.transcript').map((e) => e.text);
    // Same wire reply, one number changed: the authored line is NOT spoken and the LLM answered.
    expect(spoken).not.toContain(DECIDED_LINE);
    expect(spoken.length).toBeGreaterThan(0);
  }, 60_000);
});
