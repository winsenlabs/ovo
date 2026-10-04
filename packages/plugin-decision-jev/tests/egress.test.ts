import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { expect, it } from 'vitest';
import { withEgressSentinel } from '../../conformance/src/drivers/egress-sentinel.ts';
import { resolveBinding } from '../src/binding.ts';
import { jevDecision } from '../src/decide.ts';
import { CHOICE_BODY, jevScript, jevStep } from '../src/testing.ts';
import { LABEL, choiceRequest } from './requests.ts';

it('reaches ONLY the configured host, and nothing bypasses the NetPort', async () => {
  await withEgressSentinel(async (sentinel) => {
    const net = createFixtureNet([jevScript(jevStep({ body: CHOICE_BODY }))]);
    const port = jevDecision(net, 'fixture-key', resolveBinding({ calibrationLabel: LABEL }));
    await port.decide(choiceRequest, { signal: AbortSignal.timeout(5000) });

    expect([...new Set(net.log.map((entry) => entry.host))]).toEqual(['api.typesafe.ai']);
    // The manifest's egressHosts is the same single host, so the runtime filter admits nothing else.
    expect(sentinel.attempts).toEqual([]);
    net.assertComplete();
  });
});

it('a request to any other host is a FixtureNet mismatch, not a silent success', async () => {
  await withEgressSentinel(async (sentinel) => {
    const net = createFixtureNet([jevScript(jevStep({ body: CHOICE_BODY }))]);
    await expect(
      net.fetch('https://api.openai.com/v1/responses', { method: 'POST' }),
    ).rejects.toThrow(/no script for this host/);
    expect(sentinel.attempts).toEqual([]);
  });
});
