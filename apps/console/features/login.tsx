'use client';
import { useRouter } from 'next/navigation';
import { Login } from '../components/auth/login';
export function LoginFeature({ next }: { next?: string }) {
  const router = useRouter();
  const destination = next?.startsWith('/') && !next.startsWith('//') ? next : '/agents';
  return <Login onAuthenticated={() => { router.replace(destination); router.refresh(); }} />;
}
