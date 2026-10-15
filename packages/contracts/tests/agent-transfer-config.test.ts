import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  agentTransferLines,
  disclosureLines,
  disclosureParts,
  filterDeclaredVariables,
  TRANSFER_TO_AGENT_TOOL_ID,
} from '../src/index.ts';
import { collectionsFlow } from './flow-fixture.ts';

const agent = (over: Record<string, unknown>) =>
  AgentConfig.safeParse({ name: 'Sales', mode: 'agent', ...over });
const messages = (parsed: ReturnType<typeof agent>) =>
  parsed.error?.issues.map((issue) => [issue.path, issue.message]) ?? [];

/** The collections flow with a `billing` end node. */
function flow() {
  const graph = collectionsFlow();
  graph.lines.billing = 'Let me get you to billing.';
  graph.nodes.push({ id: 'billing', say: ['billing'], end: true, disposition: 'billing' });
  return { enabled: true, questions: [], flow: graph };
}

describe('agent-to-agent transfer config (R2)', () => {
  it('parses with every trigger off by default', () => {
    const parsed = agent({ handoff: { agents: {} } });
    expect(parsed.data?.handoff?.agents).toEqual({ llmTool: false, nodes: {} });
    expect(agent({ handoff: { agents: { inbound: {} } } }).data?.handoff?.agents?.inbound).toEqual({
      greeting: 'opening',
    });
  });

  it('accepts flow end nodes that transfer to a target key', () => {
    const parsed = agent({
      decision: flow(),
      handoff: { agents: { llmTool: true, nodes: { billing: 'billing' } } },
    });
    expect(messages(parsed)).toEqual([]);
  });

  it('refuses unknown nodes, nodes that do not end, and a node that already transfers to a person', () => {
    const unknown = agent({
      decision: flow(),
      handoff: { agents: { nodes: { ghost: 'billing' } } },
    });
    expect(messages(unknown)).toEqual([
      [['handoff', 'agents', 'nodes', 'ghost'], 'Agent transfer node ghost is not a flow node'],
    ]);
    const open = agent({ decision: flow(), handoff: { agents: { nodes: { greet: 'billing' } } } });
    expect(messages(open)).toEqual([
      [
        ['handoff', 'agents', 'nodes', 'greet'],
        'Agent transfer node greet must end the call (end: true)',
      ],
    ]);
    const both = agent({
      decision: flow(),
      handoff: {
        transfer: { target: { kind: 'phone', e164: '+918041234567' }, nodes: ['billing'] },
        agents: { nodes: { billing: 'billing' } },
      },
    });
    expect(messages(both)).toEqual([
      [
        ['handoff', 'agents', 'nodes', 'billing'],
        'Node billing already transfers the caller to a person',
      ],
    ]);
    expect(agent({ handoff: { agents: { nodes: { billing: 'Billing!' } } } }).success).toBe(false);
  });

  it('reserves the tool id only when the tool is offered', () => {
    const tools = [
      {
        id: TRANSFER_TO_AGENT_TOOL_ID,
        description: 'x',
        connector: 'native',
        inputSchema: {},
        effect: 'read',
      },
    ];
    expect(messages(agent({ tools, handoff: { agents: { llmTool: true } } }))).toEqual([
      [['tools'], 'Tool id transfer_to_agent is reserved for handoff'],
    ]);
    expect(agent({ tools, handoff: { agents: {} } }).success).toBe(true);
  });

  it('needs inbound.line for a line greeting', () => {
    expect(messages(agent({ handoff: { agents: { inbound: { greeting: 'line' } } } }))).toEqual([
      [['handoff', 'agents', 'inbound', 'line'], 'A line greeting needs inbound.line'],
    ]);
    expect(
      agent({ handoff: { agents: { inbound: { greeting: 'line', line: 'Hi, billing here.' } } } })
        .success,
    ).toBe(true);
  });

  it('lists the fixed transfer lines with their fields', () => {
    const config = agent({
      handoff: {
        agents: {
          line: 'One moment, moving you over.',
          inbound: {
            greeting: 'line',
            line: 'Hi {{name}}, billing here.',
            returnLine: "I'm back.",
          },
        },
      },
    }).data!;
    expect(agentTransferLines(config)).toEqual([
      { field: 'handoff.agents.line', text: 'One moment, moving you over.' },
      { field: 'handoff.agents.inbound.line', text: 'Hi {{name}}, billing here.' },
      { field: 'handoff.agents.inbound.returnLine', text: "I'm back." },
    ]);
    expect(agentTransferLines({})).toEqual([]);
    expect(agentTransferLines(agent({ handoff: { agents: {} } }).data!)).toEqual([]);
  });
});

describe('disclosureParts', () => {
  it('names each disclosure part in speaking order, matching disclosureLines', () => {
    const compliance = {
      disclosure: { text: 'This call is recorded.' },
      disclosures: {
        identity: { text: 'This is Acme.' },
        ai: { text: 'I am an AI assistant.' },
        optOutHint: { text: 'Say stop to opt out.' },
      },
    };
    const parts = disclosureParts(compliance);
    expect(parts.map((part) => part.kind)).toEqual(['identity', 'ai', 'recording', 'opt_out_hint']);
    expect(parts.map((part) => part.text)).toEqual(disclosureLines(compliance));
    expect(disclosureParts({ disclosure: { text: 'Recorded.' } })).toEqual([
      { kind: 'recording', text: 'Recorded.' },
    ]);
    expect(disclosureParts(undefined)).toEqual([]);
  });
});

describe('filterDeclaredVariables', () => {
  const strict = {
    variables: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        amount: { type: 'number' },
        visits: { type: 'integer' },
        vip: { type: 'boolean' },
        plan: { type: 'string', enum: ['gold', 'silver'] },
        note: { type: ['string', 'null'] },
        anything: {},
        ovo_route_intent: { type: 'string' },
      },
    },
  };

  it('keeps every variable under an open schema', () => {
    const variables = { name: 'Asha', extra: 1 };
    expect(filterDeclaredVariables({ variables: { type: 'object' } }, variables)).toEqual(
      variables,
    );
    expect(filterDeclaredVariables({ variables: { type: 'object' } }, variables)).not.toBe(
      variables,
    );
  });

  it('keeps only declared names whose value matches the declared type and enum', () => {
    expect(
      filterDeclaredVariables(strict, {
        name: 'Asha',
        amount: 12.5,
        visits: 3,
        vip: true,
        plan: 'gold',
        note: null,
        anything: { nested: true },
        ovo_route_intent: 'sales',
        undeclared: 'x',
        ovo_route_language: 'hi',
      }),
    ).toEqual({
      name: 'Asha',
      amount: 12.5,
      visits: 3,
      vip: true,
      plan: 'gold',
      note: null,
      anything: { nested: true },
      ovo_route_intent: 'sales',
    });
  });

  it('drops type mismatches and values outside the enum', () => {
    expect(
      filterDeclaredVariables(strict, {
        name: 42,
        amount: '12',
        visits: 2.5,
        vip: 'yes',
        plan: 'bronze',
        note: 3,
      }),
    ).toEqual({});
    expect(filterDeclaredVariables(strict, { amount: Number.NaN })).toEqual({});
  });
});
