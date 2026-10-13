/**
 * Host capability `ovo.sip-trunk.control` (worker only). The transport from a SIP carrier plugin to
 * the sip-gateway control API: plugins cannot reach it through `ctx.net`, which is https/wss only
 * and refuses private addresses, so the host composes this client instead.
 */
export interface SipTrunkControlClient {
  request(input: {
    method: 'GET' | 'POST';
    /** e.g. '/v1/calls'. */
    path: string;
    query?: Record<string, string>;
    /** JSON-serialisable. */
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown }>;
}

/**
 * Host capability `ovo.sip-trunk.verifier` (media-gateway only). Verifies the ovo-sip/1 request
 * signature the sip-gateway puts on every internal HTTP request and media upgrade.
 */
export interface SipRequestVerifier {
  verify(input: {
    method: 'GET' | 'POST';
    externalUrl: string;
    headers: Readonly<Record<string, string | undefined>>;
    body: Uint8Array;
  }): Promise<boolean>;
}
