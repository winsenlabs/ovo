'use client';
import type { AgentConfig } from '../../lib/api';
import { Field } from '../primitives';
type Tool = AgentConfig['tools'][number];
export function HttpToolFields({
  tool,
  index,
  patch,
}: {
  tool: Tool & { http: NonNullable<Tool['http']> };
  index: number;
  patch: (index: number, value: Partial<Tool>) => void;
}) {
  return (
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
        <Field label="Credential reference (optional)" htmlFor={`http-credential-${index}`}>
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
  );
}
