import { AgentPluginsFeature } from '../../../../../features/agent-plugins';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentPluginsFeature agentId={id} />;
}
