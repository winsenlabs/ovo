import type { AudioFormat } from './audio.ts';

/** Host-injected network. Provider, carrier and engine plugins MUST use it, never node:net/tls/http/https or `ws`. */
export interface NetPort {
  fetch(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<Response>;
  websocket(
    url: string,
    opts?: { headers?: Record<string, string>; protocols?: string[] },
  ): WebSocketLike;
}

/** The subset of a WebSocket every plugin may rely on. `on` returns an unsubscribe function. */
export interface WebSocketLike {
  /** 0 connecting, 1 open, 2 closing, 3 closed. */
  readonly readyState: 0 | 1 | 2 | 3;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', fn: () => void): () => void;
  on(event: 'message', fn: (data: string | Uint8Array, isBinary: boolean) => void): () => void;
  on(event: 'close', fn: (code: number, reason: string) => void): () => void;
  on(event: 'error', fn: (error: Error) => void): () => void;
}

export type NetFixtureStep =
  | {
      expect: 'http';
      method: string;
      url: string | RegExp;
      /** Request headers the call must carry; matched case-insensitively, a subset of the real ones. */
      headers?: Record<string, string | RegExp>;
      body?: 'json' | 'form' | 'any';
      where?: Record<string, unknown>;
      reply: { status: number; headers?: Record<string, string>; body?: string };
    }
  | { expect: 'ws-open'; url: string | RegExp; headers?: Record<string, string | RegExp> }
  | {
      expect: 'ws-send';
      match: 'json' | 'binary' | 'any';
      where?: Record<string, unknown>;
      repeat?: 'until-next';
    }
  | { send: string | { base64: string } }
  | { close: { code: number; reason?: string } }
  | { delayMs: number };

export interface NetFixtureScript {
  host: string;
  /** Documentation URL the frames were taken from. */
  source: string;
  /** ISO date the documentation was retrieved. */
  retrieved: string;
  steps: NetFixtureStep[];
}

/** A provider package can turn a caller script into its own documented wire messages (§12). */
export interface FixtureTemplateInput {
  format: AudioFormat;
  language: string;
  sessionId: string;
  turns: readonly { atMs: number; say?: string; dtmf?: string; silenceMs?: number }[];
  /** TTS templates. */
  agentTexts?: readonly string[];
  /** LLM templates. */
  tools?: readonly {
    id: string;
    inputSchema: Record<string, unknown>;
    effect: 'read' | 'write';
  }[];
}

export type FixtureTemplate = (input: FixtureTemplateInput) => NetFixtureScript[];
