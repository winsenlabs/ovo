import { describe, expect, it } from 'vitest';
import {
  ROUTING_ISSUE_CODES,
  routingIssueAnchor,
  type IssueAnchor,
  type RoutingIssueCode,
} from '../src/index.ts';
import { queueDraft } from './human-queue-fixture.ts';

/**
 * One representative path per issue code, as the structural checks and the publish resolution
 * produce it. A new code fails the coverage test until it is anchored here.
 */
const NODE = { nodeId: 'intent', nodeIndex: 0 };
const PATHS: Record<RoutingIssueCode, { path: (string | number)[]; anchor: IssueAnchor }> = {
  routing_root_missing: { path: ['root'], anchor: { section: 'point' } },
  routing_node_duplicate: { path: ['nodes', 0, 'id'], anchor: { section: 'node', ...NODE } },
  routing_node_unknown: {
    path: ['nodes', 0, 'branches', 1, 'next'],
    anchor: { section: 'branch', ...NODE, branchKey: 'support' },
  },
  routing_node_cycle: {
    path: ['nodes', 0, 'branches', 0, 'next'],
    anchor: { section: 'branch', ...NODE, branchKey: 'sales' },
  },
  routing_node_unreachable: { path: ['nodes', 0], anchor: { section: 'node', ...NODE } },
  routing_depth_exceeded: { path: ['nodes', 0], anchor: { section: 'node', ...NODE } },
  routing_branch_duplicate: {
    path: ['nodes', 0, 'branches', 1, 'key'],
    anchor: { section: 'branch', ...NODE, branchKey: 'support' },
  },
  routing_rule_branch_unknown: {
    path: ['nodes', 0, 'engines', 0, 'rules', 1, 'branch'],
    anchor: { section: 'engine', ...NODE, engineIndex: 0 },
  },
  routing_fallback_not_terminal: {
    path: ['nodes', 0, 'fallback'],
    anchor: { section: 'fallback', ...NODE },
  },
  routing_line_default_missing: { path: ['greeting'], anchor: { section: 'lines' } },
  routing_language_unallowed: { path: ['language', 'allowed'], anchor: { section: 'languages' } },
  routing_node_ask_missing: { path: ['nodes', 0, 'ask'], anchor: { section: 'node', ...NODE } },
  routing_human_unavailable: {
    path: ['nodes', 0, 'branches', 2, 'target'],
    anchor: { section: 'branch', ...NODE, branchKey: 'person' },
  },
  routing_limits_exceeded: { path: [], anchor: { section: 'point' } },
  routing_transfer_key_duplicate: {
    path: ['transfer', 'targets', 1, 'key'],
    anchor: { section: 'transfer', targetKey: 'another_language' },
  },
  routing_transfer_node_unknown: {
    path: ['transfer', 'targets', 1, 'destination', 'node'],
    anchor: { section: 'transfer', targetKey: 'another_language' },
  },
  routing_transfer_timeout_not_terminal: {
    path: ['transfer', 'targets', 0, 'hold', 'onTimeout'],
    anchor: { section: 'hold', targetKey: 'support' },
  },
  routing_transfer_timeout_target_unknown: {
    path: ['transfer', 'hold', 'onTimeout', 0, 'key'],
    anchor: { section: 'hold' },
  },
  routing_transfer_hold_loop_invalid: {
    path: ['transfer', 'hold', 'loopFrom'],
    anchor: { section: 'hold' },
  },
  routing_transfer_return_unused: {
    path: ['transfer', 'hold', 'onTimeout', 1],
    anchor: { section: 'hold' },
  },
  routing_transfer_human_unavailable: {
    path: ['transfer', 'targets', 0, 'hold', 'onTimeout', 0],
    anchor: { section: 'hold', targetKey: 'support' },
  },
  routing_queue_key_duplicate: {
    path: ['humanQueues', 1, 'key'],
    anchor: { section: 'queues', queueKey: 'floor' },
  },
  routing_queue_unknown: {
    path: ['nodes', 0, 'branches', 2, 'target', 'queueId'],
    anchor: { section: 'branch', ...NODE, branchKey: 'person' },
  },
  routing_queue_unused: {
    path: ['humanQueues', 0],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_chain_loop: {
    path: ['transfer', 'hold', 'onTimeout', 1, 'queueId'],
    anchor: { section: 'hold' },
  },
  routing_queue_return_target_unknown: {
    path: ['queues', 'abcdef01-0000-4000-8000-000000000002', 'definition', 'returnTargets', 0],
    anchor: { section: 'queues', queueKey: 'floor' },
  },
  routing_queue_limits_exceeded: { path: ['humanQueues'], anchor: { section: 'queues' } },
  routing_router_missing: { path: ['router'], anchor: { section: 'agents' } },
  routing_router_mode: { path: ['router'], anchor: { section: 'agents' } },
  routing_router_input_missing: { path: ['router'], anchor: { section: 'agents' } },
  routing_router_cost_policy_missing: { path: ['router'], anchor: { section: 'agents' } },
  routing_default_target_missing: { path: ['defaultTarget'], anchor: { section: 'agents' } },
  routing_pool_missing: {
    path: ['nodes', 0, 'branches', 0, 'target', 'poolId'],
    anchor: { section: 'branch', ...NODE, branchKey: 'sales' },
  },
  routing_pool_deleted: {
    path: ['nodes', 0, 'branches', 0, 'target', 'poolId'],
    anchor: { section: 'branch', ...NODE, branchKey: 'sales' },
  },
  routing_member_release_missing: {
    path: ['pools', 'pool-1', 'members', 0, 'agent'],
    anchor: { section: 'agents', targetKey: 'pool-1' },
  },
  routing_member_meter_uncovered: {
    path: ['pools', 'pool-1', 'members', 1, 'agent'],
    anchor: { section: 'agents', targetKey: 'pool-1' },
  },
  routing_engine_llm_unselected: {
    path: ['nodes', 0, 'engines', 1],
    anchor: { section: 'engine', ...NODE, engineIndex: 1 },
  },
  routing_engine_decision_unselected: {
    path: ['nodes', 0, 'engines', 1],
    anchor: { section: 'engine', ...NODE, engineIndex: 1 },
  },
  routing_external_endpoint_invalid: {
    path: ['nodes', 0, 'engines', 1, 'endpoint'],
    anchor: { section: 'engine', ...NODE, engineIndex: 1 },
  },
  routing_external_credential_missing: {
    path: ['nodes', 0, 'engines', 1, 'credentialId'],
    anchor: { section: 'engine', ...NODE, engineIndex: 1 },
  },
  routing_line_builtin_missing: {
    path: ['nodes', 0, 'fallback'],
    anchor: { section: 'fallback', ...NODE },
  },
  routing_external_disabled: {
    path: ['nodes', 0, 'engines', 1],
    anchor: { section: 'engine', ...NODE, engineIndex: 1 },
  },
  routing_recording_mismatch: { path: ['defaultTarget'], anchor: { section: 'agents' } },
  routing_language_uncovered: {
    path: ['nodes', 0, 'branches', 0, 'target'],
    anchor: { section: 'branch', ...NODE, branchKey: 'sales' },
  },
  routing_router_has_agent_config: { path: ['router'], anchor: { section: 'agents' } },
  routing_router_is_only_release: { path: ['defaultTarget'], anchor: { section: 'agents' } },
  routing_transfer_agent_missing: {
    path: ['transfer', 'targets', 3, 'destination', 'agent'],
    anchor: { section: 'transfer', targetKey: 'billing' },
  },
  routing_transfer_pool_missing: {
    path: ['transfer', 'targets', 0, 'destination', 'poolId'],
    anchor: { section: 'transfer', targetKey: 'support' },
  },
  routing_transfer_pool_deleted: {
    path: ['transfer', 'targets', 0, 'destination', 'poolId'],
    anchor: { section: 'transfer', targetKey: 'support' },
  },
  routing_transfer_audio_missing: {
    path: ['transfer', 'hold', 'steps', 0, 'assetId'],
    anchor: { section: 'hold' },
  },
  routing_transfer_audio_deleted: {
    path: ['transfer', 'hold', 'steps', 0, 'assetId'],
    anchor: { section: 'hold' },
  },
  routing_transfer_line_builtin_missing: {
    path: ['transfer', 'announcement'],
    anchor: { section: 'transfer' },
  },
  routing_transfer_disabled: { path: ['transfer'], anchor: { section: 'transfer' } },
  routing_transfer_unreachable: { path: ['transfer', 'targets'], anchor: { section: 'transfer' } },
  routing_transfer_source_unknown: {
    path: ['transfer', 'targets', 0, 'from', 0],
    anchor: { section: 'transfer', targetKey: 'support' },
  },
  routing_queue_missing: {
    path: ['humanQueues', 1, 'queueId'],
    anchor: { section: 'queues', queueKey: 'floor' },
  },
  routing_queue_deleted: {
    path: ['humanQueues', 0, 'queueId'],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_disabled: {
    path: ['humanQueues', 0],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_transfer_required: {
    path: ['humanQueues', 0],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_webhook_disabled: {
    path: ['humanQueues', 0],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_endpoint_invalid: {
    path: ['humanQueues', 0, 'webhook', 'url'],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_credential_missing: {
    path: ['humanQueues', 0, 'webhook', 'credentialId'],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_destination_policy_empty: {
    path: ['humanQueues', 0, 'destination'],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_mapping_invalid: {
    path: ['humanQueues', 0, 'webhook', 'body', 'ani'],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_mapping_field_disabled: {
    path: ['humanQueues', 0, 'webhook', 'body', 'ani'],
    anchor: { section: 'queues', queueKey: 'support-desk' },
  },
  routing_queue_room_unavailable: {
    path: ['humanQueues', 1],
    anchor: { section: 'queues', queueKey: 'floor' },
  },
  routing_queue_no_operators: {
    path: ['humanQueues', 1],
    anchor: { section: 'queues', queueKey: 'floor' },
  },
  routing_queue_meter_unpriced: {
    path: ['humanQueues', 1],
    anchor: { section: 'queues', queueKey: 'floor' },
  },
  routing_queue_language_uncovered: {
    path: ['humanQueues', 1],
    anchor: { section: 'queues', queueKey: 'floor' },
  },
  routing_queue_call_limit_short: {
    path: ['humanQueues', 1],
    anchor: { section: 'queues', queueKey: 'floor' },
  },
};

describe('routingIssueAnchor', () => {
  const draft = queueDraft();

  it('has a table row for every issue code and none extra', () => {
    expect(Object.keys(PATHS).sort()).toEqual([...ROUTING_ISSUE_CODES].sort());
  });

  it.each(Object.entries(PATHS))(
    '%s anchors where the designer shows it',
    (_code, { path, anchor }) => {
      const found = routingIssueAnchor(draft, { path });
      expect(found.section).toBe(anchor.section);
      for (const key of [
        'nodeId',
        'nodeIndex',
        'branchKey',
        'engineIndex',
        'targetKey',
        'queueKey',
      ] as const)
        if (anchor[key] !== undefined) expect(found[key], key).toBe(anchor[key]);
    },
  );

  it('names the branch key of the branch a path points at', () => {
    expect(routingIssueAnchor(draft, { path: ['nodes', 0, 'branches', 0, 'target'] })).toEqual({
      section: 'branch',
      nodeId: 'intent',
      nodeIndex: 0,
      branchKey: 'sales',
    });
  });

  it('names the fallback step and the engine', () => {
    expect(routingIssueAnchor(draft, { path: ['nodes', 0, 'fallback', 2, 'line'] })).toMatchObject({
      section: 'fallback',
      stepIndex: 2,
    });
    expect(
      routingIssueAnchor(draft, { path: ['nodes', 0, 'engines', 1, 'threshold'] }),
    ).toMatchObject({
      section: 'engine',
      engineIndex: 1,
    });
  });

  it('finds the queue of a pinned queue snapshot path by queue id', () => {
    expect(
      routingIssueAnchor(draft, {
        path: ['queues', 'abcdef01-0000-4000-8000-000000000001', 'definition', 'hold'],
      }),
    ).toEqual({ section: 'queues', queueKey: 'support-desk' });
  });

  it('falls back to the point for paths it does not know and for stale indexes', () => {
    expect(routingIssueAnchor(draft, { path: [] })).toEqual({ section: 'point' });
    expect(routingIssueAnchor(draft, { path: ['mystery', 1] })).toEqual({ section: 'point' });
    expect(routingIssueAnchor(draft, { path: ['nodes', 99, 'branches', 4] })).toEqual({
      section: 'branch',
      nodeIndex: 99,
    });
    expect(routingIssueAnchor(draft, { path: ['humanQueues', 9] })).toEqual({ section: 'queues' });
    expect(routingIssueAnchor(draft, { path: ['transfer', 'targets', 9, 'key'] })).toEqual({
      section: 'transfer',
    });
  });

  it('works on a draft without transfer or queues', () => {
    const plain = queueDraft((d) => {
      delete d.transfer;
      delete d.humanQueues;
    });
    expect(routingIssueAnchor(plain, { path: ['transfer', 'hold'] })).toEqual({ section: 'hold' });
    expect(routingIssueAnchor(plain, { path: ['humanQueues', 0] })).toEqual({ section: 'queues' });
  });
});
