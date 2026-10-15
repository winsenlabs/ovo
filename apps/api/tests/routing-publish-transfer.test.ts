import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { buildRoutingSnapshot, validateRoutingDraft } from '../src/routing-publish.ts';
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
import { clipInput } from './routing-audio-fixtures.ts';
import { BYE, codes, context, issues, OTHER, type Setup } from './routing-publish-harness.ts';

const CLIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POOL_BILLING = '33333333-3333-4333-8333-333333333333';
const BILLING_RELEASE = '99999999-0000-4000-8000-000000000001';

/** A valid catalogue: a pool, a listed agent and a same-pool target; a point hold with a clip. */
function catalogue(): Record<string, any> {
  return {
    targets: [
      {
        key: 'billing',
        description: 'Payments, refunds and invoices',
        destination: { kind: 'pool', poolId: POOL_BILLING, language: 'any' },
        from: [{ kind: 'pool', poolId: POOL_SALES }],
      },
      {
        key: 'hindi',
        description: 'The caller wants Hindi',
        destination: { kind: 'agent', agent: { agentId: 'sales-hi', release: { kind: 'latest' } } },
      },
      { key: 'senior', description: 'A senior colleague', destination: { kind: 'same-pool' } },
    ],
    hold: {
      steps: [
        { kind: 'clip', assetId: CLIP },
        { kind: 'silence', seconds: 3 },
      ],
      onTimeout: [{ kind: 'default' }, { kind: 'end', line: BYE }],
    },
  };
}

/** The worked example's releases with one transfer-enabled member and a billing agent. */
function releases(): ReleaseRecord[] {
  return [
    ...exampleReleases().filter((item) => item.id !== DEFAULT_RELEASE),
    release(DEFAULT_RELEASE, 'sales-en', {
      config: { handoff: { agents: { llmTool: true, nodes: {} } } },
    }),
    release(BILLING_RELEASE, 'billing'),
  ];
}

/** The harness setup with the catalogue: three pools, the clip live, transfers on. */
function transferSetup(
  edit: (transfer: Record<string, any>, draft: Record<string, any>) => void = () => {},
  setup: Setup = {},
): Setup {
  return {
    releases: releases(),
    clips: { [CLIP]: 'live' },
    pools: {
      [POOL_SALES]: [
        ['sales-en', ['en']],
        ['sales-hi', ['hi']],
      ],
      [POOL_SUPPORT]: [['support', ['en']]],
      [POOL_BILLING]: [['billing', ['en', 'hi']]],
    },
    ...setup,
    patch: (draft) => {
      draft.transfer = catalogue();
      edit(draft.transfer, draft);
    },
  };
}

const at = (found: Awaited<ReturnType<typeof issues>>) =>
  found.map((issue) => [issue.code, issue.severity, issue.path]);

