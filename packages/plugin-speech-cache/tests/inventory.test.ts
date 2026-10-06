import { describe, expect, it } from 'vitest';
import { AgentConfig, type TextFilter } from '@winsendotai/ovo-contracts';
import {
  filterSpeechText,
  indianVerbalisationFilter,
  markdownFilter,
  plugins as voicePlugins,
  urlFilter,
} from '../../plugin-voice/src/index.ts';
import {
  ApprovedSpeechPolicy,
  composeReleaseTextFilters,
  normalizeSpeechInventory,
  normalizeSpeechText,
  staticSpeechInventory,
} from '../src/index.ts';

const config = AgentConfig.parse({
  name: 'Collections',
  mode: 'faq',
  message: 'Hello, this is Monika from the bank.',
  processing: { initial: 'One moment.', progress: 'Still checking.' },
  clarification: 'Could you repeat that?',
  uncertainty: 'I do not have that information.',
  faq: [
    { id: 'hours', question: 'hours?', answer: 'We are open nine to six.' },
    { id: 'due', question: 'due?', answer: 'Your EMI of {{emi}} is due.' },
  ],
  tools: [
    {
      id: 'lookup',
      description: 'Lookup',
      connector: 'native',
      inputSchema: {},
      effect: 'read',
      processing: { initial: 'Looking that up.', failure: 'The lookup failed.' },
    },
  ],
  decision: {
    enabled: true,
    state: { sources: ['last-turn'] },
    questions: [
      {
        id: 'intent',
        type: 'choice',
        instructions: 'What do they want?',
        threshold: 0.6,
        fallback: 'llm',
        options: [
          { key: 'pay', description: 'Will pay', outcome: { say: 'Thank you, I will note that.' } },
          { key: 'later', description: 'Later', outcome: {} },
        ],
      },
      {
        id: 'mood',
        type: 'score',
        instructions: 'How upset?',
        threshold: 0.5,
        fallback: 'clarify',
        rubric: ['calm', 'upset'],
        bands: [{ atLeast: 0, outcome: { say: 'I understand.' } }],
      },
    ],
  },
  script: {
    start: 'open',
    nodes: [
      {
        id: 'open',
        prompt: 'Press 1 to continue.',
        terminal: false,
        transitions: [{ event: 'dtmf', matches: ['1'], to: 'end' }],
      },
      { id: 'end', prompt: 'Goodbye {{name}}.', terminal: true },
    ],
  },
});

describe('static speech inventory (TTS-5)', () => {
  it('walks every fixed line and splits templated lines out', () => {
    const inventory = staticSpeechInventory({
      config,
      selections: {
        turnDetector: { config: { idle: { prompts: ['Are you there?', 'Hello?'] } } },
      },
    });
    expect(inventory.static).toEqual([
      { text: 'Hello, this is Monika from the bank.', source: 'greeting' },
      { text: 'One moment.', source: 'processing' },
      { text: 'Still checking.', source: 'processing' },
      { text: 'I could not complete that check.', source: 'processing' },
      { text: 'Looking that up.', source: 'processing' },
      { text: 'The lookup failed.', source: 'processing' },
      { text: 'Could you repeat that?', source: 'clarification' },
      { text: 'I do not have that information.', source: 'uncertainty' },
      { text: 'We are open nine to six.', source: 'faq' },
      { text: 'Thank you, I will note that.', source: 'decision' },
      { text: 'I understand.', source: 'decision' },
      { text: 'Press 1 to continue.', source: 'script' },
      { text: 'Are you there?', source: 'idle-prompt' },
      { text: 'Hello?', source: 'idle-prompt' },
    ]);
    expect(inventory.perCall).toEqual([
      { text: 'Your EMI of {{emi}} is due.', source: 'faq' },
      { text: 'Goodbye {{name}}.', source: 'script' },
    ]);
  });

  it('includes the greet-first opening lines and the voicemail message', () => {
    const greetFirst = {
      ...config,
      opening: { lines: ['Hi, this is Monika from the bank.', 'Am I speaking with {{name}}?'] },
      voicemail: {
        detect: true,
        timeoutMs: 4000,
        action: 'message' as const,
        message: 'Please call us back.',
      },
    };
    const inventory = staticSpeechInventory({ config: greetFirst });
    expect(inventory.static.slice(0, 3)).toEqual([
      { text: 'Hello, this is Monika from the bank.', source: 'greeting' },
      { text: 'Hi, this is Monika from the bank.', source: 'opening' },
      { text: 'Please call us back.', source: 'voicemail' },
    ]);
    expect(inventory.perCall).toContainEqual({
      text: 'Am I speaking with {{name}}?',
      source: 'opening',
    });
  });

  it('includes every line of an enabled flow, one clip per line', () => {
    const flowAgent = AgentConfig.parse({
      name: 'Flow',
      mode: 'agent',
      variables: { type: 'object', properties: { name: { type: 'string' } } },
      decision: {
        enabled: true,
        flow: {
          start: 'greet',
          lines: { hello: 'Hello.', ask: 'Is this {{name}}?', bye: 'Goodbye.' },
          nodes: [
            { id: 'greet', say: ['hello', 'ask'], listen: 'identity' },
            { id: 'bye', say: ['bye'], end: true },
          ],
          listens: [
            {
              id: 'identity',
              question: 'Who is it?',
              intents: [{ key: 'yes', description: 'Them', next: 'bye' }],
            },
          ],
        },
      },
    });
    const inventory = staticSpeechInventory({ config: flowAgent });
    expect(inventory.static.filter((line) => line.source === 'flow')).toEqual([
      { text: 'Hello.', source: 'flow' },
      { text: 'Goodbye.', source: 'flow' },
    ]);
    expect(inventory.perCall).toContainEqual({ text: 'Is this {{name}}?', source: 'flow' });
    const off = AgentConfig.parse({
      ...flowAgent,
      decision: { ...flowAgent.decision!, enabled: false },
    });
    expect(staticSpeechInventory({ config: off }).static.map((line) => line.source)).not.toContain(
      'flow',
    );
  });

  it('includes the guardrail safe line only when the guardrail can block', () => {
    const agent = (mode: 'flag' | 'block') =>
      AgentConfig.parse({
        name: 'Guarded',
        mode: 'agent',
        guardrail: { mode, safeLine: 'Let me confirm that with my team.' },
      });
    expect(staticSpeechInventory({ config: agent('block') }).static).toContainEqual({
      text: 'Let me confirm that with my team.',
      source: 'guardrail',
    });
    expect(
      staticSpeechInventory({ config: agent('flag') }).static.map((line) => line.source),
    ).not.toContain('guardrail');
  });

  it('uses the default idle prompt for a selected turn detector and skips disabled decisions', () => {
    const off = AgentConfig.parse({ ...config, decision: { ...config.decision!, enabled: false } });
    const inventory = staticSpeechInventory({
      config: off,
      selections: { turnDetector: { config: {} } },
    });
    expect(inventory.static.map((line) => line.text)).toContain('Are you still there?');
    expect(inventory.static.map((line) => line.source)).not.toContain('decision');
  });
});

