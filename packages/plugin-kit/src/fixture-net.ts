import type { Clock, NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import {
  FixtureMismatchError,
  decodeBase64,
  describeStep,
  hostMatches,
  isRequiredStep,
  matchesBody,
  matchesHeaders,
  matchesText,
  type FixtureHttpReply,
  type FixtureScript,
  type FixtureStep,
} from './fixture-match.ts';
import { FixtureSocket, type ScriptRun } from './fixture-socket.ts';

export {
  FixtureMismatchError,
  describeStep,
  matchesWhere,
  type FixtureHttpReply,
  type FixtureScript,
  type FixtureStep,
} from './fixture-match.ts';

export interface FixtureNetLogEntry {
  host: string;
  kind: 'http' | 'ws-open' | 'ws-in' | 'ws-out' | 'ws-close';
  url?: string;
  data?: string | Uint8Array;
  atMs: number;
}

export interface FixtureNet extends NetPort {
  readonly log: readonly FixtureNetLogEntry[];
  readonly mismatches: readonly FixtureMismatchError[];
  readonly listenerErrors: readonly unknown[];
  /** Required steps not yet consumed (delays and repeat steps are optional). */
  pending(): { host: string; source: string; step: number; description: string }[];
  /** Throws `FixtureMismatchError` on any mismatch, listener error or unconsumed required step. */
  assertComplete(): void;
  /** `assertComplete` under another name, so a teardown hook cannot quietly skip the check. */
  close(): void;
  /** `using net = createFixtureNet(...)` asserts completeness when the scope ends. */
  [Symbol.dispose](): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function secure(raw: string, protocol: string): URL {
  const url = new URL(raw);
  if (url.protocol !== protocol)
    throw new TypeError(`FixtureNet accepts only https: and wss: URLs (got ${url.protocol})`);
  return url;
}

function replyBody(reply: FixtureHttpReply): BodyInit | null {
  if ([204, 205, 304].includes(reply.status)) return null;
  if (reply.chunks) {
    const chunks = reply.chunks.map((chunk) =>
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : decodeBase64(chunk.base64),
    );
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }
  if (reply.bodyBase64 !== undefined) return decodeBase64(reply.bodyBase64);
  return reply.body ?? '';
}

async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return new Response(body).text();
}

/** Header names are case-insensitive on the wire, so both sides are compared in lower case. */
function lowercased(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * An in-memory `NetPort` that replays documented wire scripts strictly (§2.3). Scripts are keyed by
 * `script.host`; each is a strict sequence, and scripts for one host may interleave.
 */
export function createFixtureNet(
  scripts: readonly FixtureScript[],
  options: { clock?: Clock } = {},
): FixtureNet {
  const clock = options.clock ?? realClock;
  const runs: (ScriptRun & { script: FixtureScript })[] = scripts.map((script) => ({
    script,
    host: script.host,
    source: script.source,
    steps: script.steps,
    index: 0,
  }));
  const log: FixtureNetLogEntry[] = [];
  const mismatches: FixtureMismatchError[] = [];
  const listenerErrors: unknown[] = [];
  const record = (entry: Omit<FixtureNetLogEntry, 'atMs'>) =>
    log.push({ ...entry, atMs: clock.now() });

  const headOf = (run: ScriptRun): { step?: FixtureStep; index: number; delay: number } => {
    let index = run.index;
    let delay = 0;
    for (let step = run.steps[index]; step && 'delayMs' in step; step = run.steps[++index])
      delay += step.delayMs;
    return { step: run.steps[index], index, delay };
  };

  const fail = (host: string, candidates: ScriptRun[], actual: string) => {
    const expected = candidates.length
      ? candidates.map((run) => describeStep(headOf(run).step, headOf(run).index)).join(' | ')
      : 'no script for this host';
    const error = new FixtureMismatchError(host, expected, actual, candidates[0]?.source);
    mismatches.push(error);
    return error;
  };

  return {
    log,
    mismatches,
    listenerErrors,
    async fetch(raw, init = {}) {
      init.signal?.throwIfAborted();
      const url = secure(raw, 'https:');
      const method = (init.method ?? 'GET').toUpperCase();
      const body = await bodyText(init.body);
      const headers = lowercased(init.headers);
      const candidates = runs.filter((run) => hostMatches(run.script, url));
      for (const run of candidates) {
        const { step, index, delay } = headOf(run);
        if (!step || !('expect' in step) || step.expect !== 'http') continue;
        if (step.method.toUpperCase() !== method || !matchesText(step.url, url.href)) continue;
        if (!matchesHeaders(step.headers, headers)) continue;
        if (!matchesBody(step, body)) continue;
        run.index = index + 1;
        record({ host: url.hostname, kind: 'http', url: url.href, data: body });
        if (delay > 0) {
          await new Promise<void>((resolve, reject) => {
            const cancel = clock.setTimeout(resolve, delay);
            init.signal?.addEventListener('abort', () => {
              cancel();
              reject(new DOMException('FixtureNet request aborted', 'AbortError'));
            });
          });
        }
        init.signal?.throwIfAborted();
        const reply = step.reply as FixtureHttpReply;
        return new Response(replyBody(reply), { status: reply.status, headers: reply.headers });
      }
      throw fail(url.hostname, candidates, `${method} ${url.href}`);
    },
    websocket(raw, opts = {}): WebSocketLike {
      const url = secure(raw, 'wss:');
      const headers = lowercased(opts.headers);
      const candidates = runs.filter((run) => hostMatches(run.script, url));
      for (const run of candidates) {
        const { step, index } = headOf(run);
        if (!step || !('expect' in step) || step.expect !== 'ws-open') continue;
        if (!matchesText(step.url, url.href)) continue;
        if (!matchesHeaders(step.headers, headers)) continue;
        run.index = index + 1;
        record({ host: url.hostname, kind: 'ws-open', url: url.href });
        return new FixtureSocket(run, {
          clock,
          log: (kind, data) => record({ host: url.hostname, kind, data }),
          mismatch: (error) => mismatches.push(error),
          listenerError: (error) => listenerErrors.push(error),
        });
      }
      throw fail(url.hostname, candidates, `ws-open ${url.href}`);
    },
    pending() {
      const out: ReturnType<FixtureNet['pending']> = [];
      for (const run of runs)
        run.steps.forEach((step, index) => {
          if (index < run.index || !isRequiredStep(step)) return;
          out.push({
            host: run.host,
            source: run.source,
            step: index,
            description: describeStep(step, index),
          });
        });
      return out;
    },
    assertComplete() {
      const problems = [
        ...mismatches.map((error) => error.message),
        ...listenerErrors.map((error) => `listener error: ${String(error)}`),
        ...this.pending().map((p) => `${p.host}: unconsumed ${p.description} (${p.source})`),
      ];
      if (problems.length) throw FixtureMismatchError.incomplete(problems);
    },
    close() {
      this.assertComplete();
    },
    [Symbol.dispose]() {
      this.assertComplete();
    },
  };
}
