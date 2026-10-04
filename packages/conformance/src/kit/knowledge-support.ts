import type { KnowledgePort } from '@winsendotai/ovo-contracts';

/** What the kit asks a provider package to build, loaded with exactly the corpus the kit names. */
export type KnowledgeFactory = (env: {
  /** The corpus the plugin must make searchable, verbatim. */
  sources: readonly KnowledgeKitSource[];
}) => KnowledgePort | Promise<KnowledgePort>;

export interface KnowledgeKitDocument {
  id: string;
  text: string;
  title?: string;
  citation?: string;
}

export interface KnowledgeKitSource {
  id: string;
  documents: readonly KnowledgeKitDocument[];
}

export interface KnowledgeKitOptions {
  /** A backend whose score is not comparable across queries must say so and skip that check. */
  comparableScores?: boolean;
}

export interface KnowledgeKitContext {
  factory: KnowledgeFactory;
  options: KnowledgeKitOptions;
}

let runs = 0;
/** A per-run token, so no check can pass on a term the provider happens to special-case. */
export const runToken = (): string => `tok${(++runs).toString(36)}x`;

/**
 * Two sources with disjoint vocabularies plus one shared rare term. Every check phrases its query in
 * terms built from `token`, so nothing here can be satisfied by a hardcoded fixture.
 */
export function corpusOf(token: string): KnowledgeKitSource[] {
  return [
    {
      id: 'policy',
      documents: [
        {
          id: 'refunds',
          title: `Refund policy ${token}`,
          citation: `Refund policy ${token}, clause 4`,
          text: [
            `A refund alpha${token} is issued within seven working days of an approved request.`,
            '',
            `A chargeback beta${token} is handled by the disputes team and never by this policy.`,
          ].join('\n'),
        },
        {
          id: 'arrears',
          title: `Arrears policy ${token}`,
          text: `An account in arrears gamma${token} accrues interest from the due date. shared${token}`,
        },
      ],
    },
    {
      id: 'pricing',
      documents: [
        {
          id: 'plans',
          text: `The standard plan delta${token} costs one amount and the premium plan another. shared${token}`,
        },
      ],
    },
  ];
}

export const anySignal = (): AbortSignal => new AbortController().signal;
