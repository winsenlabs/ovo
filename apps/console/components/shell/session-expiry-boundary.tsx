'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

export function SessionExpiryBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    const sessionEnded = () => {
      setEnded(true);
      const path = `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?next=${encodeURIComponent(path)}`);
      router.refresh();
    };
    window.addEventListener('ovo:session-ended', sessionEnded);
    return () => window.removeEventListener('ovo:session-ended', sessionEnded);
  }, [router]);
  if (ended)
    return (
      <main className="centered" role="alert">
        Your session ended. Sign in again to continue.
      </main>
    );
  return children;
}
