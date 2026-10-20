import { DesignerFeature } from '../../../../../features/routing/designer/designer-feature';

export default async function Page({ params }: { params: Promise<{ pointId: string }> }) {
  const { pointId } = await params;
  return <DesignerFeature pointId={pointId} />;
}
