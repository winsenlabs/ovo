import { consoleExtensions } from '../../../layout';
import { AgentConfigureFeature } from '../../../../../features/agent-configure';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentConfigureFeature agentId={id} extensions={await consoleExtensions} />;
}