describe('publish validation (Wave 16): the transfer catalogue, one test per code', () => {
  it('passes a valid catalogue with no issue', async () => {
    expect(await issues(transferSetup())).toEqual([]);
  });

  it('routing_transfer_agent_missing: a listed agent without a release', async () => {
    const found = await issues(
      transferSetup((transfer) => (transfer.targets[1].destination.agent.agentId = 'ghost')),
    );
    expect(at(found)).toEqual([
      [
        'routing_transfer_agent_missing',
        'error',
        ['transfer', 'targets', 1, 'destination', 'agent'],
      ],
    ]);
  });

  it('routing_transfer_pool_missing: a destination pool the service does not hold', async () => {
    const found = await issues(
      transferSetup((transfer) => (transfer.targets[0].destination.poolId = OTHER)),
    );
    expect(at(found)).toEqual([
      [
        'routing_transfer_pool_missing',
        'error',
        ['transfer', 'targets', 0, 'destination', 'poolId'],
      ],
    ]);
  });

  it('routing_transfer_pool_deleted: a destination pool deleted since the draft was saved', async () => {
    const found = await issues(transferSetup(undefined, { deletedPools: [POOL_BILLING] }));
    expect(at(found)).toEqual([
      [
        'routing_transfer_pool_deleted',
        'error',
        ['transfer', 'targets', 0, 'destination', 'poolId'],
      ],
    ]);
  });

  it('routing_transfer_audio_missing: a hold clip that does not exist', async () => {
    const found = await issues(transferSetup(undefined, { clips: {} }));
    expect(at(found)).toEqual([
      ['routing_transfer_audio_missing', 'error', ['transfer', 'hold', 'steps', 0, 'assetId']],
    ]);
  });

  it('routing_transfer_audio_deleted: a hold clip deleted since the draft was saved', async () => {
    const found = await issues(
      transferSetup(
        (transfer) =>
          (transfer.targets[0].hold = {
            steps: [{ kind: 'clip', assetId: CLIP }],
            onTimeout: [{ kind: 'end', line: BYE }],
          }),
        { clips: { [CLIP]: 'deleted' } },
      ),
    );
    expect(at(found)).toEqual([
      ['routing_transfer_audio_deleted', 'error', ['transfer', 'hold', 'steps', 0, 'assetId']],
      [
        'routing_transfer_audio_deleted',
        'error',
        ['transfer', 'targets', 0, 'hold', 'steps', 0, 'assetId'],
      ],
    ]);
  });

  it('routing_transfer_line_builtin_missing: lines a default language without built-ins needs', async () => {
    const tamil = (transfer: Record<string, any>, draft: Record<string, any>) => {
      draft.language = { default: 'ta', allowed: ['ta', 'en'] };
      draft.greeting = { ta: 'வணக்கம்' };
      draft.connecting = { ta: 'இணைக்கிறேன்' };
      draft.nodes[0].ask = { ta: 'எப்படி உதவலாம்?' };
      draft.nodes[0].fallback[2].line = { ta: 'நன்றி' };
      transfer.hold.onTimeout[1].line = { ta: 'நன்றி' };
    };
    const transferCodes = async (edit: typeof tamil) =>
      at(await issues(transferSetup(edit, { languageFallback: ['en'] }))).filter(([code]) =>
        String(code).startsWith('routing_transfer'),
      );
    // Targets without an announcement, and no point announcement.
    expect(await transferCodes(tamil)).toEqual([
      ['routing_transfer_line_builtin_missing', 'error', ['transfer', 'announcement']],
    ]);
    // Authored announcement: nothing else is needed while the point hold ends on an end step.
    const announced = (transfer: Record<string, any>, draft: Record<string, any>) => {
      tamil(transfer, draft);
      transfer.announcement = { ta: 'மாற்றுகிறேன்' };
    };
    expect(await transferCodes(announced)).toEqual([]);
    // No point hold (the default hold speaks built-in lines), a queueing target without a queue
    // line and a chain that may end on the built-in end line.
    expect(
      await transferCodes((transfer, draft) => {
        announced(transfer, draft);
        delete transfer.hold;
        transfer.targets[0].hold = {
          steps: [{ kind: 'silence', seconds: 5 }],
          waitForCapacity: true,
          onTimeout: [{ kind: 'default' }],
        };
      }),
    ).toEqual([
      ['routing_transfer_line_builtin_missing', 'error', ['transfer', 'queueAnnouncement']],
      ['routing_transfer_line_builtin_missing', 'error', ['transfer', 'hold']],
      [
        'routing_transfer_line_builtin_missing',
        'error',
        ['transfer', 'targets', 0, 'hold', 'onTimeout'],
      ],
    ]);
  });

  it('routing_transfer_disabled: a catalogue while OVO_ROUTING_TRANSFER_ENABLED is off', async () => {
    const found = await issues(transferSetup(undefined, { transferEnabled: false }));
    expect(at(found)).toEqual([['routing_transfer_disabled', 'warning', ['transfer']]]);
    // A draft without a catalogue never warns.
    expect(await issues({ transferEnabled: false })).toEqual([]);
  });

  it('routing_transfer_unreachable: no release offers the tool or a transferring flow node', async () => {
    const plain = transferSetup(undefined, {
      releases: [...exampleReleases(), release(BILLING_RELEASE, 'billing')],
    });
    expect(at(await issues(plain))).toEqual([
      ['routing_transfer_unreachable', 'warning', ['transfer', 'targets']],
    ]);
    // A flow node that transfers is enough, and the router's own config never counts.
    const flow = [
      ...exampleReleases().filter((item) => item.id !== SUPPORT_RELEASE),
      release(SUPPORT_RELEASE, 'support', {
        config: { handoff: { agents: { llmTool: false, nodes: { wrong_team: 'billing' } } } },
      }),
      release(BILLING_RELEASE, 'billing'),
    ];
    expect(await issues(transferSetup(undefined, { releases: flow }))).toEqual([]);
    const routerOnly = [
      release(ROUTER_RELEASE, 'front-desk', {
        config: { handoff: { agents: { llmTool: true, nodes: {} } } },
      }),
      ...exampleReleases().slice(1),
      release(BILLING_RELEASE, 'billing'),
    ];
    expect(codes(await issues(transferSetup(undefined, { releases: routerOnly })))).toEqual([
      ['routing_transfer_unreachable', 'warning'],
    ]);
  });

  it('routing_transfer_source_unknown: a pool, member or agent the point cannot reach', async () => {
    const found = await issues(
      transferSetup(
        (transfer) =>
          (transfer.targets[0].from = [
            { kind: 'pool', poolId: POOL_SALES },
            { kind: 'member', poolId: POOL_SUPPORT, memberId: 'support' },
            { kind: 'agent', agentId: 'sales-hi' },
            { kind: 'pool', poolId: OTHER },
            { kind: 'member', poolId: POOL_SALES, memberId: 'nobody' },
            { kind: 'agent', agentId: 'front-desk' },
          ]),
      ),
    );
    expect(at(found)).toEqual(
      [3, 4, 5].map((index) => [
        'routing_transfer_source_unknown',
        'warning',
        ['transfer', 'targets', 0, 'from', index],
      ]),
    );
  });

  it('prices every transfer release under the router policy (meter coverage)', async () => {
    const priced = releases().map((item) =>
      item.id === ROUTER_RELEASE
        ? release(ROUTER_RELEASE, 'front-desk', {
            config: { costPolicy: costPolicy(['stt-a.seconds', 'llm-a.seconds']) },
          })
        : item.id === BILLING_RELEASE
          ? release(BILLING_RELEASE, 'billing', {
              selections: { stt: { pluginId: 'stt-b', version: '1.0.0', config: {} } },
            })
          : item,
    );
    const found = await issues(transferSetup(undefined, { releases: priced }));
    expect(at(found)).toEqual([
      ['routing_member_meter_uncovered', 'error', ['pools', POOL_BILLING, 'members', 0, 'agent']],
    ]);
  });
});

