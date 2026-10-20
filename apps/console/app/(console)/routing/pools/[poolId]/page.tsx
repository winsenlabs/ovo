import { PoolFeature } from '../../../../../features/routing/pools/pool-feature';

export default async function Page({ params }: { params: Promise<{ poolId: string }> }) {
  const { poolId } = await params;
  return <PoolFeature poolId={poolId} />;
}