describe('inventory normalization (TTS-6)', () => {
  const filters: TextFilter[] = [indianVerbalisationFilter, urlFilter, markdownFilter];

  it('keys on exactly the text the speaker sends', () => {
    for (const text of ['Pay **₹1,500** by 05/10/2026.', 'Visit https://bank.example.in', '_Hi_'])
      expect(normalizeSpeechText(filters, text, 'en-IN')).toBe(
        filterSpeechText(filters, text, 'en-IN'),
      );
  });

  it('normalizes, de-duplicates and fingerprints the inventory', () => {
    const inventory = staticSpeechInventory({
      config: AgentConfig.parse({
        name: 'Filters',
        mode: 'agent',
        message: 'Pay **₹1,500** today.',
        clarification: 'Pay ₹1,500 today.',
        uncertainty: '***',
      }),
    });
    const normalized = normalizeSpeechInventory(inventory, filters, 'en-IN');
    expect(normalized.texts).toEqual([
      'Pay one thousand five hundred rupees today.',
      'Please wait while I check that.',
      'I could not complete that check.',
    ]);
    expect(normalized.sha256).toMatch(/^[0-9a-f]{64}$/);
    const reordered = normalizeSpeechInventory(
      { static: [...inventory.static].reverse(), perCall: [] },
      filters,
      'en-IN',
    );
    expect(reordered.sha256).toBe(normalized.sha256);
  });

  it('composes the release text filters exactly as the session selects them', async () => {
    const pinned = await composeReleaseTextFilters(
      {
        workspaceId: 'workspace-a',
        config,
        selections: {
          'textFilter:0': {
            pluginId: '@winsendotai/ovo-text-filter-indian-verbalisation',
            version: '0.1.0',
            config: {},
          },
          'textFilter:1': { pluginId: '@acme/missing-filter', version: '1.0.0', config: {} },
        },
      },
      voicePlugins,
    );
    expect(pinned.filters.map((filter) => filter.id)).toEqual([
      '@winsendotai/ovo-text-filter-indian-verbalisation',
    ]);
    expect(pinned.unresolved).toEqual(['@acme/missing-filter']);
    await pinned.close();
    const legacy = await composeReleaseTextFilters(
      { workspaceId: 'workspace-a', config },
      voicePlugins,
      {
        textFilters: ['@winsendotai/ovo-text-filter-markdown'],
      },
    );
    expect(legacy.filters.map((filter) => filter.id)).toEqual([
      '@winsendotai/ovo-text-filter-markdown',
    ]);
    await legacy.close();
  });
});

describe('approved speech policy', () => {
  it('permits a scripted line under any speech kind and nothing else', () => {
    const policy = new ApprovedSpeechPolicy(
      [
        { text: 'Thank you, I will note that.', purpose: 'scripted' },
        { text: 'One moment.', purpose: 'static-phrase' },
      ],
      false,
    );
    for (const kind of ['response', 'acknowledgment', 'progress'] as const)
      expect(policy.permits('Thank you, I will note that.', kind)).toBe(true);
    expect(policy.permits('One moment.', 'response')).toBe(false);
    expect(policy.permits('One moment.', 'acknowledgment')).toBe(true);
    expect(policy.permits('A model answer.', 'response')).toBe(false);
    expect(policy.isScripted('One moment.')).toBe(false);
  });
});
