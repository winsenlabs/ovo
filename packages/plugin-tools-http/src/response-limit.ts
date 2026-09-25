import { ExecutionPolicyError, ToolInvocationError } from '@winsendotai/ovo-plugin-tools';

export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export class ResponseBodyLimitError extends ToolInvocationError {
  constructor(readonly maxBytes: number) {
    super(`Tool response exceeded the ${maxBytes}-byte limit`, 'unknown');
  }
}

export function validateResponseByteLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new ExecutionPolicyError('Tool response byte limit must be a positive safe integer');
  }
  return limit;
}

async function rejectDeclaredOversize(response: Response, maxBytes: number): Promise<void> {
  const contentLength = response.headers.get('content-length')?.trim();
  if (!contentLength || !/^\d+$/.test(contentLength)) return;
  if (BigInt(contentLength) <= BigInt(maxBytes)) return;
  try {
    await response.body?.cancel();
  } catch {
    // The bounded error is authoritative even if the transport cannot cancel cleanly.
  }
  throw new ResponseBodyLimitError(maxBytes);
}

function boundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytesRead = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        bytesRead += chunk.value.byteLength;
        if (bytesRead > maxBytes) {
          const error = new ResponseBodyLimitError(maxBytes);
          try {
            await reader.cancel(error);
          } catch {
            // Preserve the size-limit failure rather than a secondary cancel error.
          }
          release();
          controller.error(error);
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

export async function limitResponseBody(response: Response, maxBytes: number): Promise<Response> {
  await rejectDeclaredOversize(response, maxBytes);
  if (!response.body) return response;
  return new Response(boundedBody(response.body, maxBytes), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
