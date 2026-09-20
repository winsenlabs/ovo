'use client';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import type { SessionIdentity } from '../lib/api';
import { CallsView } from './operations/calls-view';
import { TestAndEvaluationView } from './operations/evaluations-view';
import { UnimplementedEvidence } from './operations/unavailable-view';
export function Operations({
  view,
  extensions,
  role,
}: {
  view: string;
  extensions: readonly ConsoleExtension[];
  role: SessionIdentity['role'];
}) {
  if (view === 'calls') return <CallsView role={role} />;
  if (view === 'evaluations') return <TestAndEvaluationView evaluationsOnly />;
  return <UnimplementedEvidence view={view} extensions={extensions} />;
}
