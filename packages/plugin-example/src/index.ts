import { definePlugin } from '@winsendotai/ovo-sdk';
/** External-package example: no relative import into OVO internals, no special host branch. */
export const reminderBehavior = definePlugin(
  {
    id: 'example.reminder',
    version: '1.0.0',
    contractVersion: 1,
    scope: 'session',
    provides: ['example.reminder'],
    requires: [],
    configSchema: {
      type: 'object',
      properties: { prefix: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['prefix'],
      additionalProperties: false,
    },
    secretFields: [],
    ui: { label: 'External reminder', panel: 'schema-form' },
  },
  (ctx, config) => {
    let disposed = false;
    const prefix = String(config.prefix);
    ctx.provide('example.reminder', {
      respond(name: string) {
        if (disposed) throw new Error('Disposed plugin');
        return `${prefix} ${name}.`;
      },
    });
    ctx.effect(() => () => {
      disposed = true;
    });
  },
);
