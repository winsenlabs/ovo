import { describe, expect, it } from 'vitest';
import { Cap, type ReleaseSelections } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { validateSelections } from '../src/compat/index.ts';
import { codes, fixture, withConfig } from './compat-support.ts';

const policy = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  minScore: 0.4,
  topK: 4,
  maxCharacters: 4_000,
  ...over,
});

const capabilities = {
  scoreBasis: 'lexical',
  maxTopK: 10,
  maxPassageCharacters: 2_000,
  languages: ['en-IN'],
  citations: true,
  mutableCorpus: false,
};

function withKnowledge(over: Record<string, unknown> = {}) {
  const input = fixture();
  const plugin = definePlugin(
    {
      id: 'librarian',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'knowledge',
      provider: 'librarian',
      provides: [Cap.knowledge],
      capabilities: { ...capabilities, ...over },
      conformance: ['knowledge@1'],
      runtime: { egressHosts: [], modelLicences: [] },
    } as never,
    () => undefined,
  );
  input.registry = new PluginRegistry([...input.registry.list(), plugin]);
  input.selections = {
    ...input.selections,
    knowledge: { pluginId: 'librarian', version: '1.0.0', config: {} },
  } as ReleaseSelections;
  input.fixturePluginIds = [...(input.fixturePluginIds ?? []), 'librarian'];
  return input;
}

describe('a knowledge policy without a plugin', () => {
  it('blocks the release', () => {
    const input = withConfig(fixture(), { mode: 'agent', knowledge: policy() });
    const reported = validateSelections(input, 'release').find(
      (entry) => entry.code === 'knowledge_plugin_missing',
    )!;
    expect(reported.severity).toBe('error');
    expect(reported.slot).toBe('knowledge');
  });

  it('says nothing for a disabled policy, or for an agent with none', () => {
    expect(
      codes(
        withConfig(fixture(), { mode: 'agent', knowledge: policy({ enabled: false }) }),
        'release',
      ),
    ).not.toContain('knowledge_plugin_missing');
    expect(codes(withConfig(fixture(), { mode: 'agent' }), 'release')).not.toContain(
      'knowledge_plugin_missing',
    );
  });
});

describe('a knowledge plugin nobody queries', () => {
  it('warns rather than blocking', () => {
    const reported = validateSelections(
      withConfig(withKnowledge(), { mode: 'agent' }),
      'release',
    ).find((entry) => entry.code === 'knowledge_plugin_unused')!;
    expect(reported.severity).toBe('warning');
    expect(reported.message).toContain('librarian');
  });

  it('is silent once grounding is enabled', () => {
    const input = withConfig(withKnowledge(), { mode: 'agent', knowledge: policy() });
    expect(codes(input, 'release')).not.toContain('knowledge_plugin_unused');
    expect(codes(input, 'release')).not.toContain('knowledge_plugin_missing');
  });
});

describe('a policy the backend cannot honour', () => {
  it('rejects a depth above what the plugin returns', () => {
    const input = withConfig(withKnowledge({ maxTopK: 3 }), {
      mode: 'agent',
      knowledge: policy({ topK: 8 }),
    });
    const reported = validateSelections(input, 'live').find(
      (entry) => entry.code === 'knowledge_limit_exceeded' && entry.field === 'topK',
    )!;
    expect(reported.message).toContain('asks for 8');
  });

  it('rejects a language the plugin does not support, which would silently return nothing', () => {
    const input = withConfig(withKnowledge({ languages: ['en-US'] }), {
      mode: 'agent',
      language: 'ta-IN',
      knowledge: policy(),
    });
    const reported = validateSelections(input, 'live').find(
      (entry) => entry.code === 'knowledge_limit_exceeded' && entry.field === 'language',
    )!;
    expect(reported.message).toContain('ta-IN');
  });

  it('accepts a wildcard language', () => {
    const input = withConfig(withKnowledge({ languages: ['*'] }), {
      mode: 'agent',
      language: 'ta-IN',
      knowledge: policy(),
    });
    expect(
      validateSelections(input, 'live').some(
        (entry) => entry.code === 'knowledge_limit_exceeded' && entry.field === 'language',
      ),
    ).toBe(false);
  });

  it('warns when the budget is smaller than one passage, so a full passage always drops', () => {
    const input = withConfig(withKnowledge({ maxPassageCharacters: 2_000 }), {
      mode: 'agent',
      knowledge: policy({ maxCharacters: 500 }),
    });
    const reported = validateSelections(input, 'live').find(
      (entry) => entry.code === 'knowledge_limit_exceeded' && entry.field === 'maxCharacters',
    )!;
    expect(reported.severity).toBe('warning');
  });

  it('accepts a policy inside every declared limit', () => {
    const input = withConfig(withKnowledge(), { mode: 'agent', knowledge: policy() });
    expect(codes(input, 'live')).not.toContain('knowledge_limit_exceeded');
  });

  it('does not run at all when grounding is disabled', () => {
    const input = withConfig(withKnowledge({ maxTopK: 1, languages: ['en-US'] }), {
      mode: 'agent',
      knowledge: policy({ enabled: false, topK: 9 }),
    });
    expect(codes(input, 'live')).not.toContain('knowledge_limit_exceeded');
  });
});

describe('a fixture call with a knowledge plugin', () => {
  it('requires the slot to be listed, like every other provider slot', () => {
    const input = withConfig(withKnowledge(), { mode: 'agent', knowledge: policy() });
    input.fixturePluginIds = (input.fixturePluginIds ?? []).filter((id) => id !== 'librarian');
    expect(codes(input, 'test')).toContain('fixture_unavailable');
  });

  it('is satisfied by a listed plugin, including one whose published script is empty', () => {
    const input = withConfig(withKnowledge(), { mode: 'agent', knowledge: policy() });
    expect(codes(input, 'test')).not.toContain('fixture_unavailable');
  });
});
