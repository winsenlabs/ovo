const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function apiBaseUrl(): URL {
  const configured = process.env.OVO_API_URL ?? 'http://127.0.0.1:4000';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('OVO_API_URL must use HTTP or HTTPS');
  return url;
}

export function upstreamUrl(requestUrl: string, path: readonly string[]): URL {
  const incoming = new URL(requestUrl);
  const upstream = new URL(`/v1/${path.map(encodeURIComponent).join('/')}`, apiBaseUrl());
  upstream.search = incoming.search;
  return upstream;
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set('accept-encoding', 'identity');
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie')
      headers.append(key, value);
  });
  const getSetCookie = (upstream.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const cookies =
    getSetCookie?.call(upstream.headers) ??
    (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')!] : []);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  headers.set('cache-control', 'no-store');
  return headers;
}

export async function proxyManagementRequest(
  request: Request,
  path: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const body = hasBody ? await request.arrayBuffer() : undefined;
  try {
    const upstream = await fetcher(upstreamUrl(request.url, path), {
      method: request.method,
      headers: forwardedHeaders(request),
      body: body?.byteLength ? body : undefined,
      cache: 'no-store',
      redirect: 'manual',
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream),
    });
  } catch {
    return Response.json(
      { error: { code: 'api_unavailable', message: 'The management API is unavailable.' } },
      { status: 503 },
    );
  }
}
