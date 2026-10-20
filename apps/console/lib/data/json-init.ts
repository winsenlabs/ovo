import { ifMatch } from '../api';

/** A JSON request: the method, an optional body, and an optional version sent as `If-Match`. */
export function json(method: string, body?: unknown, version?: number): RequestInit {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (version !== undefined) init.headers = { 'if-match': ifMatch(String(version)) };
  return init;
}
