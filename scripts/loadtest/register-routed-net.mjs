// `node --import tsx --import ./scripts/loadtest/register-routed-net.mjs …`: every `ovo.net` the
// process creates sends provider hosts to the loopback fakes named in OVO_LOADTEST_ROUTES.
// plugin-kit's index resolves to routed-plugin-kit.ts, which re-exports it with a routed
// createNodeNet; the wrapper's own import reaches the real index.
import { registerHooks } from 'node:module';

const WRAPPER = new URL('./routed-plugin-kit.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.endsWith('/packages/plugin-kit/src/index.ts') && context.parentURL !== WRAPPER)
      return { ...resolved, url: WRAPPER, shortCircuit: true };
    return resolved;
  },
});
