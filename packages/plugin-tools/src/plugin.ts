import type { OperationStore, Speech, ToolConnector } from '@winsendotai/ovo-contracts';
import { definePlugin, type Context, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { createExecutionService } from './execution.ts';
import type { ExecutionPluginConfig } from './execution-types.ts';
import { serviceKeys, type ConnectorKind } from './services.ts';

export function createExecutionPlugin(config: ExecutionPluginConfig): PluginDefinition {
  const allowed = new Set(config.allowedTools);
  const connectorKinds = [
    ...new Set(config.tools.filter((tool) => allowed.has(tool.id)).map((tool) => tool.connector)),
  ];
  const requires = [
    serviceKeys.operationStore,
    serviceKeys.speech,
    ...connectorKinds.map((kind) => serviceKeys.connector[kind]),
  ];
  return definePlugin(
    {
      id: '@winsendotai/ovo-plugin-tools',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires,
      provides: [serviceKeys.execution],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx: Context) => {
      const store = ctx.get(serviceKeys.operationStore) as OperationStore;
      const speech = ctx.get(serviceKeys.speech) as Speech;
      const connectors = Object.fromEntries(
        connectorKinds.map((kind) => [kind, ctx.get(serviceKeys.connector[kind])]),
      ) as Partial<Record<ConnectorKind, ToolConnector>>;
      ctx.provide(
        serviceKeys.execution,
        createExecutionService(config, { store, speech, connectors }),
      );
    },
  );
}
