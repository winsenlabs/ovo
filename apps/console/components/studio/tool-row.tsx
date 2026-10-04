'use client';
import type { AgentConfig } from '../../lib/api';
import { Field } from '../primitives';
import { JsonEditor } from '../forms/json-editor';
import { HttpToolFields } from './http-tool-fields';
type Tool = AgentConfig['tools'][number];
export function ToolRow({
  tool,
  index,
  config,
  update,
  patch,
  onRemove,
  emptyTool,
}: {
  tool: Tool;
  index: number;
  config: AgentConfig;
  update: (next: AgentConfig) => void;
  patch: (index: number, value: Partial<Tool>) => void;
  onRemove: () => void;
  emptyTool: () => Tool;
}) {
  return (
    <fieldset className="nested-card">
      <legend>Tool {index + 1}</legend>
      <div className="form-grid">
        <Field label="Tool ID" htmlFor={`tool-id-${index}`}>
          <input
            id={`tool-id-${index}`}
            value={tool.id}
            onChange={(event) => patch(index, { id: event.target.value })}
          />
        </Field>
        <Field label="Connector" htmlFor={`tool-connector-${index}`}>
          <select
            id={`tool-connector-${index}`}
            value={tool.connector}
            onChange={(event) =>
              patch(index, {
                connector: event.target.value as Tool['connector'],
                ...(event.target.value === 'http'
                  ? { http: tool.http ?? emptyTool().http }
                  : { http: undefined }),
              })
            }
          >
            <option value="native">Native</option>
            <option value="http">HTTP</option>
            <option value="mcp">MCP</option>
          </select>
        </Field>
      </div>
      <Field label="Description exposed to the agent" htmlFor={`tool-description-${index}`}>
        <textarea
          id={`tool-description-${index}`}
          value={tool.description}
          onChange={(event) => patch(index, { description: event.target.value })}
        />
      </Field>
      <div className="form-grid">
        <Field label="Effect" htmlFor={`tool-effect-${index}`}>
          <select
            id={`tool-effect-${index}`}
            value={tool.effect}
            onChange={(event) => patch(index, { effect: event.target.value as Tool['effect'] })}
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </select>
        </Field>
        <Field label="Timeout (ms)" htmlFor={`tool-timeout-${index}`}>
          <input
            id={`tool-timeout-${index}`}
            type="number"
            min={1}
            max={120000}
            value={tool.timeoutMs}
            onChange={(event) => patch(index, { timeoutMs: Number(event.target.value) })}
          />
        </Field>
      </div>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={tool.confirmation}
          disabled={tool.effect === 'read'}
          onChange={(event) => patch(index, { confirmation: event.target.checked })}
        />
        <span>
          <strong>Require caller confirmation</strong>
          <small>Write actions should require confirmation and an idempotency strategy.</small>
        </span>
      </label>
      {tool.connector === 'http' && tool.http && (
        <HttpToolFields
          tool={tool as Tool & { http: NonNullable<Tool['http']> }}
          index={index}
          patch={patch}
        />
      )}
      {tool.connector === 'mcp' && (
        <div className="form-grid">
          <Field label="MCP connection ID" htmlFor={`mcp-connection-${index}`}>
            <input
              id={`mcp-connection-${index}`}
              value={tool.connectionId ?? ''}
              onChange={(event) => patch(index, { connectionId: event.target.value })}
            />
          </Field>
          <Field label="Remote tool name" htmlFor={`mcp-name-${index}`}>
            <input
              id={`mcp-name-${index}`}
              value={tool.remoteName ?? ''}
              onChange={(event) => patch(index, { remoteName: event.target.value })}
            />
          </Field>
          <Field label="Approved schema digest" htmlFor={`mcp-digest-${index}`}>
            <input
              id={`mcp-digest-${index}`}
              value={tool.schemaDigest ?? ''}
              onChange={(event) => patch(index, { schemaDigest: event.target.value })}
            />
          </Field>
        </div>
      )}
      <div className="form-grid">
        <Field label="Input JSON Schema" htmlFor={`tool-input-${index}`}>
          <JsonEditor
            id={`tool-input-${index}`}
            value={tool.inputSchema}
            onValid={(inputSchema) =>
              patch(index, { inputSchema: inputSchema as Record<string, unknown> })
            }
          />
        </Field>
        <Field label="Output JSON Schema (optional)" htmlFor={`tool-output-${index}`}>
          <JsonEditor
            id={`tool-output-${index}`}
            value={tool.outputSchema ?? {}}
            onValid={(outputSchema) =>
              patch(index, { outputSchema: outputSchema as Record<string, unknown> })
            }
          />
        </Field>
      </div>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={config.allowedTools.includes(tool.id)}
          onChange={(event) =>
            update({
              ...config,
              allowedTools: event.target.checked
                ? [...new Set([...config.allowedTools, tool.id])]
                : config.allowedTools.filter((id) => id !== tool.id),
            })
          }
        />
        <span>
          <strong>Allow in this agent</strong>
          <small>Release validation also requires an exact MCP approval when applicable.</small>
        </span>
      </label>
      <button
        className="text-button danger-text"
        type="button"
        onClick={() => {
          onRemove();
        }}
      >
        Remove tool
      </button>
    </fieldset>
  );
}