describe('the release snapshot with a transfer catalogue (Wave 16)', () => {
  it('pins agents, pools and clip digests and freezes schema version 2', async () => {
    const { context: built, draft } = await context(transferSetup());
    const { issues: found, resolution } = await validateRoutingDraft(built, draft);
    expect(found).toEqual([]);
    const { snapshot } = buildRoutingSnapshot(OTHER, draft, resolution);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.transfer!.targets[1]!.destination).toEqual({
      kind: 'agent',
      agent: { agentId: 'sales-hi', release: { kind: 'pinned', releaseId: SALES_HI_RELEASE } },
    });
    const sha256 = createHash('sha256').update(clipInput('x').audio).digest('hex');
    expect(snapshot.transfer!.hold!.steps[0]).toEqual({ kind: 'clip', assetId: CLIP, sha256 });
    expect(Object.keys(snapshot.pools).sort()).toEqual(
      [POOL_SALES, POOL_SUPPORT, POOL_BILLING].sort(),
    );
    expect(snapshot.pools[POOL_BILLING]!.members[0]!.agent.release).toEqual({
      kind: 'pinned',
      releaseId: BILLING_RELEASE,
    });
    expect(snapshot.releaseIds).toContain(BILLING_RELEASE);
    expect(snapshot.releaseIds).toContain(SALES_HI_RELEASE);
    // The snapshot is valid on its own, and the draft keeps its unpinned references.
    expect(RoutingReleaseSnapshot.parse(snapshot)).toEqual(snapshot);
    expect(draft.transfer!.targets[1]!.destination).toMatchObject({
      agent: { release: { kind: 'latest' } },
    });
    expect(draft.transfer!.hold!.steps[0]).not.toHaveProperty('sha256');
  });

  it('keeps schema version 1 without a catalogue', async () => {
    const { context: built, draft } = await context();
    const { resolution } = await validateRoutingDraft(built, draft);
    const { snapshot } = buildRoutingSnapshot(OTHER, draft, resolution);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot).not.toHaveProperty('transfer');
  });
});
