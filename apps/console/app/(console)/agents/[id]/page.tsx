import { AgentOverviewFeature } from '../../../../features/agent-overview';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentOverviewFeature agentId={id} />;
}
