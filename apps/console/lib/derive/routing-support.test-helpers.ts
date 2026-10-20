import { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { draft as fixtureDraft } from '../../e2e/fixtures/routing-data.mjs';

/** The fixture API's "Main line" draft, parsed with the contract defaults: a valid starting point. */
export function sampleDraft(): RoutingPointDraft {
  return RoutingPointDraft.parse(fixtureDraft());
}
