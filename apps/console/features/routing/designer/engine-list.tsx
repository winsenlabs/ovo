'use client';
import { ROUTING_LIMITS, type RoutingEngine, type RoutingNode } from '@winsendotai/ovo-contracts';
import { optionsFrom } from '../../../components/routing/fields';
import { IssueList } from '../../../components/routing/issue-list';
import { Select } from '../../../components/ui/inputs';
import { issuesAt } from '../../../lib/derive/routing-issue-index';
import { blankEngine } from '../../../lib/derive/routing-defaults';
import { moveItem, removeItem } from '../../../lib/derive/list-edit';
import { ENGINE_LABEL, engineSummary } from '../../../lib/derive/routing-labels';
import { useDesigner } from './designer-context';
import { ExternalEditor } from './engine-external';
import { ModelEngineEditor } from './engine-model';
import { RulesEditor } from './engine-rules';

const KINDS = optionsFrom(ENGINE_LABEL);

function Body({
  engine,
  node,
  onChange,
  id,
}: {
  engine: RoutingEngine;
  node: RoutingNode;
  onChange: (e: RoutingEngine) => void;
  id: string;
}) {
  switch (engine.kind) {
    case 'rules':
      return (
        <RulesEditor
          id={id}
          engine={engine}
          branchKeys={node.branches.map((b) => b.key)}
          onChange={onChange}
        />
      );
    case 'external':
      return <ExternalEditor id={id} engine={engine} onChange={onChange} />;
    default:
      return <ModelEngineEditor id={id} engine={engine} onChange={onChange as never} />;
  }
}

/** The ordered engines of a question: tried top to bottom, the first match at its threshold wins. */
export function EngineList({
  node,
  onChange,
}: {
  node: RoutingNode;
  onChange: (node: RoutingNode) => void;
}) {
  const { index } = useDesigner();
  const set = (engines: RoutingEngine[]) => onChange({ ...node, engines });
  return (
    <div className="rt-stack">
      <p className="muted">
        Engines run in order and the first to answer at or above its confidence wins. Put cheap,
        certain rules first and models after them.
      </p>
      <IssueList
        issues={issuesAt(index, node.id, 'engine').filter(
          (a) => a.anchor.engineIndex === undefined,
        )}
      />
      <ol className="queue-rows" aria-label="Engines">
        {node.engines.map((engine, e) => (
          <li key={e} className="rt-card">
            <div className="rt-card-head">
              <strong>
                {e + 1}. {ENGINE_LABEL[engine.kind]}{' '}
                <span className="muted">({engineSummary(engine)})</span>
              </strong>
              <span className="rt-row-actions">
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Move engine ${e + 1} up`}
                  disabled={e === 0}
                  onClick={() => set(moveItem(node.engines, e, -1))}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Move engine ${e + 1} down`}
                  disabled={e === node.engines.length - 1}
                  onClick={() => set(moveItem(node.engines, e, 1))}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove engine ${e + 1}`}
                  disabled={node.engines.length <= 1}
                  onClick={() => set(removeItem(node.engines, e, 1))}
                >
                  Remove
                </button>
              </span>
            </div>
            <IssueList issues={issuesAt(index, node.id, 'engine', { engineIndex: e })} />
            <Body
              id={`${node.id}-e${e}`}
              engine={engine}
              node={node}
              onChange={(next) => set(node.engines.map((x, i) => (i === e ? next : x)))}
            />
          </li>
        ))}
      </ol>
      {node.engines.length < ROUTING_LIMITS.enginesPerNode ? (
        <div className="button-row">
          <Select
            aria-label="Engine to add"
            value=""
            placeholder="Add an engine…"
            options={KINDS}
            onChange={(kind) =>
              kind &&
              set([
                ...node.engines,
                blankEngine(kind as RoutingEngine['kind'], node.branches[0]?.key),
              ])
            }
          />
        </div>
      ) : (
        <p className="muted">At most {ROUTING_LIMITS.enginesPerNode} engines per question.</p>
      )}
    </div>
  );
}
