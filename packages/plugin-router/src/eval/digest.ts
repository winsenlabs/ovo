import { createHash } from 'node:crypto';
import { canonicalJson } from '@winsendotai/ovo-contracts';
import type { RoutingEvalCase } from '../wire/index.ts';

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** sha256 of the canonical JSON of the parsed cases, in order: the corpus a scorecard was measured on. */
export const routingCorpusDigest = (cases: readonly RoutingEvalCase[]): string => sha256(cases);

/** sha256 of the canonical JSON of a routing snapshot, as a release digest is made. */
export const routingSnapshotDigest = (snapshot: unknown): string => sha256(snapshot);
