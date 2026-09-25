'use client';
import type { AgentConfig } from '../../lib/api';
import { EmptyState, Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { JsonEditor } from '../forms/json-editor';
import { useRowKeys } from '../forms/use-row-keys';

type Tool = AgentConfig['tools'][number];
const emptyTool = (): Tool => ({
  id: crypto.randomUUID(),
  description: '',
  connector: 'http',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  effect: 'read',
  confirmation: false,
  timeoutMs: 10000,
  http: { endpoint: 'https://', method: 'POST', responseType: 'json' },
});

export function ToolsEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const rowKeys = useRowKeys(config.tools.length);
  const setTools = (tools: Tool[]) =>
    update({
      ...config,
      tools,
      allowedTools: config.allowedTools.filter((id) => tools.some((tool) => tool.id === id)),
    });
  const patch = (index: number, value: Partial<Tool>) =>
    setTools(
      config.tools.map((tool, current) => (current === index ? { ...tool, ...value } : tool)),
    );
  return (
    <Panel labelledBy="tools-config-title">
      <PanelHeader
        id="tools-config-title"
        title="Tool definitions"
        badge={
          <StatusBadge tone={config.tools.length ? 'soft' : 'warning'}>
            {config.tools.length} configured
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <Notice tone="warning">
          HTTP endpoints and credential references are validated and invoked server-side. This
          editor never sends a credential value to a tool.
        </Notice>
        {!config.tools.length && (
          <EmptyState title="No tools configured">
            Add an HTTP or approved MCP tool. Discovery alone does not enable it.
          </EmptyState>
        )}
        {config.tools.map((tool, index) => (
          <fieldset className="nested-card" key={rowKeys.keyAt(index)}>
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
                  onChange={(event) =>
                    patch(index, { effect: event.target.value as Tool['effect'] })
                  }
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
                <small>
                  Write actions should require confirmation and an idempotency strategy.
                </small>
              </span>
            </label>
            {tool.connector === 'http' && tool.http && (
              <div className="nested-subsection">
                <h3>HTTP policy</h3>
                <div className="form-grid">
                  <Field label="HTTPS endpoint" htmlFor={`http-endpoint-${index}`}>
                    <input
                      id={`http-endpoint-${index}`}
                      type="url"
                      value={tool.http.endpoint}
                      onChange={(event) =>
                        patch(index, { http: { ...tool.http!, endpoint: event.target.value } })
                      }
                    />
                  </Field>
                  <Field label="Method" htmlFor={`http-method-${index}`}>
                    <select
                      id={`http-method-${index}`}
                      value={tool.http.method}
                      onChange={(event) =>
                        patch(index, {
                          http: {
                            ...tool.http!,
                            method: event.target.value as NonNullable<Tool['http']>['method'],
                          },
                        })
                      }
                    >
                      {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                        <option key={method}>{method}</option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="Credential reference (optional)"
                    htmlFor={`http-credential-${index}`}
                  >
                    <input
                      id={`http-credential-${index}`}
                      value={tool.http.credentialId ?? ''}
                      onChange={(event) =>
                        patch(index, {
                          http: { ...tool.http!, credentialId: event.target.value || undefined },
                        })
                      }
                    />
                  </Field>
                  <Field label="Idempotency header" htmlFor={`http-idempotency-${index}`}>
                    <input
                      id={`http-idempotency-${index}`}
                      value={tool.http.idempotencyHeader ?? ''}
                      onChange={(event) =>
                        patch(index, {
                          http: {
                            ...tool.http!,
                            idempotencyHeader: event.target.value || undefined,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="Response type" htmlFor={`http-response-${index}`}>
                    <select
                      id={`http-response-${index}`}
                      value={tool.http.responseType}
                      onChange={(event) =>
                        patch(index, {
                          http: {
                            ...tool.http!,
                            responseType: event.target.value as 'json' | 'text',
                          },
                        })
                      }
                    >
                      <option value="json">JSON</option>
                      <option value="text">Text</option>
                    </select>
                  </Field>
                  <Field label="Response JSON pointer" htmlFor={`http-pointer-${index}`}>
                    <input
                      id={`http-pointer-${index}`}
                      value={tool.http.responsePointer ?? ''}
                      onChange={(event) =>
                        patch(index, {
                          http: { ...tool.http!, responsePointer: event.target.value || undefined },
                        })
                      }
                    />
                  </Field>
                </div>
              </div>
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
                  onValid={(inputSchema) => patch(index, { inputSchema: inputSchema as Record<string, unknown> })}
                />
              </Field>
              <Field label="Output JSON Schema (optional)" htmlFor={`tool-output-${index}`}>
                <JsonEditor
                  id={`tool-output-${index}`}
                  value={tool.outputSchema ?? {}}
                  onValid={(outputSchema) => patch(index, { outputSchema: outputSchema as Record<string, unknown> })}
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
                <small>
                  Release validation also requires an exact MCP approval when applicable.
                </small>
              </span>
            </label>
            <button
              className="text-button danger-text"
              type="button"
              onClick={() => { rowKeys.remove(index); setTools(config.tools.filter((_, current) => current !== index)); }}
            >
              Remove tool
            </button>
          </fieldset>
        ))}
        <button
          className="button align-start"
          type="button"
          onClick={() => { rowKeys.insert(config.tools.length); setTools([...config.tools, emptyTool()]); }}
        >
          Add tool
        </button>
      </div>
    </Panel>
  );
}
