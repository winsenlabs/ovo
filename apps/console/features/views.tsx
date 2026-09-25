'use client';
import { useSession } from '../components/shell/session-provider';
import { Integrations } from '../components/integrations';
import { CallsView } from '../components/operations/calls-view';
import { CampaignsView } from '../components/operations/campaigns-view';
import { SuppressionsView } from '../components/operations/suppressions-view';
import { HandoffsView } from '../components/operations/handoffs-view';
import { InboundRoutes } from '../components/operations/inbound-routes';
import { EvaluationDatasetsView } from '../components/operations/evaluation-datasets-view';
import { CostView } from '../components/operations/cost-view';
import { PerformanceView } from '../components/operations/performance-view';
import { InfrastructureView } from '../components/operations/infrastructure-view';
import { TeamView } from '../components/team/team-view';
import { AccountView } from '../components/team/account-view';
export function ProvidersFeature() { const identity = useSession(); return <Integrations identity={identity} initialTab="providers" />; }
export function ToolsFeature() { const identity = useSession(); return <Integrations identity={identity} initialTab="tools" />; }
export function CallsFeature() { const identity = useSession(); return <CallsView role={identity.role} />; }
export function CampaignsFeature() { const identity = useSession(); return <CampaignsView role={identity.role} />; }
export function SuppressionsFeature() { const identity = useSession(); return <SuppressionsView role={identity.role} />; }
export function HandoffsFeature() { const identity = useSession(); return <HandoffsView role={identity.role} />; }
export function InboundFeature() { const identity = useSession(); return <InboundRoutes role={identity.role} />; }
export function EvaluationsFeature() { const identity = useSession(); return <EvaluationDatasetsView role={identity.role} />; }
export function CostsFeature() { const identity = useSession(); return <CostView role={identity.role} />; }
export function PerformanceFeature() { return <PerformanceView />; }
export function InfrastructureFeature() { return <InfrastructureView />; }
export function TeamFeature() { const identity = useSession(); return <TeamView identity={identity} onSessionRevoked={() => location.assign('/login')} />; }
export function AccountFeature() { const identity = useSession(); return <AccountView identity={identity} onSessionRevoked={() => location.assign('/login')} />; }
