import type { SecretResolver, ToolConnector } from '@winsendotai/ovo-contracts';
import {
  ExecutionPolicyError,
  ToolInvocationError,
  serviceKeys,
} from '@winsendotai/ovo-plugin-tools';
import { definePlugin, type Context, type PluginDefinition } from '@winsendotai/ovo-runtime';
import {
  createPinnedFetch,
  parseApprovedEndpoint,
  type SecureNetworkDependencies,
} from './network.ts';

export interface HttpToolBinding {
  toolId: string;
  workspaceId: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: 'input' | 'none';
  auth?:
    | { type: 'bearer'; credentialId: string }
    | { type: 'header'; credentialId: string; header: string };
  idempotencyHeader?: string;
  response?: { type: 'json' | 'text'; pointer?: string };
}

export interface HttpConnectorDependencies extends SecureNetworkDependencies {
  secrets?: SecretResolver;
}

const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'cookie',
  'connection',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
]);

function assertHeaderName(name: string): void {
  const normalized = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(normalized) || normalized.startsWith('sec-')) {
    throw new ExecutionPolicyError(`HTTP header is controlled by the connector: ${name}`);
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
    throw new ExecutionPolicyError(`Invalid HTTP header: ${name}`);
}

function readPointer(input: unknown, pointer: string): unknown {
  if (pointer === '') return input;
  if (!pointer.startsWith('/')) throw new ExecutionPolicyError(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .reduce<unknown>((value, raw) => {
      if (value === null || typeof value !== 'object') return undefined;
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
      return (value as Record<string, unknown>)[key];
    }, input);
}

function compileBindings(bindings: readonly HttpToolBinding[]): Map<string, HttpToolBinding> {
  const approved = new Map<string, HttpToolBinding>();
  for (const binding of bindings) {
    if (approved.has(binding.toolId))
      throw new ExecutionPolicyError(`Duplicate HTTP binding: ${binding.toolId}`);
    parseApprovedEndpoint(binding.endpoint);
    for (const name of Object.keys(binding.headers ?? {})) assertHeaderName(name);
    if (binding.auth?.type === 'header') assertHeaderName(binding.auth.header);
    if (binding.idempotencyHeader) assertHeaderName(binding.idempotencyHeader);
    approved.set(binding.toolId, structuredClone(binding));
  }
  return approved;
}

export function createHttpConnector(
  bindings: readonly HttpToolBinding[],
  dependencies: HttpConnectorDependencies = {},
): ToolConnector {
  const approved = compileBindings(bindings);
  return {
    async invoke(tool, input, options) {
      if (tool.connector !== 'http')
        throw new ExecutionPolicyError(`HTTP connector cannot invoke ${tool.connector} tool`);
      const binding = approved.get(tool.id);
      if (!binding)
        throw new ExecutionPolicyError(`No operator-approved HTTP binding for ${tool.id}`);
      if (binding.workspaceId !== options.workspaceId)
        throw new ExecutionPolicyError('HTTP tool binding belongs to another workspace');

      const url = new URL(binding.endpoint);
      for (const [name, pointer] of Object.entries(binding.query ?? {})) {
        const value = readPointer(input, pointer);
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          throw new ToolInvocationError(
            `Query value ${name} must be a string, number, or boolean`,
            'not-applied',
          );
        }
        url.searchParams.set(name, String(value));
      }
      const headers = new Headers(binding.headers);
      headers.set('accept', binding.response?.type === 'text' ? 'text/plain' : 'application/json');
      const bodyMode = binding.body ?? (binding.method === 'GET' ? 'none' : 'input');
      if (bodyMode === 'input') headers.set('content-type', 'application/json');
      if (binding.auth) {
        if (!dependencies.secrets)
          throw new ExecutionPolicyError(
            'HTTP authentication requires a server-side secret resolver',
          );
        let secret: string;
        try {
          secret = await dependencies.secrets.resolve(
            options.workspaceId,
            binding.auth.credentialId,
          );
        } catch {
          throw new ToolInvocationError('HTTP credential resolution failed', 'not-applied');
        }
        if (binding.auth.type === 'bearer') headers.set('authorization', `Bearer ${secret}`);
        else headers.set(binding.auth.header, secret);
      }
      if (binding.idempotencyHeader) headers.set(binding.idempotencyHeader, options.operationId);

      const policy = await createPinnedFetch(binding.endpoint, dependencies);
      try {
        let response: Response;
        try {
          response = await policy.fetch(url, {
            method: binding.method,
            headers,
            body: bodyMode === 'input' ? JSON.stringify(input) : undefined,
            signal: options.signal,
          });
        } catch (error) {
          if (error instanceof ToolInvocationError || error instanceof ExecutionPolicyError)
            throw error;
          throw new ToolInvocationError(
            'HTTP tool request did not produce a definite response',
            'unknown',
            { cause: error },
          );
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ToolInvocationError(
            `HTTP tool returned status ${response.status}`,
            response.status >= 500 ? 'unknown' : 'not-applied',
          );
        }
        const result: unknown =
          binding.response?.type === 'text' ? await response.text() : await response.json();
        return binding.response?.pointer ? readPointer(result, binding.response.pointer) : result;
      } finally {
        await policy.dispose();
      }
    },
  };
}

export function createHttpToolsPlugin(
  bindings: readonly HttpToolBinding[],
  dependencies: SecureNetworkDependencies = {},
): PluginDefinition {
  const needsSecrets = bindings.some((binding) => binding.auth);
  return definePlugin(
    {
      id: '@winsendotai/ovo-plugin-tools-http',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: needsSecrets ? [serviceKeys.secretResolver] : [],
      provides: [serviceKeys.connector.http],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: ['bindings.*.auth.credentialId'],
    },
    (ctx: Context) => {
      const secrets = needsSecrets
        ? (ctx.get(serviceKeys.secretResolver) as SecretResolver)
        : undefined;
      ctx.provide(
        serviceKeys.connector.http,
        createHttpConnector(bindings, { ...dependencies, secrets }),
      );
    },
  );
}
