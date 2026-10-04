import { z } from 'zod';
import { definePluginV2 } from '@winsendotai/ovo-sdk';
/** External-package example: no relative import into OVO internals, no special host branch. */
export const reminderBehavior = definePluginV2(
  {
    id: 'example.reminder',
    version: '1.0.0',
    scope: 'session',
    kind: 'behavior',
    provides: ['example.reminder'],
    requires: [],
    config: z.object({ prefix: z.string().min(1).max(80) }).strict(),
    secretFields: [],
    ui: { label: 'External reminder', panel: 'schema-form' },
  },
  (ctx, config) => {
    let disposed = false;
    const prefix = config.prefix;
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
