import type { ProfileRows } from './types.ts';
import { durableRows } from './worker.ts';

/** O1 adds the capacity signal row; durable queue and store already run here. */
export const rows: ProfileRows = (profile, env) => durableRows(profile, env);
