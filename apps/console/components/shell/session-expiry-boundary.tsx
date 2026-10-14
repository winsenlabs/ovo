'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

const REDIRECT_SECONDS = 3;

/**
 * Wraps the authenticated shell. On a 401 from any API call (`apiRequest` dispatches
 * `ovo:session-ended`), it unmounts the protected content immediately and redirects to
 * `/login?next=<path>` — both happen synchronously in the event handler, not after the countdown
 * below finishes, so a test asserting the redirect does not need to wait out the cosmetic timer.
 * The card itself replaces the old bare centred sentence (brief defect #g).
 */
export function SessionExpiryBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ended, setEnded] = useState(false);
  const [remaining, setRemaining] = useState(REDIRECT_SECONDS);
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
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
  useEffect(() => {
    if (!ended) return;
    tick.current = setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(tick.current);
  }, [ended]);
  if (ended)
    return (
      <main className="session-expiry-screen">
        <section className="session-expiry-card" role="alert" aria-live="assertive">
          <div className="brand login-brand">
            <strong>ovo</strong>
          </div>
          <h1>Your session ended.</h1>
          <p className="muted">Sign in again to continue where you left off.</p>
          <button type="button" className="button primary" onClick={() => router.replace('/login')}>
            Sign in again
          </button>
          <small className="muted">Redirecting in {remaining}s…</small>
        </section>
      </main>
    );
  return children;
}
