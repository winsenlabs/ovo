export interface SseEvent {
  /** Defaults to 'message', as in the EventSource spec. */
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

async function* chunksOf(source: ByteSource): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Splits a UTF-8 byte stream into lines on CRLF, LF or CR. A line longer than `maxLineBytes` throws. */
export async function* sseLines(
  source: ByteSource,
  options: { maxLineBytes?: number } = {},
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const max = options.maxLineBytes ?? 1_048_576;
  let buffer = '';
  let pendingCr = false;
  for await (const chunk of chunksOf(source)) {
    buffer += decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const char = buffer[i];
      if (pendingCr) {
        pendingCr = false;
        if (char === '\n' && i === start) {
          start = i + 1;
          continue;
        }
      }
      if (char === '\n' || char === '\r') {
        yield buffer.slice(start, i);
        start = i + 1;
        if (char === '\r') pendingCr = true;
      }
    }
    buffer = buffer.slice(start);
    if (buffer.length > max) throw new RangeError('SSE line exceeded the configured limit');
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

/** Parses `text/event-stream` per the HTML spec: `data` lines join with '\n'; blank lines dispatch. */
export async function* readSse(
  source: ByteSource,
  options: { maxLineBytes?: number } = {},
): AsyncIterable<SseEvent> {
  let data: string[] = [];
  let event = '';
  let id: string | undefined;
  let retry: number | undefined;
  for await (const line of sseLines(source, options)) {
    if (line === '') {
      if (data.length) yield { event: event || 'message', data: data.join('\n'), id, retry };
      data = [];
      event = '';
      retry = undefined;
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }
  if (data.length) yield { event: event || 'message', data: data.join('\n'), id, retry };
}

/** The SSE reader wave-2 providers use (alias of `readSse`). */
export const sseReader = readSse;
