import { describe, expect, it } from 'vitest';
import { AgentConfig, Cap } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { validateSelections, type CompatInput } from '../src/compat/index.ts';
import { normalizeAgentConfig } from '../src/normalize.ts';
import { catalog, fixture, MULAW, speech, withConfig } from './compat-support.ts';

/** Every outcome speaks and an unavailable decision has its line: nothing reaches an LLM. */
const jevOnly = {
  mode: 'agent',
  decision: {
    enabled: true,
    questions: [
      {
        type: 'choice',
        id: 'intent',
        instructions: 'What does the caller want?',
        threshold: 0.7,
        fallback: 'clarify',
        options: [
          { key: 'pay', description: 'Will pay', outcome: { say: 'Thank you.' } },
          { key: 'bye', description: 'Goodbye', outcome: { say: 'Goodbye.', end: true } },
        ],
      },
    ],
    state: { sources: ['last-turn'] },
  },
  decisionUnavailable: { line: 'Sorry, one moment.' },
};
const withoutLlm = (input: CompatInput) => {
  input.selections = { ...input.selections, llm: undefined };
  return input;
};
/** The mode rules only: `meter_uncovered` has its own llm requirement (see the integration patch). */
const llmIssues = (input: CompatInput) =>
  validateSelections(input, 'live').filter((issue) => issue.code.startsWith('mode_'));

describe('LLM compat as a reachability check (AGT-4)', () => {
  it('publishes a Jev-only agent with no LLM selected', () => {
    expect(llmIssues(withoutLlm(withConfig(fixture(), jevOnly)))).toEqual([]);
  });

  it('still requires the LLM for an agent some path can route to it', () => {
    const input = withoutLlm(withConfig(fixture(), { ...jevOnly, decisionUnavailable: undefined }));
    expect(llmIssues(input)).toEqual([
      expect.objectContaining({
        code: 'mode_requires_llm',
        severity: 'error',
        field: 'decisionUnavailable',
        message: expect.stringMatching(/can reach the LLM \(decisionUnavailable\)/),
      }),
    ]);
    expect(llmIssues(withoutLlm(withConfig(fixture(), { mode: 'agent' })))).toEqual([
      expect.objectContaining({ code: 'mode_requires_llm', field: 'decision' }),
    ]);
    expect(llmIssues(withoutLlm(fixture()))).toEqual([
      expect.objectContaining({
        code: 'mode_requires_llm',
        message: 'context mode requires an LLM',
      }),
    ]);
  });

  it('warns when an LLM is selected for an agent that can never reach it', () => {
    expect(llmIssues(withConfig(fixture(), jevOnly))).toEqual([
      expect.objectContaining({
        code: 'mode_llm_unused',
        severity: 'warning',
        message: expect.stringMatching(/Jev-only/),
      }),
    ]);
    expect(llmIssues(withConfig(fixture(), { mode: 'agent' }))).toEqual([]);
  });
});

describe('energy VAD preselection for a manual-commit STT (Wave 2 request 1)', () => {
  const vad = definePlugin(
    {
      id: 'vad-energy',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'vad',
      provider: 'ovo',
      provides: [Cap.vad],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
      conformance: ['vad@1'],
    } as never,
    () => undefined,
  );
  const registry = (stt: Record<string, unknown>, withVad = true) =>
    new PluginRegistry([
      ...catalog({ stt: { capabilities: { ...speech, inputFormats: [MULAW], ...stt } } }),
      ...(withVad ? [vad] : []),
    ]);
  const config = (voice: Record<string, unknown> = {}) =>
    AgentConfig.parse({
      name: 'A',
      mode: 'agent',
      voice: { stt: { plugin: 'stt', binding: 'b', config: {} }, ...voice },
    });
  const defaults = { engine: 'engine', vad: 'vad-energy' };

  it('selects the VAD when the STT finalises only on a host commit', () => {
    const normalized = normalizeAgentConfig(
      config(),
      registry({ turnSignals: [], forceEndpoint: true }),
      {},
      defaults,
    );
    expect(normalized.config.voice?.vad).toEqual({ plugin: 'vad-energy', config: {} });
    expect(normalized.warnings).toEqual([]);
  });

  it('leaves an STT with its own end-of-turn signal, and an explicit choice, alone', () => {
    const own = normalizeAgentConfig(config(), registry({ forceEndpoint: true }), {}, defaults);
    expect(own.config.voice?.vad).toBeUndefined();
    const chosen = normalizeAgentConfig(
      config({ vad: { plugin: 'other-vad', config: { threshold: 0.4 } } }),
      registry({ turnSignals: [], forceEndpoint: true }),
      {},
      defaults,
    );
    expect(chosen.config.voice?.vad).toEqual({ plugin: 'other-vad', config: { threshold: 0.4 } });
    const legacy = normalizeAgentConfig(
      config(),
      registry({ turnSignals: [], forceEndpoint: true }),
      {},
      { engine: 'engine' },
    );
    expect(legacy.config.voice?.vad).toBeUndefined();
  });

  it('warns rather than fails when the default VAD is not installed', () => {
    const normalized = normalizeAgentConfig(
      config(),
      registry({ turnSignals: [], forceEndpoint: true }, false),
      {},
      defaults,
    );
    expect(normalized.config.voice?.vad).toBeUndefined();
    expect(normalized.warnings).toEqual(['Optional VAD is not installed: vad-energy']);
  });
});
