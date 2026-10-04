import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgentConfig,
  Cap,
  type CarrierIngress,
  type CarrierMediaEvent,
  type EngineEvent,
  type ReleaseSelection,
} from '@winsendotai/ovo-contracts';
import {
  FakeClock,
  FIXTURE_PLUGIN_IDS,
  fixtureLlmPlugin,
  fixtureTemplates as inferenceTemplates,
} from '../../conformance/src/drivers.ts';
import { runFixtureCall } from '@winsendotai/ovo-fixture-calls';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../src/load.ts';
import { callerHangupTemplate } from './fixture-support.ts';

const TWILIO = '@winsendotai/ovo-carrier-twilio';
const NATIVE = '@winsendotai/ovo-plugin-voice-session-engine';
const DEEPGRAM = '@winsendotai/ovo-provider-deepgram-stt';
const OPENAI_TTS = '@winsendotai/ovo-provider-openai-tts';
const INLINE_KNOWLEDGE = '@winsendotai/ovo-knowledge-inline';

/** The caller says this; the corpus below is written so these words retrieve the right clause. */
const ASKED = 'hello fixture';

const CORPUS = {
  sources: [
    {
      id: 'policy',
      documents: [
        {
          id: 'greeting',
          title: 'Greeting policy',
          citation: 'Greeting policy, clause 1',
          text: 'A hello fixture greeting is acknowledged before any account detail is discussed.',
        },
        {
          id: 'arrears',
          text: 'An account in arrears accrues interest from the due date until settled.',
        },
      ],
    },
  ],
};

function selection(
  registry: PluginRegistry,
  pluginId: string,
  provider?: string,
  config: Record<string, unknown> = {},
  rowConfig: Record<string, unknown> = {},
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
            credentialId: 'knowledge-fixture-credential',
            fingerprint: 'knowledge-fixture',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        }
      : {}),
    config: rowConfig,
  };
}

describe('a knowledge plugin driven through the real session graph', () => {
  let loaded: Awaited<ReturnType<typeof loadDistribution>>;
  beforeAll(async () => {
    loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
  });

  /**
   * `llm: 'forbidden'` publishes an EMPTY script for the fixture LLM's host instead of its template,
   * so any inference request mismatches and fails the call. The LLM is then not merely unused, it is
   * unreachable — which is the claim `requireGrounding` makes.
   */
  async function run(
    knowledge: Record<string, unknown>,
    llm: 'scripted' | 'forbidden' = 'scripted',
  ) {
    const registry = new PluginRegistry([...loaded.catalog, fixtureLlmPlugin]);
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
          ...(llm === 'forbidden'
            ? {
                [FIXTURE_PLUGIN_IDS.llm]: [
                  {
                    host: 'fixture.invalid',
                    source: 'https://fixture.invalid/docs/llm',
                    retrieved: '2026-10-01',
                    steps: [],
                  },
                ],
              }
            : {}),
        },
        fixtureTemplates: {
          ...loaded.fixtureTemplates,
          ...(llm === 'scripted' ? inferenceTemplates : {}),
          [DEEPGRAM]: callerHangupTemplate(loaded.fixtureTemplates[DEEPGRAM]!, 'CloseStream'),
        },
        fixtureSecrets: { 'knowledge-fixture-credential': 'fixture-key' },
        carrier: {
          pluginId: TWILIO,
          ingress,
          inboundFrame: ingress.createFixtureFrameEncoder(),
        },
        release: {
          id: 'knowledge-release',
          workspaceId: 'knowledge-workspace',
          plugins: [],
          config: AgentConfig.parse({
            name: 'Grounded',
            mode: 'agent',
            language: 'en-IN',
            recording: false,
            context: 'The agent answers from policy only.',
            uncertainty: 'I do not have that information.',
            knowledge: { enabled: true, minScore: 0.2, topK: 2, ...knowledge },
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
            knowledge: selection(registry, INLINE_KNOWLEDGE, undefined, {}, CORPUS),
          },
        },
        callerScript: { turns: [{ atMs: 0, say: ASKED }] },
        telemetry: {
          onEvent: (row) => {
            events.push(row.event);
          },
        },
      });
      await clock.advanceAsync(30_000);
      return { result: await call.done, events };
    } finally {
      await carrier.dispose();
    }
  }

  it('selects the knowledge slot and completes a grounded call with no network', async () => {
    const { result } = await run({});
    expect(result.status, JSON.stringify(result.outcome)).toBe('completed');
    // The slot reached the graph: this is what `selectSessionGraph` actually resolved.
    expect(result.selections.knowledge?.id).toBe(INLINE_KNOWLEDGE);
    // Retrieval is in-process, so the plugin contributes no wire traffic at all.
    expect(result.usage.every((meter) => meter.provider !== 'inline')).toBe(true);
  }, 60_000);

  it('refuses rather than answering ungrounded when the threshold admits nothing', async () => {
    const { result, events } = await run({ requireGrounding: true, minScore: 0.99 }, 'forbidden');
    expect(result.status, JSON.stringify(result.outcome)).toBe('completed');
    const spoken = events
      .filter((event) => event.type === 'agent.transcript')
      .map((event) => event.text)
      .join(' ');
    // Reaching the LLM at all would have failed the fixture above; this is what it said instead.
    expect(spoken).toContain('I do not have that information.');
  }, 60_000);
});
