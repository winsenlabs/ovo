import type { CallOutcomeSummary } from '@winsendotai/ovo-contracts';
import type { AgentDraft, CallSummary } from '../../../lib/api';

/** The API attaches each call's recorded outcome (AGT-8), or null when none was recorded — the
 * same shape `features/calls-index.tsx` reads, kept local here since Home derives from the same
 * `/calls` response rather than a new endpoint (brief §4 "API gaps to respect"). */
export type HomeCall = CallSummary & { outcome?: CallOutcomeSummary | null };

export type HomeAgent = AgentDraft;

/** Minimal local shapes for the fixture's `/callbacks`, `/operations/compliance/*` and
 * `/credentials` rows — only the fields Home's "needs attention" list reads. */
export interface HomeCallback {
  id: string;
  dueAt: string;
  status: string;
  phone?: string;
  callId?: string;
}
export interface HomeComplaint {
  id: string;
  status: string;
  overdue?: 'ack' | 'resolve';
  receivedAt: string;
  summary?: string;
}
export interface HomeRatio {
  fromNumber: string;
  attempts: number;
  abandonedRatio: number;
  level: 'ok' | 'warn' | 'stop';
}
export interface HomeCredential {
  id: string;
  label: string;
  expiresAt?: string;
  status?: string;
}

/** A loose shape every `useResource`/`useHomeX` result structurally satisfies (it also carries
 * `key`/`refresh`, which the sections below never read) — avoids coupling every section's props
 * to `use-resource.ts`'s exact return type. */
export type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: string };

export type AttentionTone = 'warn' | 'danger';
export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  text: string;
  href: string;
}
