import {
  RoutingPointDraft,
  type FallbackStep,
  type RouteAgentRef,
  type RoutingBranch,
  type RoutingEngine,
  type RoutingNode,
  type RoutingTarget,
  type RoutingTransferPolicy,
  type RulesMatcher,
  type TransferTarget,
} from '@winsendotai/ovo-contracts';

/** A stored draft parsed with the contract defaults applied; `valid: false` keeps the raw copy. */
export function loadDraft(raw: unknown): { draft: RoutingPointDraft; valid: boolean } {
  const parsed = RoutingPointDraft.safeParse(raw);
  return parsed.success
    ? { draft: parsed.data, valid: true }
    : { draft: raw as RoutingPointDraft, valid: false };
}

export const DEFAULT_LIMITS = { maxTurns: 6, maxRouteSeconds: 90 } as const;

/** The smallest valid point: one question answered by the keypad, falling back to the default agent. */
export function blankDraft(input: {
  name: string;
  routerAgentId: string;
  defaultAgentId: string;
  language?: string;
}): RoutingPointDraft {
  const language = input.language ?? 'en';
  const latest = (agentId: string) => ({ agentId, release: { kind: 'latest' as const } });
  return {
    name: input.name,
    router: latest(input.routerAgentId),
    defaultTarget: latest(input.defaultAgentId),
    language: { default: language, allowed: [language] },
    greeting: { [language]: 'Hello, thanks for calling.' },
    root: 'start',
    nodes: [
      {
        ...blankNode('start'),
        ask: { [language]: 'How can I help you today?' },
        branches: [
          {
            ...blankBranch('main', latest(input.defaultAgentId)),
            description: 'The caller wants to speak to the main team',
          },
        ],
        engines: [
          { kind: 'rules', rules: [{ branch: 'main', when: [{ kind: 'dtmf', digits: '1' }] }] },
        ],
      },
    ],
    limits: { ...DEFAULT_LIMITS },
  };
}

export function blankBranch(key: string, agent?: RouteAgentRef): RoutingBranch {
  return {
    key,
    description: 'What the caller says or wants when this branch applies',
    target: { kind: 'agent', agent: agent ?? { agentId: '', release: { kind: 'latest' } } },
  };
}

export function blankNode(id: string, agent?: RouteAgentRef): RoutingNode {
  return {
    id,
    engines: [blankEngine('llm')],
    branches: [blankBranch('option_a', agent)],
    fallback: [{ kind: 'reask', times: 1 }, { kind: 'default' }],
    reuseTurn: true,
  };
}

export function blankMatcher(kind: RulesMatcher['kind']): RulesMatcher {
  switch (kind) {
    case 'dtmf':
      return { kind, digits: '1' };
    case 'caller-id':
      return { kind, prefixes: ['+91'] };
    case 'time':
      return {
        kind,
        inside: true,
        hours: {
          timezone: 'Asia/Kolkata',
          weekly: { mon: [{ start: '09:00', end: '18:00' }] },
          closed: [],
        },
      };
    case 'variable':
      return { kind, name: 'segment', equals: ['vip'] };
    case 'keywords':
      return { kind, words: ['refund'], maxWords: 12 };
    case 'phrases':
      return { kind, phrases: ['yes'] };
    case 'script':
      return { kind, languages: ['hi'] };
  }
}

export function blankEngine(kind: RoutingEngine['kind'], branch = 'option_a'): RoutingEngine {
  switch (kind) {
    case 'rules':
      return { kind, rules: [{ branch, when: [blankMatcher('dtmf')] }] };
    case 'decision':
      return {
        kind,
        instructions: 'Choose the branch that matches why the caller is calling.',
        threshold: 0.7,
        timeoutMs: 800,
      };
    case 'llm':
      return {
        kind,
        instructions: 'Decide why the caller is calling.',
        threshold: 0.6,
        timeoutMs: 2_500,
        detectLanguage: false,
        generatedClarify: false,
      };
    case 'external':
      return {
        kind,
        endpoint: 'https://',
        credentialId: '',
        timeoutMs: 1_500,
        threshold: 0.5,
        send: { callerId: false, turnText: true, variables: [] },
        slots: [],
      };
  }
}

export function blankFallback(kind: FallbackStep['kind']): FallbackStep {
  switch (kind) {
    case 'reask':
      return { kind, times: 1 };
    case 'default':
      return { kind };
    case 'human':
      return { kind, queueId: '' };
    case 'callback':
      return { kind, inMinutes: 120, line: { en: 'We will call you back shortly.' } };
    case 'end':
      return { kind, line: { en: 'Sorry, we could not connect you. Goodbye.' } };
  }
}

export function blankTarget(kind: RoutingTarget['kind']): RoutingTarget {
  switch (kind) {
    case 'pool':
      return { kind, poolId: '', language: 'caller', skills: [] };
    case 'agent':
      return { kind, agent: { agentId: '', release: { kind: 'latest' } } };
    case 'end':
      return { kind, line: { en: 'Goodbye.' } };
    case 'callback':
      return { kind, inMinutes: 120, line: { en: 'We will call you back shortly.' } };
    case 'human':
      return { kind, queueId: '' };
  }
}

/** A key that no sibling uses: `base`, `base_2`, `base_3`... */
export function freshKey(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

export function blankTransfer(): RoutingTransferPolicy {
  return {
    targets: [],
    confirm: 'never',
    limits: { maxTransfers: 3, returnToPrevious: 'refuse', minRemainingSeconds: 30 },
    handover: { summary: true, transcriptTurns: 6, capturedVariables: true },
  };
}

export function blankTransferTarget(key: string, agent: RouteAgentRef): TransferTarget {
  return {
    key,
    description: 'When the caller needs this team',
    destination: { kind: 'agent', agent },
  };
}
