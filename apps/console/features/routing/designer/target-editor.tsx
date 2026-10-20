'use client';
import type { RoutingTarget } from '@winsendotai/ovo-contracts';
import { AgentRefEditor } from '../../../components/routing/agent-ref';
import { LinesEditor } from '../../../components/routing/lines-editor';
import {
  NumberField,
  optionsFrom,
  SelectField,
  TagsField,
  TextField,
} from '../../../components/routing/fields';
import { blankTarget } from '../../../lib/derive/routing-defaults';
import { TARGET_LABEL } from '../../../lib/derive/routing-labels';
import { useDesigner } from './designer-context';

type Kind = RoutingTarget['kind'];
const PRODUCT_MODES = optionsFrom({
  any: 'Any product',
  values: 'These products',
  context: 'From the route context',
});

export function PoolFields({
  target,
  onChange,
  id,
}: {
  target: Extract<RoutingTarget, { kind: 'pool' }>;
  onChange: (t: RoutingTarget) => void;
  id: string;
}) {
  const { pools } = useDesigner();
  const options = pools.map((p) => ({ value: p.id, label: p.definition.name }));
  if (target.poolId && !options.some((o) => o.value === target.poolId))
    options.unshift({ value: target.poolId, label: target.poolId });
  const mode = !target.products ? 'any' : 'values' in target.products ? 'values' : 'context';
  return (
    <>
      <SelectField
        id={`${id}-pool`}
        label="Pool"
        value={target.poolId}
        placeholder={options.length ? 'Choose a pool…' : 'No pools yet'}
        options={options}
        onChange={(poolId) => onChange({ ...target, poolId })}
      />
      <SelectField
        id={`${id}-language`}
        label="Agent language"
        value={target.language}
        options={[
          { value: 'caller', label: "Must speak the caller's language" },
          { value: 'any', label: 'Any language' },
        ]}
        onChange={(language) => onChange({ ...target, language: language as 'caller' | 'any' })}
      />
      <SelectField
        id={`${id}-products`}
        label="Product"
        value={mode}
        options={PRODUCT_MODES}
        onChange={(next) => {
          const { products: _drop, ...rest } = target;
          onChange(
            next === 'any'
              ? rest
              : {
                  ...rest,
                  products: next === 'values' ? { values: ['product'] } : { context: 'product' },
                },
          );
        }}
      />
      {target.products && 'values' in target.products && (
        <TagsField
          id={`${id}-product-values`}
          label="Products"
          values={target.products.values}
          onChange={(values) => onChange({ ...target, products: { values } })}
        />
      )}
      {target.products && 'context' in target.products && (
        <TextField
          id={`${id}-product-context`}
          label="Route context key"
          value={target.products.context}
          help="The member must list the product this key holds."
          onChange={(context) => onChange({ ...target, products: { context } })}
        />
      )}
      <TagsField
        id={`${id}-skills`}
        label="Skills the member needs"
        values={target.skills}
        onChange={(skills) => onChange({ ...target, skills })}
      />
    </>
  );
}

/** A branch, fallback or transfer target: choose what happens, then its details. */
export function TargetEditor({
  value,
  onChange,
  id,
  kinds = ['pool', 'agent', 'human', 'callback', 'end'],
}: {
  value: RoutingTarget;
  onChange: (target: RoutingTarget) => void;
  id: string;
  kinds?: readonly Kind[];
}) {
  const { draft } = useDesigner();
  const queueKeys = (draft.humanQueues ?? []).map((b) => b.key);
  return (
    <div className="rt-stack">
      <SelectField
        id={`${id}-kind`}
        label="Then"
        value={value.kind}
        options={kinds.map((k) => ({ value: k, label: TARGET_LABEL[k] }))}
        onChange={(kind) => onChange(blankTarget(kind as Kind))}
      />
      {value.kind === 'pool' && <PoolFields id={id} target={value} onChange={onChange} />}
      {value.kind === 'agent' && (
        <AgentRefEditor
          id={id}
          value={value.agent}
          onChange={(agent) => onChange({ ...value, agent })}
        />
      )}
      {value.kind === 'human' && (
        <SelectField
          id={`${id}-queue`}
          label="Person queue"
          value={value.queueId}
          placeholder={queueKeys.length ? 'Choose a queue…' : 'Bind a queue first'}
          options={queueKeys.map((k) => ({ value: k, label: k }))}
          help={queueKeys.length ? undefined : 'Queues are bound on the Human queues tab.'}
          onChange={(queueId) => onChange({ ...value, queueId })}
        />
      )}
      {value.kind === 'callback' && (
        <>
          <NumberField
            id={`${id}-minutes`}
            label="Call back in"
            unit="minutes"
            min={5}
            max={10080}
            value={value.inMinutes}
            onChange={(inMinutes) => onChange({ ...value, inMinutes })}
          />
          <LinesEditor
            label="Promise to the caller"
            required
            value={value.line}
            onChange={(line) => line && onChange({ ...value, line })}
          />
        </>
      )}
      {value.kind === 'end' && (
        <>
          <LinesEditor
            label="Goodbye line"
            required
            value={value.line}
            onChange={(line) => line && onChange({ ...value, line })}
          />
          <TextField
            id={`${id}-disposition`}
            label="Outcome label"
            value={value.disposition ?? ''}
            help="Optional, recorded on the call (lowercase)."
            onChange={(disposition) =>
              onChange({ ...value, disposition: disposition || undefined })
            }
          />
        </>
      )}
    </div>
  );
}
