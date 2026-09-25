import { proxyManagementRequest } from '../../../../lib/gateway';

type RouteContext = { params: Promise<{ path: string[] }> };

async function handler(request: Request, context: RouteContext) {
  const { path } = await context.params;
  return proxyManagementRequest(request, path);
}

export const dynamic = 'force-dynamic';
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
