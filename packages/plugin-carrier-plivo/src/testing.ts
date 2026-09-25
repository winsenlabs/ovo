import type { NetFixtureScript, NetPort } from '@winsendotai/ovo-contracts';
import { plivoControl } from './control.ts';
import { plivoIngress } from './plugin.ts';

export const PLIVO_FIXTURE_HOST = 'api.plivo.com';
export const plivoForTest = (net: NetPort) => ({
  control: plivoControl(net),
  ingress: plivoIngress,
});
export const plugins = [];
/** A documented request_uuid-only dial response for catalog fixture consumers. */
export const fixtures: Record<string, NetFixtureScript[]> = {
  '@winsendotai/ovo-carrier-plivo': [
    {
      host: PLIVO_FIXTURE_HOST,
      source: 'https://www.plivo.com/docs/voice/api/calls',
      retrieved: '2026-09-26',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: 'https://api.plivo.com/v1/Account/AUTH1/Call/',
          headers: { authorization: /^Basic / },
          body: 'json',
          reply: { status: 201, body: '{"request_uuid":"request-1"}' },
        },
      ],
    },
  ],
};
// FixtureTemplateInput has speech turns, not carrier call controls.
export const fixtureTemplates = {};
