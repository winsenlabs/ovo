// vitest setupFiles: report every runtime plugin violation (§3.7) as one JSON line to the log that
// scripts/vitest-global-setup.ts created. The runtime never writes files itself.
import { appendFileSync } from 'node:fs';
import { inject } from 'vitest';
import { setViolationSink } from '../packages/runtime/src/enforcement.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    ovoViolationLog: string;
  }
}

const log = process.env.OVO_PLUGIN_VIOLATION_LOG ?? inject('ovoViolationLog');
if (log)
  setViolationSink((violation) => {
    const { pluginId, kind, key, mode } = violation;
    appendFileSync(log, `${JSON.stringify({ pluginId, kind, key, mode })}\n`);
  });
