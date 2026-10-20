import { ifMatch } from '../api';

/** A JSON request: the method, an optional body, and an optional version sent as `If-Match`. */
export const json = (method: string, body?: unknown, version?: number): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
  headers: version === undefined ? undefined : { 'if-match': ifMatch(String(version)) },
});
