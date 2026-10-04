import { notFound } from 'next/navigation';
import { serverSession } from '../../../lib/session';
import { TeamFeature } from '../../../features/views';
export default async function Page() {
  const session = await serverSession();
  if (session.identity?.role !== 'admin') notFound();
  return <TeamFeature />;
}
