import { LoginFeature } from '../../features/login';
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <LoginFeature next={next} />;
}
