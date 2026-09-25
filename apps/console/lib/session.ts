import { cookies } from 'next/headers';
import { apiBaseUrl } from './gateway';
import type { SessionIdentity } from './api';

export async function serverSession(): Promise<{ status: number; identity?: SessionIdentity }> {
  const cookieStore = await cookies();
  const header = cookieStore.getAll().map(({ name, value }) => `${name}=${value}`).join('; ');
  try {
    const response = await fetch(new URL('/v1/auth/me', apiBaseUrl()), {
      headers: { cookie: header, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return { status: response.status };
    return { status: 200, identity: await response.json() as SessionIdentity };
  } catch { return { status: 503 }; }
}
