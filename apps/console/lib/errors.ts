import { ApiError } from './api';
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session ended. Sign in again.';
    if (error.status === 403) return 'You do not have access to this action.';
    if (error.status === 409) return error.message || 'This record changed. Refresh and try again.';
    if (error.status === 422) return error.message || 'Check the highlighted fields.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'The request could not be completed.';
}
