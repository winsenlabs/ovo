import type { NativeToolHandler, ToolConnector } from '@winsendotai/ovo-contracts';
import { definePlugin, type Context, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { ExecutionPolicyError } from './errors.ts';
import { serviceKeys } from './services.ts';

/** Moved to contracts (`ports.ts`); re-exported so existing imports keep working. */
export type { NativeToolContext, NativeToolHandler } from '@winsendotai/ovo-contracts';

export function createNativeConnector(
  handlers: Readonly<Record<string, NativeToolHandler>>,
): ToolConnector {
  const registered = new Map(Object.entries(handlers));
  return {
    invoke(tool, input, options) {
      if (tool.connector !== 'native')
        throw new ExecutionPolicyError(`Native connector cannot invoke ${tool.connector} tool`);
      const handler = registered.get(tool.id);
      if (!handler) throw new ExecutionPolicyError(`No approved native handler for ${tool.id}`);
      return handler(input, options);
    },
  };
}

export function createNativeToolsPlugin(
  handlers: Readonly<Record<string, NativeToolHandler>>,
): PluginDefinition {
  const connector = createNativeConnector(handlers);
  return definePlugin(
    {
      id: '@winsendotai/ovo-plugin-tools/native',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: [serviceKeys.connector.native],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx: Context) => {
      ctx.provide(serviceKeys.connector.native, connector);
    },
  );
}
