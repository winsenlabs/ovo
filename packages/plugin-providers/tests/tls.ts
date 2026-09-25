import { readFile } from 'node:fs/promises';
import { request as httpsRequest, type Server as HttpsServer } from 'node:https';
import type { ClientRequest } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

export async function tlsFixture() {
  const [key, cert] = await Promise.all([
    readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)),
    readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url)),
  ]);
  return { key, cert };
}

export async function listen(server: HttpsServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

export async function close(server: HttpsServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** Real local HTTPS transport with test-only trust for the fixture certificate. */
export const localTlsFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const call = createServerRequest(request, body, resolve, reject);
    const abort = () => call.destroy(request.signal.reason as Error | undefined);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
    call.once('close', () => request.signal.removeEventListener('abort', abort));
    call.end(body);
  });
};

function createServerRequest(
  request: Request,
  _body: Buffer | undefined,
  resolve: (response: Response) => void,
  reject: (reason: unknown) => void,
): ClientRequest {
  const url = new URL(request.url);
  const call = httpsRequest(
    url,
    {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      rejectUnauthorized: false,
    },
    (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, String(value));
      }
      resolve(
        new Response(Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers,
        }),
      );
    },
  );
  call.once('error', reject);
  return call;
}
