import { AgentReleasesFeature } from '../../../../../features/agent-releases';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentReleasesFeature agentId={id} />;
}
