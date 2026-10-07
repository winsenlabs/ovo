import { describe, expect, it } from 'vitest';
import { renderServiceEnv } from '../../../tests/e2e/support/compose-env.ts';
import { goLiveComposeVariables } from '../../../tests/e2e/support/deployment-env.ts';

const { LIVE_SERVICE_FLAGS } = (await import('../live-checks.mjs' as string)) as {
  LIVE_SERVICE_FLAGS: Record<string, Record<string, string>>;
};

describe('verify-live and compose agree on the live flags', () => {
  // 2026-10-07: verify-live failed live-flags with "dispatcher OVO_LIVE_DIAL_ENABLED=<unset>" on a
  // correctly switched stack, because compose never handed the flag to the dispatcher.
  it('hands every service the live flags verify-live checks, after ovo-live.sh on', () => {
    const variables = goLiveComposeVariables('postgresql://ovo:secret@postgres:5432/ovo');
    const wrong: string[] = [];
    for (const service of ['api', 'gateway', 'dispatcher', 'worker-1', 'worker-2']) {
      const rendered = renderServiceEnv(service, variables);
      const expected = LIVE_SERVICE_FLAGS[service.startsWith('worker-') ? 'worker' : service]!;
      for (const [name, value] of Object.entries(expected))
        if (rendered[name] !== value)
          wrong.push(`${service} ${name}=${rendered[name] ?? '<unset>'}`);
    }
    expect(wrong).toEqual([]);
  });
});
