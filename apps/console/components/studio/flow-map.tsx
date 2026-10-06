'use client';
import { ResponsiveTable } from '../primitives';
import { describeRoute, type Flow } from './flow-shapes';

/**
 * The conversation map, read-only: what each state says, what it listens for, and where every
 * intent leads. Structure is edited through the flow JSON, which is also how a POC conversation
 * map is imported; the wording of each line is edited inline in the lines table.
 */
export function FlowMap({ flow }: { flow: Flow }) {
  return (
    <>
      <ResponsiveTable label="Flow states">
        <caption>States</caption>
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col">Says</th>
            <th scope="col">Listens for</th>
            <th scope="col">Records</th>
          </tr>
        </thead>
        <tbody>
          {flow.nodes.map((node) => (
            <tr key={node.id}>
              <th scope="row">
                {node.id}
                {node.id === flow.start && <small> (start)</small>}
              </th>
              <td>{node.say.length ? node.say.join(', ') : 'The LLM composes the reply'}</td>
              <td>{node.end ? 'Ends the call' : node.listen}</td>
              <td>
                {[node.disposition, node.verified && 'identity confirmed']
                  .filter(Boolean)
                  .join('; ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </ResponsiveTable>
      <ResponsiveTable label="Flow listen sets">
        <caption>Listen sets (plus the global intents and an automatic other)</caption>
        <thead>
          <tr>
            <th scope="col">Listen set</th>
            <th scope="col">Intent</th>
            <th scope="col">Leads</th>
          </tr>
        </thead>
        <tbody>
          {[
            ...flow.listens.map((listen) => ({ id: listen.id, intents: listen.intents })),
            {
              id: '(global)',
              intents: flow.globalIntents,
            },
          ].flatMap((listen) =>
            listen.intents.map((intent, index) => (
              <tr key={`${listen.id}:${intent.key}`}>
                {index === 0 ? (
                  <th scope="rowgroup" rowSpan={listen.intents.length}>
                    {listen.id}
                  </th>
                ) : null}
                <td>
                  {intent.key}
                  {intent.phrases.length > 0 && (
                    <small> (instant: {intent.phrases.join(', ')})</small>
                  )}
                </td>
                <td>{describeRoute(intent)}</td>
              </tr>
            )),
          )}
        </tbody>
      </ResponsiveTable>
    </>
  );
}
