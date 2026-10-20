#!/usr/bin/env node
// Rebuilds the `route` of routed calls recorded before Wave 18 from their session events, so the
// calls filter and the routing stats can see their fallbacks, re-asks, turns and route time.
// A dry run unless --apply is given. Prints one JSON line per call that would change (ids and
// routing fields only) and a summary. Usage (needs the control database URL in the environment):
//
//   node scripts/ops/refold-route-outcomes.mjs --workspace <id> [--apply] [--limit 500] [--since <iso>]
//
// The logic is TypeScript (refold-route-outcomes-main.ts) and runs through tsx, like the other
// repository scripts that use workspace code.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('./refold-route-outcomes-main.ts');
process.exitCode = await main({ argv: process.argv.slice(2), env: process.env });
