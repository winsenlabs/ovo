import { describe, expect, it } from 'vitest';
import type { CredentialMetadata } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import {
  costPolicy,
  DEFAULT_RELEASE,
  exampleReleases,
  POOL_SALES,
  POOL_SUPPORT,
  release,
  ROUTER_RELEASE,
  SALES_HI_RELEASE,
  SUPPORT_RELEASE,
} from './routing-fixtures.ts';
import {
  issues,
  codes,
  withRouter,
  externalEngine,
  OTHER,
  type Setup,
} from './routing-publish-harness.ts';

describe('publish validation (A4): one test per blocker', () => {
  it('passes the worked example with no issue', async () => {
    expect(await issues()).toEqual([]);
  });

  it('routing_router_missing: no release of the router agent', async () => {
    expect(codes(await issues({ releases: exampleReleases().slice(1) }))).toEqual([
      ['routing_router_missing', 'error'],
    ]);
  });

  it('routing_router_mode: the router release is not an agent', async () => {
    const found = await issues({ releases: withRouter({ config: { mode: 'faq' } }) });
    expect(codes(found)).toEqual([['routing_router_mode', 'error']]);
    expect(found[0]!.path).toEqual(['router']);
  });

  it('routing_router_input_missing: the router release has no STT selection', async () => {
    const found = await issues({ releases: withRouter({ selections: { llm: {} } }) });
    expect(codes(found)).toEqual([['routing_router_input_missing', 'error']]);
  });

  it('routing_router_cost_policy_missing: only when a cost policy is required', async () => {
    expect(codes(await issues({ requireCostPolicy: true }))).toEqual([
      ['routing_router_cost_policy_missing', 'error'],
    ]);
    const priced = withRouter({
      config: { costPolicy: costPolicy(['stt-a.seconds', 'llm-a.seconds']) },
    });
    expect(await issues({ requireCostPolicy: true, releases: priced })).toEqual([]);
  });

  it('routing_default_target_missing: the default agent has no release', async () => {
    const releases = exampleReleases().filter((item) => item.id !== DEFAULT_RELEASE);
    const found = await issues({
      releases,
      pools: { [POOL_SALES]: [['sales-hi', ['en', 'hi']]], [POOL_SUPPORT]: [['support', ['en']]] },
    });
    expect(codes(found)).toEqual([['routing_default_target_missing', 'error']]);
    expect(found[0]!.path).toEqual(['defaultTarget']);
  });

  it('routing_pool_missing: a target names a pool the service does not hold', async () => {
    const found = await issues({
      patch: (draft) => (draft.nodes[0].branches[1].target.poolId = OTHER),
    });
    expect(codes(found)).toEqual([['routing_pool_missing', 'error']]);
    expect(found[0]!.path).toEqual(['nodes', 0, 'branches', 1, 'target', 'poolId']);
  });

  it('routing_pool_deleted: a target names a pool deleted since the draft was saved', async () => {
    const found = await issues({ deletedPools: [POOL_SUPPORT] });
    expect(found.map((issue) => [issue.code, issue.path])).toEqual([
      ['routing_pool_deleted', ['nodes', 0, 'branches', 1, 'target', 'poolId']],
    ]);
  });

  it('routing_member_release_missing: a member or a direct agent without a release', async () => {
    const found = await issues({
      releases: exampleReleases().filter((item) => item.id !== SUPPORT_RELEASE),
      patch: (draft) =>
        (draft.nodes[0].branches[1].target = {
          kind: 'agent',
          agent: { agentId: 'ghost', release: { kind: 'latest' } },
        }),
      pools: {
        [POOL_SALES]: [
          ['sales-en', ['en']],
          ['support', ['hi']],
        ],
      },
    });
    expect(found.map((issue) => [issue.code, issue.path])).toEqual([
      ['routing_member_release_missing', ['nodes', 0, 'branches', 1, 'target', 'agent']],
      ['routing_member_release_missing', ['pools', POOL_SALES, 'members', 1, 'agent']],
    ]);
  });

  it('routing_member_meter_uncovered: a member meter the router policy does not price', async () => {
    const releases = [
      release(ROUTER_RELEASE, 'front-desk', {
        config: { costPolicy: costPolicy(['stt-a.seconds', 'llm-a.seconds']) },
      }),
      release(DEFAULT_RELEASE, 'sales-en'),
      release(SALES_HI_RELEASE, 'sales-hi', {
        selections: { stt: { pluginId: 'stt-b', version: '1.0.0', config: {} } },
      }),
      release(SUPPORT_RELEASE, 'support'),
    ];
    const found = await issues({ releases });
    expect(codes(found)).toEqual([['routing_member_meter_uncovered', 'error']]);
    expect(found[0]!.path).toEqual(['pools', POOL_SALES, 'members', 1, 'agent']);
    expect(found[0]!.message).toContain('stt-b.seconds (missing)');
  });

  it('routing_engine_llm_unselected: an llm engine without the router LLM', async () => {
    const found = await issues({ releases: withRouter({ selections: { stt: {} } }) });
    expect(found.map((issue) => [issue.code, issue.path])).toEqual([
      ['routing_engine_llm_unselected', ['nodes', 0, 'engines', 1]],
    ]);
  });

  it('routing_engine_decision_unselected: a decision engine without the decision slot', async () => {
    const found = await issues({
      patch: (draft) =>
        draft.nodes[0].engines.push({ kind: 'decision', instructions: 'Pick the intent.' }),
    });
    expect(codes(found)).toEqual([['routing_engine_decision_unselected', 'error']]);
  });

  it('routing_external_endpoint_invalid: a private or plain-HTTP endpoint', async () => {
    const credentials = [{ id: 'route-secret' }];
    for (const endpoint of ['http://route.example.com/decide', 'https://10.0.0.8/decide']) {
      const found = await issues({ credentials, patch: externalEngine({ endpoint }) });
      expect(found.map((issue) => [issue.code, issue.path])).toEqual([
        ['routing_external_endpoint_invalid', ['nodes', 0, 'engines', 2, 'endpoint']],
      ]);
    }
  });

  it('routing_external_credential_missing: absent, retired, or not for the router agent', async () => {
    const cases: Partial<CredentialMetadata>[][] = [
      [],
      [{ id: 'route-secret', status: 'retired' }],
      [{ id: 'route-secret', permittedAgentIds: ['sales-en'] }],
      [{ id: 'route-secret', expiresAt: '2020-01-01T00:00:00.000Z' }],
    ];
    for (const credentials of cases)
      expect(codes(await issues({ credentials, patch: externalEngine() }))).toEqual([
        ['routing_external_credential_missing', 'error'],
      ]);
    const allowed = [{ id: 'route-secret', permittedAgentIds: ['front-desk'] }];
    expect(await issues({ credentials: allowed, patch: externalEngine() })).toEqual([]);
  });

  it('routing_line_builtin_missing: a default language without built-in lines', async () => {
    const found = await issues({
      patch: (draft) => {
        draft.language = { default: 'ta', allowed: ['ta', 'en'] };
        draft.greeting = { ta: 'வணக்கம்' };
        draft.nodes[0].ask = { ta: 'எப்படி உதவலாம்?' };
        draft.nodes[0].fallback = [{ kind: 'reask' }, { kind: 'default' }];
      },
      languageFallback: ['en'],
    });
    expect(found.map((issue) => [issue.code, issue.path])).toEqual([
      ['routing_line_builtin_missing', ['connecting']],
      ['routing_line_builtin_missing', ['nodes', 0, 'fallback']],
    ]);
  });

  it('carries every structural error of the draft as a blocker', async () => {
    const found = await issues({
      patch: (draft) =>
        draft.nodes[0].engines[0].rules.push({
          branch: 'refunds',
          when: [{ kind: 'dtmf', digits: '9' }],
        }),
    });
    expect(codes(found)).toEqual([['routing_rule_branch_unknown', 'error']]);
  });
});

