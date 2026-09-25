'use client';
import { useRouter } from 'next/navigation';
import { Login } from '../components/auth/login';
export function safeReturnPath(next?: string): string {
  if (!next || !next.startsWith('/') || /\\|%5c/i.test(next)) return '/agents';
  const base = 'https://console.invalid';
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return '/agents';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/agents'; }
}
export function LoginFeature({ next }: { next?: string }) {
  const router = useRouter();
  const destination = safeReturnPath(next);
  return <Login onAuthenticated={() => { router.replace(destination); router.refresh(); }} />;
}
