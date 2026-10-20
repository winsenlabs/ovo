'use client';
import { useState } from 'react';
import { ChangeList } from '../../../components/routing/change-list';
import { HoldTimeline } from '../../../components/routing/hold-timeline';
import { IssueList } from '../../../components/routing/issue-list';
import { KeyInput } from '../../../components/routing/key-input';
import { PoolConsiderationCard } from '../../../components/routing/pool-consideration';
import { SectionCard } from '../../../components/ui/section-card';
import { TREE_KEYS } from '../../../features/routing/designer/tree-tab';

const HOLD = {
  steps: [
    { kind: 'clip' as const, assetId: 'demo' },
    { kind: 'silence' as const, seconds: 3 },
    { kind: 'line' as const, line: { en: 'Thank you for holding.' } },
  ],
  loopFrom: 1,
  maxSeconds: 60,
  waitForCapacity: false,
  onTimeout: [{ kind: 'default' as const }],
};

/** Routing primitives (Wave 18): the pieces the designer, pool editor and simulator share. */
export function RoutingSection() {
  const [key, setKey] = useState('sales');
  return (
    <SectionCard
      title="Routing"
      description="Issue lists, diffs, hold timelines, pool explanations and the tree's keyboard model."
    >
      <div className="rt-stack">
        <h3>Issue list</h3>
        <IssueList
          issues={[
            {
              code: 'routing_fallback_not_terminal',
              severity: 'error',
              path: [],
              message: 'The fallback chain ends in default, callback or end',
            },
            {
              code: 'routing_node_unreachable',
              severity: 'warning',
              path: [],
              message: 'Node billing cannot be reached from the root',
            },
          ]}
        />
        <h3>Key input (renames on blur or Enter)</h3>
        <KeyInput
          id="ds-key"
          label="Branch key"
          value={key}
          onCommit={(next) =>
            next === 'taken' ? 'Branch taken already exists here.' : void setKey(next)
          }
          help="Try “taken”."
        />
        <h3>Hold timeline</h3>
        <HoldTimeline policy={HOLD} clipSeconds={() => 20} />
        <h3>Change list</h3>
        <ChangeList
          changes={[
            {
              area: 'node',
              op: 'changed',
              key: 'node intent',
              path: [],
              summary: 'The question on intent changed',
            },
            {
              area: 'branch',
              op: 'added',
              key: 'branch intent > person',
              path: [],
              summary: 'Added branch intent > person',
            },
            {
              area: 'queue',
              op: 'removed',
              key: 'queue binding old',
              path: [],
              summary: 'Removed queue binding old',
            },
          ]}
        />
        <h3>Pool consideration</h3>
        <PoolConsiderationCard
          pool={{
            poolId: 'demo',
            poolName: 'Sales',
            turn: 1,
            node: 'intent',
            wanted: { language: 'hi', languageMode: 'caller', products: ['cards'], skills: [] },
            languageUsed: 'hi',
            result: 'picked',
            members: [
              {
                memberId: 'sales-hi',
                agentId: 'a',
                releaseId: 'r',
                priority: 60,
                enabled: true,
                open: true,
                productOk: true,
                skillsOk: true,
                languageOk: true,
                eligible: true,
                tier: 0,
                active: 3,
                capacity: 20,
                full: false,
                picked: true,
                reasons: [],
              },
              {
                memberId: 'sales-ta',
                agentId: 'b',
                releaseId: 'r',
                priority: 50,
                enabled: false,
                open: true,
                productOk: true,
                skillsOk: true,
                languageOk: false,
                eligible: false,
                tier: null,
                active: 0,
                capacity: 10,
                full: false,
                picked: false,
                reasons: ['disabled', 'language'],
              },
            ],
          }}
        />
        <h3>Tree keyboard model</h3>
        <dl className="rt-keys">
          {TREE_KEYS.map(([keys, does]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd>{does}</dd>
            </div>
          ))}
        </dl>
      </div>
    </SectionCard>
  );
}
