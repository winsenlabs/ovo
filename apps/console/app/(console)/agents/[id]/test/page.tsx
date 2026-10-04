import { TestConsoleFeature } from '../../../../../features/test-console';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TestConsoleFeature agentId={id} />;
}
