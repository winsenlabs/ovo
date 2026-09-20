'use client';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import type { SessionIdentity } from '../lib/api';
import { CallsView } from './operations/calls-view';
import { CampaignsView } from './operations/campaigns-view';
import { CostView } from './operations/cost-view';
import { EvaluationDatasetsView } from './operations/evaluation-datasets-view';
import { HandoffsView } from './operations/handoffs-view';
import { PerformanceView } from './operations/performance-view';
import { SuppressionsView } from './operations/suppressions-view';
import { InfrastructureView } from './operations/infrastructure-view';
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
  if (view === 'campaigns') return <CampaignsView role={role} />;
  if (view === 'suppressions') return <SuppressionsView role={role} />;
  if (view === 'handoffs') return <HandoffsView role={role} />;
  if (view === 'evaluations') return <EvaluationDatasetsView role={role} />;
  if (view === 'performance') return <PerformanceView />;
  if (view === 'costs') return <CostView role={role} />;
  if (view === 'infrastructure') return <InfrastructureView />;
  return <UnimplementedEvidence view={view} extensions={extensions} />;
}
