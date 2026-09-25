import { consoleExtensions } from '../../layout';
import { AgentsFeature } from '../../../../features/agents';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentsFeature extensions={await consoleExtensions} preferredAgentId={id} />;
}