describe('publish validation (A4): one test per warning', () => {
  it('routing_external_disabled: an external engine while egress is off', async () => {
    const found = await issues({
      externalEnabled: false,
      credentials: [{ id: 'route-secret' }],
      patch: externalEngine(),
    });
    expect(codes(found)).toEqual([['routing_external_disabled', 'warning']]);
  });

  it('routing_human_unavailable: a human step, skipped in R1', async () => {
    const found = await issues({
      patch: (draft) => draft.nodes[0].fallback.splice(1, 0, { kind: 'human', queueId: 'desk' }),
    });
    expect(codes(found)).toEqual([['routing_human_unavailable', 'warning']]);
  });

  it('routing_recording_mismatch: a member records while the router does not', async () => {
    const releases = exampleReleases();
    releases[2] = release(SALES_HI_RELEASE, 'sales-hi', { config: { recording: true } });
    const found = await issues({ releases });
    expect(codes(found)).toEqual([['routing_recording_mismatch', 'warning']]);
    // A router that records covers every member.
    releases[0] = release(ROUTER_RELEASE, 'front-desk', { config: { recording: true } });
    expect(await issues({ releases })).toEqual([]);
  });

  it('routing_language_uncovered: an allowed language no caller-pool member speaks', async () => {
    const pools = {
      [POOL_SALES]: [['sales-en', ['en']]],
      [POOL_SUPPORT]: [['support', ['en']]],
    } as Setup['pools'];
    const found = await issues({ pools });
    expect(found.map((issue) => [issue.code, issue.severity, issue.path])).toEqual([
      ['routing_language_uncovered', 'warning', ['nodes', 0, 'branches', 0, 'target']],
    ]);
    expect(found[0]!.message).toContain('hi');
    expect(await issues({ pools, languageFallback: ['en'] })).toEqual([]);
  });

  it('routing_router_has_agent_config: an opening or tools that will not run', async () => {
    for (const config of [{ opening: { text: 'Hello' } }, { tools: [{ id: 'lookup' }] }])
      expect(codes(await issues({ releases: withRouter({ config }) }))).toEqual([
        ['routing_router_has_agent_config', 'warning'],
      ]);
  });

  it('routing_node_unreachable: a node no branch leads to', async () => {
    const found = await issues({
      patch: (draft) => draft.nodes.push({ ...structuredClone(draft.nodes[0]), id: 'orphan' }),
    });
    expect(codes(found)).toEqual([['routing_node_unreachable', 'warning']]);
  });
});
