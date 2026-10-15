import type { RoutingIssueCode } from '../routing/issue-codes.ts';

/** The R3 subset of `RoutingIssueCode`: every code a human queue raises on a draft or at publish. */
export type QueueIssueCode = Extract<RoutingIssueCode, `routing_queue_${string}`>;
