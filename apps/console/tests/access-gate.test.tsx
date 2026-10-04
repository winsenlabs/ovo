import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({
  path: '/agents/new?from=home',
  cookies: [{ name: 'ovo_session', value: 'opaque' }],
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => request.cookies }),
  headers: async () => new Headers({ 'x-ovo-console-path': request.path }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@winsendotai/ovo-ui', () => ({ loadConsoleExtensions: async () => [] }));
vi.mock('../features/views', () => ({ TeamFeature: () => null }));

import ConsoleLayout from '../app/(console)/layout';
import TeamPage from '../app/(console)/team/page';
import { serverSession } from '../lib/session';

beforeEach(() => {
  request.path = '/agents/new?from=home';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('server session and route authorization', () => {
  it('forwards the HttpOnly cookie to the management session check', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: 'u1', role: 'editor' }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect((await serverSession()).identity?.role).toBe('editor');
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).cookie).toBe(
      'ovo_session=opaque',
    );
  });

  it('redirects a 401 to login with the requested route as safe next', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 401 })),
    );
    await expect(ConsoleLayout({ children: null })).rejects.toThrow(
      'REDIRECT:/login?next=%2Fagents%2Fnew%3Ffrom%3Dhome',
    );
  });

  it('redirects a 403 through the same session gate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 403 })),
    );
    await expect(ConsoleLayout({ children: null })).rejects.toThrow('REDIRECT:/login?next=');
  });

  it('fails closed when the session endpoint returns 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 503 })),
    );
    await expect(ConsoleLayout({ children: null })).rejects.toThrow(
      'Management API session check unavailable',
    );
  });

  it('fails closed when the session endpoint is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    await expect(ConsoleLayout({ children: null })).rejects.toThrow(
      'Management API session check unavailable',
    );
  });

  it('denies direct /team access to a signed-in non-admin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: 'u2', role: 'editor' })),
    );
    await expect(TeamPage()).rejects.toThrow('NOT_FOUND');
  });

  it('allows the admin team route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: 'u3', role: 'admin' })),
    );
    const page = await TeamPage();
    expect(page).toBeDefined();
  });
});
