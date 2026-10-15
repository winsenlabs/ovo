import type { FixtureTemplate } from '@winsendotai/ovo-contracts';

/** Fixture calls use ovo-sip/1 frames directly; the carrier makes no vendor REST call. */
export const fixtureTemplates: Record<string, FixtureTemplate> = {
  '@winsendotai/ovo-carrier-tcn': () => [],
};
